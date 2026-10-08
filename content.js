(() => {
  'use strict';

  if (window.__PIO_AUTO_HELPER_LOADED__) return;
  window.__PIO_AUTO_HELPER_LOADED__ = true;

  const DEFAULTS = {
    enabled: true,
    autoCatch: true,
    autoSwitchBalls: true,
    warnLowBalls: true,
    autoReconnect: true,
    closePopups: true,
    autoReload: true,
    showHUD: true,
    showQuickToggle: true,
    preventDiscard: true,
    cooldownMs: 2050,
    lowBallThreshold: 20,
    reloadAfterDisconnectMs: 12000
  };

  // Leve por padrão: procura os painéis uma vez e trabalha em cima das referências.
  const PERF = Object.freeze({
    catchPollMs: 350,
    inventoryPollMs: 1200,
    discoveryMs: 3500,
    utilityMs: 4000,
    watchdogMs: 7000,
    bodyProbeMs: 25000,
    hudClockMs: 2000,
    mutationDebounceMs: 140,
    maxMutationNodes: 50
  });

  const interactiveSelector = 'button,[role="button"],a,input[type="button"],input[type="submit"],[tabindex]';

  let config = { ...DEFAULTS };
  let observer = null;
  let mutationTimer = null;
  let pendingMutationNodes = [];
  let lastBodyDisconnectProbe = 0;
  let cachedDisconnect = false;

  const cache = {
    proximityRoot: null,
    captureRow: null,
    automationRoot: null,
    discoveryCount: 0
  };

  const state = {
    startedAt: Date.now(),
    lastCatch: 0,
    catchBusy: false,
    sessionThrows: 0,
    sessionReconnects: 0,
    sessionPopups: 0,
    disconnectedAt: 0,
    lastReconnect: 0,
    lastAction: 'Aguardando',
    allCaptures: 0,
    confirmedCaptures: 0,
    lastCapturedPokemon: '',
    pendingTargetName: '',
    pendingTargetAt: 0,
    lastBallSwitch: 0,
    ballSnapshot: null
  };

  let hud = null;
  let hudTitle = null;
  let quickToggle = null;
  let toastHost = null;
  let hudPosition = null;
  const hudRefs = Object.create(null);
  const warningMemory = new Map();

  function norm(value) {
    return String(value ?? '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  function fastText(el) {
    if (!el) return '';
    return String(el.textContent || el.value || '').replace(/\s+/g, ' ').trim();
  }

  function isVisibleFast(el) {
    if (!el || !el.isConnected || el.hidden) return false;
    if (el.getAttribute?.('aria-hidden') === 'true') return false;
    return !!(el.offsetWidth || el.offsetHeight || el.getClientRects?.().length);
  }

  function isEnabled(el) {
    if (!el) return false;
    if (el.disabled || el.hasAttribute?.('disabled')) return false;
    if (el.getAttribute?.('aria-disabled') === 'true') return false;
    if (el.classList?.contains('disabled')) return false;
    return true;
  }

  function dispatchClick(el) {
    if (!el) return;
    try { el.dispatchEvent(new PointerEvent('pointerdown', { bubbles:true, cancelable:true, pointerType:'mouse' })); } catch (_) {}
    try { el.dispatchEvent(new MouseEvent('mousedown', { bubbles:true, cancelable:true, view:window })); } catch (_) {}
    try { el.dispatchEvent(new PointerEvent('pointerup', { bubbles:true, cancelable:true, pointerType:'mouse' })); } catch (_) {}
    try { el.dispatchEvent(new MouseEvent('mouseup', { bubbles:true, cancelable:true, view:window })); } catch (_) {}
    try { el.click(); } catch (_) {}
  }

  function setAction(action) {
    if (state.lastAction === action) return;
    state.lastAction = action;
    updateHUDState();
    try { chrome.storage.local.set({ lastAction:action, lastActionAt:Date.now() }); } catch (_) {}
  }

  async function bumpStats(key) {
    try {
      const current = await chrome.storage.local.get({ throws:0, catches:0, reconnects:0, popups:0 });
      const patch = { lastAction:state.lastAction, lastActionAt:Date.now() };
      patch[key] = Number(current[key] || 0) + 1;
      await chrome.storage.local.set(patch);
    } catch (_) {}
  }

  function ownUi(el) {
    return !!el?.closest?.('#pio-auto-helper-hud,#pio-auto-helper-quick-toggle,#pio-auto-helper-toasts');
  }

  function isChatNode(el) {
    return !!el?.closest?.('[class*="chat" i],[id*="chat" i],[data-testid*="chat" i]');
  }

  function compactMeta(el) {
    if (!el) return '';
    const parts = [];
    const add = value => {
      const v = String(value || '').trim();
      if (v && v.length <= 220) parts.push(v);
    };
    add(fastText(el));
    add(el.id);
    add(el.className?.toString());
    add(el.getAttribute?.('aria-label'));
    add(el.getAttribute?.('title'));
    add(el.getAttribute?.('data-action'));
    add(el.getAttribute?.('data-testid'));
    add(el.getAttribute?.('data-name'));
    add(el.getAttribute?.('data-ball'));
    add(el.getAttribute?.('alt'));
    add(el.getAttribute?.('src'));
    const img = el.matches?.('img') ? el : el.querySelector?.('img');
    if (img) {
      add(img.getAttribute?.('alt'));
      add(img.getAttribute?.('title'));
      add(img.getAttribute?.('src'));
      add(img.className?.toString());
    }
    return norm(parts.join(' '));
  }

  // ---------------------------------------------------------------------------
  // Descoberta dos painéis do PokeIdle.io
  // ---------------------------------------------------------------------------

  function findSmallHeading(needle) {
    const target = norm(needle);
    let nodes;
    try { nodes = document.querySelectorAll('h1,h2,h3,h4,h5,strong,b,span,p,div'); }
    catch (_) { return null; }

    let checked = 0;
    for (const el of nodes) {
      if (++checked > 2600) break;
      if (ownUi(el)) continue;
      const raw = fastText(el);
      if (!raw || raw.length > 110) continue;
      const n = norm(raw);
      if (n === target || n.startsWith(target) || n.includes(target)) return el;
    }
    return null;
  }

  function panelFromHeading(heading, needle, options = {}) {
    if (!heading) return null;
    const target = norm(needle);
    const maxText = options.maxText || 2400;
    const maxChildren = options.maxChildren || 100;
    let best = null;
    for (let cur = heading, i = 0; cur && i < 8; i++, cur = cur.parentElement) {
      if (cur === document.body || cur === document.documentElement) break;
      const raw = fastText(cur);
      if (!raw || raw.length > maxText) continue;
      if (!norm(raw).includes(target)) continue;
      if ((cur.childElementCount || 0) > maxChildren) continue;
      best = cur;
      let interactions = 0;
      try { interactions = cur.querySelectorAll(interactiveSelector).length; } catch (_) {}
      if (interactions > 0 && i >= 1) return cur;
    }
    return best;
  }

  function invalidateCaches() {
    if (!cache.proximityRoot?.isConnected) {
      cache.proximityRoot = null;
      cache.captureRow = null;
    }
    if (!cache.captureRow?.isConnected) cache.captureRow = null;
    if (!cache.automationRoot?.isConnected) cache.automationRoot = null;
  }

  function discoverProximityRoot() {
    invalidateCaches();
    if (cache.proximityRoot) return cache.proximityRoot;
    const heading = findSmallHeading('proximidade para capturar');
    const root = panelFromHeading(heading, 'proximidade para capturar', { maxText:1400, maxChildren:70 });
    if (root) {
      cache.proximityRoot = root;
      cache.discoveryCount++;
      cache.captureRow = null;
      setAction('Painel de proximidade localizado');
    }
    return root;
  }

  function discoverAutomationRoot() {
    invalidateCaches();
    if (cache.automationRoot) return cache.automationRoot;
    const heading = findSmallHeading('automacoes');
    const root = panelFromHeading(heading, 'automacoes', { maxText:3000, maxChildren:140 });
    if (root) cache.automationRoot = root;
    return root;
  }

  // Nunca mexemos nos switches “Lançar até Capturar” / “Lançar sem Parar” marcados VIP.
  function isVipAutomationToggle(el) {
    let cur = el;
    for (let i = 0; cur && i < 5; i++, cur = cur.parentElement) {
      const raw = fastText(cur);
      if (!raw || raw.length > 320) continue;
      const n = norm(raw);
      if ((n.includes('lancar ate capturar') || n.includes('lancar sem parar')) && n.includes('vip')) return true;
    }
    return false;
  }

  // Neste PokeIdle a captura NÃO é feita pelo ícone de Pokébola do cabeçalho.
  // O alvo correto é o retângulo da lista "PROXIMIDADE PARA CAPTURAR"
  // (ex.: "Bellsprout Nv1"). Mantemos uma referência direta a esse retângulo.
  function parseProximityRowText(raw) {
    const text = String(raw || '').replace(/\s+/g, ' ').trim();
    if (!text || text.length > 90) return null;
    const m = text.match(/^([\p{L}\p{N} .♀♂'’\-]{2,65}?)\s+(?:nv\.?|n[ií]vel|nivel|lv\.?)\s*(\d{1,3})$/iu);
    if (!m) return null;
    const name = globalThis.PokeIdleCaptureParser?.sanitizeName(m[1]) || String(m[1]).trim();
    if (!name || name.length > 70) return null;
    return { name, level:Number(m[2]) || 0, label:text };
  }

  function resolveProximityClickRow(textNode, root) {
    if (!textNode || !root?.contains(textNode)) return null;
    let best = null;
    let bestScore = -999;

    for (let cur = textNode, depth = 0; cur && cur !== root && depth < 6; depth++, cur = cur.parentElement) {
      if (ownUi(cur) || !isVisibleFast(cur)) continue;
      const parsed = parseProximityRowText(fastText(cur));
      if (!parsed) continue;

      const rect = cur.getBoundingClientRect?.();
      if (!rect || rect.width < 70 || rect.height < 18 || rect.height > 110) continue;

      let score = 0;
      // Pela UI mostrada, o retângulo inteiro costuma ter ~150-230 px de largura.
      if (rect.width >= 110 && rect.width <= 320) score += 80;
      if (rect.height >= 26 && rect.height <= 70) score += 60;
      if (cur.matches?.('button,a,[role="button"],[tabindex]')) score += 50;
      if (cur.onclick || cur.getAttribute?.('onclick')) score += 35;
      if (depth >= 1) score += 10; // prefere o contêiner da linha, não só o texto interno
      if ((cur.childElementCount || 0) >= 1) score += 10;

      if (score > bestScore) {
        bestScore = score;
        best = cur;
      }
    }

    return best || textNode;
  }

  function findProximityRows(allowDiscovery = false) {
    const root = cache.proximityRoot?.isConnected ? cache.proximityRoot : (allowDiscovery ? discoverProximityRoot() : null);
    if (!root) return [];

    const found = [];
    const seen = new Set();
    let nodes = [];
    try {
      // O painel é pequeno; esta busca fica restrita SOMENTE a ele.
      nodes = root.querySelectorAll('div,li,button,a,[role="button"],[tabindex],span,p,strong,b');
    } catch (_) {
      return found;
    }

    for (const node of nodes) {
      if (ownUi(node) || !isVisibleFast(node)) continue;
      const parsed = parseProximityRowText(fastText(node));
      if (!parsed) continue;
      const row = resolveProximityClickRow(node, root);
      if (!row || seen.has(row) || !root.contains(row) || !isVisibleFast(row)) continue;
      const rect = row.getBoundingClientRect?.();
      if (!rect || rect.width < 70 || rect.height < 18) continue;
      seen.add(row);
      found.push({ row, ...parsed, top:rect.top, left:rect.left });
    }

    found.sort((a,b) => a.top - b.top || a.left - b.left);
    return found;
  }

  function findManualCaptureButton(allowDiscovery = false) {
    const root = cache.proximityRoot?.isConnected ? cache.proximityRoot : (allowDiscovery ? discoverProximityRoot() : null);
    if (!root) return null;

    if (cache.captureRow?.isConnected && root.contains(cache.captureRow) && isVisibleFast(cache.captureRow)) {
      const parsed = parseProximityRowText(fastText(cache.captureRow));
      if (parsed) return cache.captureRow;
    }

    const rows = findProximityRows(allowDiscovery);
    cache.captureRow = rows[0]?.row || null;
    return cache.captureRow;
  }

  function extractTargetName(allowDiscovery = false) {
    const row = findManualCaptureButton(allowDiscovery);
    if (!row) return '';
    return parseProximityRowText(fastText(row))?.name || '';
  }

  function captureReady() {
    const root = cache.proximityRoot?.isConnected ? cache.proximityRoot : discoverProximityRoot();
    if (!root?.isConnected || !isVisibleFast(root)) return false;
    const row = findManualCaptureButton(true);
    return !!(row && isVisibleFast(row) && parseProximityRowText(fastText(row)));
  }

  function autoCatchTick() {
    if (!config.enabled || !config.autoCatch || state.catchBusy) return;
    const now = Date.now();
    // O jogo usa ~2s entre cliques. 2050ms dá uma margem pequena para não perder
    // tentativas por clicar alguns milissegundos antes do servidor liberar.
    const cooldown = Math.max(2000, Number(config.cooldownMs) || 2050);
    if (now - state.lastCatch < cooldown) return;

    const row = findManualCaptureButton(false);
    if (!row || !isVisibleFast(row)) return;
    const parsed = parseProximityRowText(fastText(row));
    if (!parsed?.name) {
      cache.captureRow = null;
      return;
    }

    state.catchBusy = true;
    state.lastCatch = now;
    state.sessionThrows++;
    state.pendingTargetName = parsed.name;
    state.pendingTargetAt = now;
    setAction(`Clicando em ${parsed.name} Nv${parsed.level || '?'}`);
    dispatchClick(row);
    bumpStats('throws');

    // A linha pode ser removida/reordenada depois do clique; força a próxima
    // tentativa a resolver o primeiro retângulo disponível de novo.
    setTimeout(() => {
      state.catchBusy = false;
      if (!cache.captureRow?.isConnected || !parseProximityRowText(fastText(cache.captureRow))) {
        cache.captureRow = null;
      }
      autoCatchTick();
    }, cooldown);
  }

  // ---------------------------------------------------------------------------
  // Pokébolas: leitura do estoque + troca conservadora
  // ---------------------------------------------------------------------------

  const BALL_TYPES = Object.freeze([
    { key:'poke', name:'Poké Ball', priority:10, aliases:['poke ball','pokeball','poké ball','pokébola','pokebola'] },
    { key:'great', name:'Great Ball', priority:20, aliases:['great ball','greatball'] },
    { key:'ultra', name:'Ultra Ball', priority:30, aliases:['ultra ball','ultraball'] },
    { key:'safari', name:'Safari Ball', priority:35, aliases:['safari ball','safariball'] },
    { key:'net', name:'Net Ball', priority:36, aliases:['net ball','netball'] },
    { key:'dive', name:'Dive Ball', priority:37, aliases:['dive ball','diveball'] },
    { key:'dusk', name:'Dusk Ball', priority:38, aliases:['dusk ball','duskball'] },
    { key:'quick', name:'Quick Ball', priority:39, aliases:['quick ball','quickball'] },
    { key:'beast', name:'Beast Ball', priority:70, aliases:['beast ball','beastball'] },
    { key:'master', name:'Master Ball', priority:100, aliases:['master ball','masterball'] }
  ]);

  function detectBallType(el) {
    const meta = compactMeta(el);
    if (!meta) return null;
    for (const type of BALL_TYPES) {
      for (const alias of type.aliases) {
        const a = norm(alias);
        if (meta.includes(a) || meta.includes(a.replace(/\s+/g,'')) || meta.includes(a.replace(/\s+/g,'-')) || meta.includes(a.replace(/\s+/g,'_'))) return type;
      }
    }
    return null;
  }

  function parseCountText(raw) {
    const text = String(raw || '').replace(/\s+/g, ' ').trim();
    if (!text || text.length > 90) return null;
    const values = [...text.matchAll(/(?:^|[^\d])(\d{1,6})(?!\d)/g)].map(m => Number(m[1])).filter(Number.isFinite);
    if (!values.length) return null;
    return Math.max(...values);
  }

  function smallContainerFor(node, root) {
    let best = node;
    for (let cur = node, i = 0; cur && i < 5; i++, cur = cur.parentElement) {
      if (!root?.contains(cur)) break;
      const raw = fastText(cur);
      if (raw.length <= 100 && (cur.childElementCount || 0) <= 10) best = cur;
      else break;
    }
    return best;
  }

  function clickableAncestor(node, root) {
    let cur = node;
    for (let i = 0; cur && i < 5; i++, cur = cur.parentElement) {
      if (!root?.contains(cur)) return null;
      if (cur.matches?.(interactiveSelector)) return cur;
    }
    return null;
  }

  function selectedScore(el, root) {
    let score = 0;
    for (let cur = el, i = 0; cur && i < 5; i++, cur = cur.parentElement) {
      if (!root?.contains(cur)) break;
      const cls = norm(cur.className?.toString());
      if (/selected|active|current|checked|chosen|equipped/.test(cls)) score += 4;
      if (cur.getAttribute?.('aria-pressed') === 'true') score += 6;
      if (cur.getAttribute?.('aria-selected') === 'true') score += 6;
      if (cur.getAttribute?.('data-selected') === 'true') score += 6;
    }
    return score;
  }

  function genericBallSlots(root) {
    const slots = [];
    let candidates = [];
    try { candidates = [...root.querySelectorAll('button,[role="button"],label,div')]; } catch (_) {}
    for (const el of candidates) {
      if (!isVisibleFast(el) || ownUi(el)) continue;
      const raw = fastText(el);
      if (!/^\s*\d{1,6}\s*$/.test(raw)) continue;
      const rect = el.getBoundingClientRect?.();
      if (!rect || rect.width < 28 || rect.width > 100 || rect.height < 20 || rect.height > 70) continue;
      const img = el.querySelector?.('img,svg');
      if (!img) continue;
      const target = clickableAncestor(el, root) || el;
      if (isVipAutomationToggle(target)) continue;
      slots.push({ el, target, count:Number(raw), rect });
    }
    // remove elementos aninhados duplicados
    const unique = [];
    for (const s of slots.sort((a,b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left)) {
      if (unique.some(u => u.el.contains(s.el) || s.el.contains(u.el))) continue;
      unique.push(s);
    }
    return unique.slice(0, 8);
  }

  function scanBallInventory(allowDiscovery = false) {
    const root = cache.automationRoot?.isConnected ? cache.automationRoot : (allowDiscovery ? discoverAutomationRoot() : null);
    if (!root?.isConnected) return { detected:false, current:null, stocks:[], out:false, at:Date.now(), source:'none' };

    let nodes = [];
    try { nodes = [...root.querySelectorAll('img,[aria-label],[title],[data-name],[data-ball],button,[role="button"]')]; } catch (_) {}
    const found = new Map();

    for (const node of nodes) {
      const type = detectBallType(node);
      if (!type || !isVisibleFast(node)) continue;
      const box = smallContainerFor(node, root);
      const count = parseCountText(fastText(box));
      const target = clickableAncestor(node, root) || clickableAncestor(box, root) || box;
      const candidate = {
        key:type.key,
        name:type.name,
        priority:type.priority,
        count,
        target,
        selectedScore:selectedScore(node, root),
        current:false,
        switchable:!!target && isEnabled(target) && !isVipAutomationToggle(target)
      };
      const old = found.get(type.key);
      if (!old || candidate.selectedScore > old.selectedScore || (old.count == null && candidate.count != null)) found.set(type.key, candidate);
    }

    let stocks = [...found.values()].sort((a,b) => a.priority - b.priority);

    // Se os sprites não carregarem nomes nos atributos, ainda mostramos os slots e quantidades.
    if (!stocks.length) {
      const generic = genericBallSlots(root);
      stocks = generic.map((slot, index) => ({
        key:`slot-${index+1}`,
        name:`Bola ${index+1}`,
        priority:10 + index,
        count:slot.count,
        target:slot.target,
        selectedScore:selectedScore(slot.el, root),
        current:false,
        switchable:!!slot.target && isEnabled(slot.target) && !isVipAutomationToggle(slot.target)
      }));
    }

    let current = stocks.filter(x => x.selectedScore > 0).sort((a,b) => b.selectedScore - a.selectedScore)[0] || null;
    if (!current && stocks.length === 1) current = stocks[0];
    for (const item of stocks) item.current = !!current && item.key === current.key;

    const known = stocks.filter(x => Number.isFinite(x.count));
    const out = known.length > 0 && known.every(x => x.count === 0);
    const total = known.reduce((sum, x) => sum + x.count, 0);
    return { detected:stocks.length > 0, current, stocks, out, total, at:Date.now(), source:found.size ? 'named' : 'slots' };
  }

  function showToast(message, level = 'info') {
    if (!document.body) return;
    if (!toastHost) {
      toastHost = document.createElement('div');
      toastHost.id = 'pio-auto-helper-toasts';
      toastHost.style.cssText = [
        'position:fixed','right:14px','bottom:14px','z-index:2147483647','display:flex','flex-direction:column',
        'gap:8px','width:min(350px,calc(100vw - 28px))','pointer-events:none','font:12px/1.35 Arial,sans-serif'
      ].join(';');
      document.body.appendChild(toastHost);
    }
    const item = document.createElement('div');
    const bg = level === 'out' ? 'rgba(116,31,36,.97)' : level === 'warn' ? 'rgba(116,82,20,.97)' : 'rgba(22,78,54,.97)';
    item.style.cssText = `padding:10px 12px;border-radius:9px;background:${bg};border:1px solid rgba(255,255,255,.18);color:#fff;box-shadow:0 4px 18px rgba(0,0,0,.42);opacity:0;transform:translateY(4px);transition:.18s ease`;
    item.textContent = message;
    toastHost.appendChild(item);
    requestAnimationFrame(() => { item.style.opacity = '1'; item.style.transform = 'translateY(0)'; });
    setTimeout(() => {
      item.style.opacity = '0';
      item.style.transform = 'translateY(4px)';
      setTimeout(() => item.remove(), 220);
    }, level === 'out' ? 9000 : 6000);
  }

  function sendBallAlert(key, title, message, level = 'warn') {
    const now = Date.now();
    const prior = warningMemory.get(key) || 0;
    const sticky = key.startsWith('low-') || key.startsWith('switch-');
    const cooldown = level === 'out' ? 300000 : 180000;
    if ((sticky && prior) || (!sticky && now - prior < cooldown)) return;
    warningMemory.set(key, now);
    showToast(message, level);
    try { chrome.runtime.sendMessage({ type:'BALL_ALERT', key, title, message, level }); } catch (_) {}
  }

  function resetBallWarnings(snapshot) {
    const threshold = Math.max(1, Number(config.lowBallThreshold) || 20);
    for (const item of snapshot.stocks || []) {
      if (Number.isFinite(item.count) && item.count > threshold) warningMemory.delete(`low-${item.key}`);
      if (Number.isFinite(item.count) && item.count > 0) warningMemory.delete(`empty-${item.key}`);
    }
    if (!snapshot.out) warningMemory.delete('all-out');
    if (snapshot.total > threshold) warningMemory.delete('low-total');
  }

  function maybeWarnBallStock(snapshot) {
    if (!config.warnLowBalls || !snapshot.detected) return;
    resetBallWarnings(snapshot);
    const threshold = Math.max(1, Number(config.lowBallThreshold) || 20);
    const current = snapshot.current;
    if (current && Number.isFinite(current.count) && current.count > 0 && current.count <= threshold) {
      sendBallAlert(`low-${current.key}`, 'Pokébolas acabando', `${current.name}: só ${current.count} restante${current.count === 1 ? '' : 's'}.`, 'warn');
    } else if (!current && Number.isFinite(snapshot.total) && snapshot.total > 0 && snapshot.total <= threshold) {
      sendBallAlert('low-total', 'Pokébolas acabando', `Estoque total detectado: ${snapshot.total} Pokébola${snapshot.total === 1 ? '' : 's'}.`, 'warn');
    }
    if (snapshot.out) sendBallAlert('all-out', 'Sem Pokébolas', 'O Auto Helper não encontrou nenhuma Pokébola com estoque.', 'out');
  }

  function chooseReplacement(snapshot) {
    const currentKey = snapshot.current?.key;
    return (snapshot.stocks || [])
      .filter(x => x.key !== currentKey && Number.isFinite(x.count) && x.count > 0 && x.switchable && x.target && isVisibleFast(x.target))
      .sort((a,b) => a.priority - b.priority)[0] || null;
  }

  function performBallSwitch(snapshot) {
    if (!config.enabled || !config.autoSwitchBalls) return false;
    const current = snapshot.current;
    if (!current || current.count !== 0) return false;
    const now = Date.now();
    if (now - state.lastBallSwitch < 2500) return false;
    const next = chooseReplacement(snapshot);
    if (!next) return false;
    // Segurança: nunca clica nos switches VIP. Seleção de bola só ocorre em um controle habilitado próprio.
    if (isVipAutomationToggle(next.target)) return false;
    state.lastBallSwitch = now;
    setAction(`${current.name} acabou → ${next.name}`);
    dispatchClick(next.target);
    sendBallAlert(`switch-${current.key}-${next.key}`, 'Trocando Pokébola', `${current.name} acabou. Selecionando ${next.name}.`, 'info');
    return true;
  }

  function ballManagerTick() {
    if (!config.enabled || (!config.autoSwitchBalls && !config.warnLowBalls)) return;
    const snapshot = scanBallInventory();
    state.ballSnapshot = snapshot;
    maybeWarnBallStock(snapshot);
    performBallSwitch(snapshot);
    updateHUDState();
  }

  // ---------------------------------------------------------------------------
  // Histórico de capturas
  // ---------------------------------------------------------------------------

  const captureNodeText = new WeakMap();
  const recentCaptureMessages = new Map();
  const captureKeyword = /captur|caught|captured/i;

  function registerCapture(name, shiny, sourceText) {
    const clean = globalThis.PokeIdleCaptureParser?.sanitizeName(name) || String(name || '').trim();
    if (!clean) return;
    const key = `${clean.toLocaleLowerCase('pt-BR')}/${!!shiny}`;
    const now = Date.now();
    if (now - (recentCaptureMessages.get(key) || 0) < 2800) return;
    recentCaptureMessages.set(key, now);
    for (const [k, stamp] of recentCaptureMessages) if (now - stamp > 15000) recentCaptureMessages.delete(k);

    chrome.runtime.sendMessage({ type:'CAPTURE_CONFIRMED', name:clean, shiny:!!shiny, sourceText:String(sourceText || '').slice(0,300) }, response => {
      if (chrome.runtime.lastError || !response?.ok || response?.duplicate) return;
      state.confirmedCaptures++;
      state.lastCapturedPokemon = `${clean}${shiny ? ' ✨' : ''}`;
      state.pendingTargetName = '';
      state.pendingTargetAt = 0;
      setAction(`Capturado: ${state.lastCapturedPokemon}`);
      updateHUDState();
    });
  }

  function inspectCaptureElement(el) {
    if (!el || !el.isConnected || ownUi(el) || isChatNode(el)) return;
    const raw = fastText(el);
    if (raw.length < 5 || raw.length > 320 || !captureKeyword.test(norm(raw))) return;
    if (captureNodeText.get(el) === raw) return;
    captureNodeText.set(el, raw);

    const parsed = globalThis.PokeIdleCaptureParser?.parseCapture(raw);
    if (parsed) {
      registerCapture(parsed.name, parsed.shiny, raw);
      return;
    }

    // Alguns jogos mostram só “Capturado!” no log. Nesse caso usamos o alvo que acabamos de tentar,
    // mas somente dentro de uma janela curta e apenas se a frase for inequivocamente positiva.
    const positive = globalThis.PokeIdleCaptureParser?.isPositiveCapture(raw);
    if (positive && state.pendingTargetName && Date.now() - state.pendingTargetAt < 20000) {
      registerCapture(state.pendingTargetName, /\bshiny\b/i.test(raw), raw);
    }
  }

  function queueMutations(records) {
    for (const record of records) {
      for (const item of record.addedNodes || []) {
        const node = item.nodeType === Node.TEXT_NODE ? item.parentElement : item;
        if (!node || node.nodeType !== Node.ELEMENT_NODE || ownUi(node) || isChatNode(node)) continue;

        // Se os painéis foram recriados pelo framework, invalida o cache de forma barata.
        if (!cache.proximityRoot?.isConnected) cache.captureRow = null;
        if (pendingMutationNodes.length >= PERF.maxMutationNodes) continue;
        const raw = fastText(node);
        if (!raw || raw.length > 900) continue;
        if (captureKeyword.test(norm(raw))) pendingMutationNodes.push(node);
      }
    }
    if (pendingMutationNodes.length && !mutationTimer) mutationTimer = setTimeout(flushMutations, PERF.mutationDebounceMs);
  }

  function flushMutations() {
    mutationTimer = null;
    const batch = pendingMutationNodes.splice(0, PERF.maxMutationNodes);
    for (const node of batch) inspectCaptureElement(node);
    if (pendingMutationNodes.length) mutationTimer = setTimeout(flushMutations, PERF.mutationDebounceMs);
  }

  // ---------------------------------------------------------------------------
  // Reconexão / pop-ups / watchdog
  // ---------------------------------------------------------------------------

  const reconnectLabels = new Set([
    'reconectar','reconectar-se','tentar novamente','tente novamente','reconectar agora',
    'conectar novamente','voltar ao jogo','retry','reconnect'
  ].map(norm));

  const disconnectMessages = [
    'desconectado','voce foi desconectado','conexao perdida','conexao encerrada',
    'falha na conexao','servidor desconectado','connection lost','disconnected',
    'server disconnected','network error'
  ].map(norm);

  function looksLikeModal(el) {
    if (!el) return false;
    const role = norm(el.getAttribute?.('role'));
    if (role === 'dialog' || role === 'alertdialog') return true;
    const cls = norm(el.className?.toString());
    return cls.includes('modal') || cls.includes('popup') || cls.includes('dialog') || cls.includes('overlay');
  }

  function modalParent(el) {
    let cur = el;
    for (let i = 0; cur && i < 9; i++, cur = cur.parentElement) if (looksLikeModal(cur)) return cur;
    return null;
  }

  function utilityScan() {
    if (!config.enabled || (!config.autoReconnect && !config.closePopups)) return;
    let elements = [];
    try { elements = document.querySelectorAll(interactiveSelector); } catch (_) { return; }
    let reconnect = null;
    let safeClose = null;

    for (const el of elements) {
      if (!isEnabled(el) || !isVisibleFast(el) || ownUi(el)) continue;
      const label = norm(fastText(el));
      const aria = norm(el.getAttribute?.('aria-label'));
      const title = norm(el.getAttribute?.('title'));

      if (!reconnect && config.autoReconnect && reconnectLabels.has(label)) reconnect = el;

      if (!safeClose && config.closePopups) {
        const close = label === 'fechar' || label === 'close' || label === '×' || label === 'x' || aria === 'fechar' || aria === 'close' || title === 'fechar' || title === 'close';
        if (close) {
          const modal = modalParent(el);
          if (modal) {
            const modalText = norm(fastText(modal));
            // Não fecha aviso de versão nem diálogos relacionados à conexão.
            if (!modalText.includes('versao nova disponivel') && !disconnectMessages.some(x => modalText.includes(x))) safeClose = el;
          }
        }
      }
      if (reconnect && safeClose) break;
    }

    if (reconnect && Date.now() - state.lastReconnect > 4000) {
      state.lastReconnect = Date.now();
      state.sessionReconnects++;
      setAction(`Reconectando #${state.sessionReconnects}`);
      dispatchClick(reconnect);
      bumpStats('reconnects');
    }

    if (safeClose) {
      state.sessionPopups++;
      setAction(`Pop-up fechado #${state.sessionPopups}`);
      dispatchClick(safeClose);
      bumpStats('popups');
    }
  }

  function textHasDisconnect(raw) {
    const n = norm(raw);
    return disconnectMessages.some(msg => n.includes(msg));
  }

  function detectDisconnectLight() {
    let candidates = [];
    try { candidates = document.querySelectorAll('[role="dialog"],[role="alert"],[aria-live="assertive"]'); } catch (_) {}
    let checked = 0;
    for (const el of candidates) {
      if (++checked > 25) break;
      const raw = fastText(el);
      if (raw.length && raw.length <= 1600 && textHasDisconnect(raw)) return true;
    }

    if (Date.now() - lastBodyDisconnectProbe > PERF.bodyProbeMs) {
      lastBodyDisconnectProbe = Date.now();
      const bodyText = document.body ? fastText(document.body) : '';
      cachedDisconnect = bodyText.length < 120000 && textHasDisconnect(bodyText);
    }
    return cachedDisconnect;
  }

  function watchdog() {
    if (!config.enabled) {
      state.disconnectedAt = 0;
      updateHUDState();
      return;
    }

    const disconnected = detectDisconnectLight();
    if (!disconnected) {
      if (state.disconnectedAt) {
        state.disconnectedAt = 0;
        setAction('Conexão normalizada');
      }
      updateHUDState();
      return;
    }

    if (!state.disconnectedAt) {
      state.disconnectedAt = Date.now();
      setAction('Desconexão detectada');
    }
    utilityScan();

    if (!config.autoReload) return;
    const threshold = Math.max(8000, Number(config.reloadAfterDisconnectMs) || 12000);
    if (Date.now() - state.disconnectedAt < threshold) return;

    const lastReload = Number(sessionStorage.getItem('pioAutoHelperLastReload') || 0);
    if (Date.now() - lastReload < 30000) return;
    sessionStorage.setItem('pioAutoHelperLastReload', String(Date.now()));
    setAction('Recarregando após desconexão');
    location.reload();
  }

  // ---------------------------------------------------------------------------
  // Liga/desliga rápido e HUD arrastável
  // ---------------------------------------------------------------------------

  async function setMasterEnabled(enabled, origin = 'atalho') {
    config.enabled = !!enabled;
    if (!config.enabled) state.catchBusy = false;
    try { await chrome.storage.sync.set({ enabled:config.enabled }); } catch (_) {}
    setAction(config.enabled ? `Auto Helper ativado (${origin})` : `Auto Helper pausado (${origin})`);
    updateQuickToggle();
    updateHUDState(true);
    if (config.enabled) {
      discoveryTick();
      autoCatchTick();
      ballManagerTick();
    }
  }

  function createQuickToggle() {
    if (!document.body || quickToggle) return;
    quickToggle = document.createElement('button');
    quickToggle.id = 'pio-auto-helper-quick-toggle';
    quickToggle.type = 'button';
    quickToggle.title = 'Ativar/pausar Auto Helper · Alt + Shift + P';
    quickToggle.style.cssText = [
      'position:fixed','right:16px','top:12px','z-index:2147483647','height:30px','padding:0 11px',
      'border-radius:8px','border:1px solid rgba(255,255,255,.28)','color:#fff','font:700 11px Arial,sans-serif',
      'box-shadow:0 3px 10px rgba(0,0,0,.35)','cursor:pointer','user-select:none'
    ].join(';');
    quickToggle.addEventListener('click', () => setMasterEnabled(!config.enabled, 'botão no jogo'));
    document.body.appendChild(quickToggle);
    updateQuickToggle();
  }

  function updateQuickToggle() {
    if (!quickToggle) return;
    quickToggle.style.display = config.showQuickToggle ? 'block' : 'none';
    quickToggle.textContent = config.enabled ? '● AUTO ON' : 'Ⅱ AUTO OFF';
    quickToggle.style.background = config.enabled ? 'rgba(24,126,73,.95)' : 'rgba(111,45,48,.95)';
  }

  function clampHudPosition(pos) {
    if (!hud || !pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.y)) return null;
    const w = hud.offsetWidth || 220;
    const h = hud.offsetHeight || 220;
    return {
      x:Math.max(0, Math.min(window.innerWidth - w, pos.x)),
      y:Math.max(0, Math.min(window.innerHeight - h, pos.y))
    };
  }

  function applyHudPosition(pos) {
    if (!hud || !pos) return;
    const safe = clampHudPosition(pos);
    if (!safe) return;
    hud.style.right = 'auto';
    hud.style.left = `${safe.x}px`;
    hud.style.top = `${safe.y}px`;
  }

  function saveHudPosition() {
    if (!hud) return;
    const rect = hud.getBoundingClientRect();
    hudPosition = clampHudPosition({ x:rect.left, y:rect.top });
    if (hudPosition) chrome.storage.local.set({ hudPosition });
  }

  function resetHudPosition() {
    hudPosition = null;
    if (!hud) return;
    hud.style.left = 'auto';
    hud.style.right = '16px';
    hud.style.top = '52px';
    chrome.storage.local.remove('hudPosition');
  }

  function setupHudDrag(handle) {
    if (!hud || !handle) return;
    handle.style.cursor = 'move';
    handle.style.touchAction = 'none';
    handle.title = 'Arraste para mover · duplo clique para restaurar';
    handle.addEventListener('dblclick', event => {
      event.preventDefault();
      resetHudPosition();
    });
    handle.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      event.preventDefault();
      const startRect = hud.getBoundingClientRect();
      const startX = event.clientX;
      const startY = event.clientY;
      hud.style.right = 'auto';
      handle.setPointerCapture?.(event.pointerId);
      const move = e => {
        const pos = clampHudPosition({ x:startRect.left + (e.clientX - startX), y:startRect.top + (e.clientY - startY) });
        if (!pos) return;
        hud.style.left = `${pos.x}px`;
        hud.style.top = `${pos.y}px`;
      };
      const up = e => {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
        handle.removeEventListener('pointercancel', up);
        try { handle.releasePointerCapture?.(e.pointerId); } catch (_) {}
        saveHudPosition();
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
      handle.addEventListener('pointercancel', up);
    });
  }

  function addHudLine(label, key) {
    const line = document.createElement('div');
    line.append(document.createTextNode(label));
    const value = document.createElement('b');
    line.append(value);
    hud.append(line);
    hudRefs[key] = value;
  }

  function createHUD() {
    if (!document.body || hud) return;
    hud = document.createElement('div');
    hud.id = 'pio-auto-helper-hud';
    hud.style.cssText = [
      'position:fixed','top:52px','right:16px','z-index:2147483646','min-width:205px','padding:9px 11px',
      'background:rgba(30,19,45,.95)','border:1px solid #9a66c2','border-radius:9px','color:#f7edf9',
      'font:11px/1.45 Arial,sans-serif','box-shadow:0 3px 14px rgba(0,0,0,.45)','pointer-events:none',
      'user-select:none','contain:layout style paint'
    ].join(';');

    hudTitle = document.createElement('div');
    hudTitle.textContent = '↕ ◉ POKEIDLE.IO HELPER v1.1';
    hudTitle.style.cssText = 'font-weight:700;color:#ffd5ff;margin:-3px -5px 5px;padding:3px 5px;border-radius:5px;cursor:move;pointer-events:auto;background:rgba(255,255,255,.05)';
    hud.append(hudTitle);
    setupHudDrag(hudTitle);
    addHudLine('Status: ', 'status');
    addHudLine('Alvo próximo: ', 'target');
    addHudLine('Tentativas: ', 'throws');
    addHudLine('Capturados: ', 'captures');
    addHudLine('Última captura: ', 'lastCapture');
    addHudLine('Pokébola atual: ', 'currentBall');
    addHudLine('Estoque: ', 'ballStock');
    addHudLine('Reconexões: ', 'reconnects');
    addHudLine('Painel captura: ', 'cache');
    addHudLine('Rodando: ', 'uptime');
    addHudLine('Último: ', 'lastAction');
    document.body.appendChild(hud);

    chrome.storage.local.get({ hudPosition:null }).then(({ hudPosition:pos }) => {
      hudPosition = pos;
      applyHudPosition(pos);
    }).catch(() => {});
    updateHUDState(true);
  }

  function setHudText(key, value) {
    const el = hudRefs[key];
    const next = String(value);
    if (el && el.textContent !== next) el.textContent = next;
  }

  function formatTime(ms) {
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
  }

  function updateHUDState(force = false) {
    updateQuickToggle();
    if (!config.showHUD) {
      if (hud) hud.style.display = 'none';
      return;
    }
    createHUD();
    if (!hud) return;
    hud.style.display = 'block';
    const active = config.enabled;
    const status = !active ? 'PAUSADO' : state.disconnectedAt ? 'RECONECTANDO' : 'ATIVO';
    const statusColor = !active ? '#ddd' : state.disconnectedAt ? '#ff8080' : '#79f1a8';
    setHudText('status', status);
    if (hudRefs.status && (force || hudRefs.status.style.color !== statusColor)) hudRefs.status.style.color = statusColor;
    setHudText('target', extractTargetName(false) || '—');
    setHudText('throws', state.sessionThrows);
    setHudText('captures', state.allCaptures);
    setHudText('lastCapture', state.lastCapturedPokemon || '—');
    const ball = state.ballSnapshot?.current;
    setHudText('currentBall', ball?.name || (state.ballSnapshot?.detected ? 'não identificada' : '—'));
    setHudText('ballStock', Number.isFinite(ball?.count) ? ball.count : (Number.isFinite(state.ballSnapshot?.total) ? `total ${state.ballSnapshot.total}` : '—'));
    const threshold = Math.max(1, Number(config.lowBallThreshold) || 20);
    if (hudRefs.ballStock) {
      const c = Number.isFinite(ball?.count) ? ball.count : state.ballSnapshot?.total;
      const color = c === 0 ? '#ff7770' : (Number.isFinite(c) && c <= threshold ? '#ffd06a' : '#f7edf9');
      if (force || hudRefs.ballStock.style.color !== color) hudRefs.ballStock.style.color = color;
    }
    setHudText('reconnects', state.sessionReconnects);
    setHudText('cache', cache.proximityRoot?.isConnected ? (cache.captureRow?.isConnected ? 'OK' : 'painel OK') : 'procurando');
    setHudText('lastAction', state.lastAction);
  }

  function updateHUDClock() {
    if (!config.showHUD || !hud) return;
    setHudText('uptime', formatTime(Date.now() - state.startedAt));
  }

  // ---------------------------------------------------------------------------
  // Ciclo / mensagens
  // ---------------------------------------------------------------------------

  function discoveryTick() {
    invalidateCaches();
    if (!config.enabled) return;
    discoverProximityRoot();
    discoverAutomationRoot();
    findManualCaptureButton(true);
    updateHUDState();
  }

  async function loadConfig() {
    try { config = { ...DEFAULTS, ...(await chrome.storage.sync.get(DEFAULTS)) }; }
    catch (_) { config = { ...DEFAULTS }; }
    updateQuickToggle();
    updateHUDState(true);
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.captureData) {
      const fresh = changes.captureData.newValue || {};
      state.allCaptures = Number(fresh.total) || 0;
      const last = fresh.history?.[0];
      state.lastCapturedPokemon = last ? `${last.name}${last.shiny ? ' ✨' : ''}` : '';
      updateHUDState();
      return;
    }
    if (area !== 'sync') return;
    for (const [key, change] of Object.entries(changes)) if (key in DEFAULTS) config[key] = change.newValue;
    if (!config.enabled) state.catchBusy = false;
    updateQuickToggle();
    updateHUDState(true);
    if (config.enabled) {
      discoveryTick();
      autoCatchTick();
      ballManagerTick();
    }
  });

  function publicBallSnapshot(snapshot = state.ballSnapshot) {
    if (!snapshot) return { detected:false, current:null, stocks:[], out:false, total:null, threshold:Math.max(1, Number(config.lowBallThreshold) || 20) };
    const clean = item => item ? { key:item.key, name:item.name, count:Number.isFinite(item.count) ? item.count : null, current:!!item.current, switchable:!!item.switchable } : null;
    return {
      detected:!!snapshot.detected,
      current:clean(snapshot.current),
      stocks:(snapshot.stocks || []).map(clean),
      out:!!snapshot.out,
      total:Number.isFinite(snapshot.total) ? snapshot.total : null,
      source:snapshot.source || '',
      threshold:Math.max(1, Number(config.lowBallThreshold) || 20),
      autoSwitch:!!config.autoSwitchBalls,
      warnLow:!!config.warnLowBalls
    };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'GET_PAGE_STATUS') {
      discoveryTick();
      sendResponse({
        ok:true,
        url:location.href,
        enabled:config.enabled,
        catchReady:captureReady(),
        target:extractTargetName(),
        disconnected:!!state.disconnectedAt,
        performanceMode:'cached-pokeidle-panels',
        captureCache:!!cache.proximityRoot?.isConnected,
        manualCaptureButton:!!cache.captureRow?.isConnected,
        ballManager:publicBallSnapshot(),
        session:{
          throws:state.sessionThrows,
          confirmedCaptures:state.confirmedCaptures,
          lastCapturedPokemon:state.lastCapturedPokemon,
          reconnects:state.sessionReconnects,
          popups:state.sessionPopups,
          lastAction:state.lastAction,
          uptimeMs:Date.now() - state.startedAt
        }
      });
      return;
    }

    if (message?.type === 'SCAN_NOW') {
      cache.proximityRoot = null;
      cache.captureRow = null;
      cache.automationRoot = null;
      discoveryTick();
      autoCatchTick();
      ballManagerTick();
      utilityScan();
      watchdog();
      sendResponse({ ok:true, captureCache:!!cache.proximityRoot?.isConnected, captureButton:!!cache.captureRow?.isConnected });
      return;
    }

    if (message?.type === 'SET_MASTER_ENABLED') {
      setMasterEnabled(!!message.enabled, 'painel').then(() => sendResponse({ ok:true, enabled:config.enabled }));
      return true;
    }
  });

  function start() {
    chrome.storage.local.get({ captureData:{ total:0, history:[] } }).then(({ captureData }) => {
      state.allCaptures = Number(captureData?.total) || 0;
      const last = captureData?.history?.[0];
      state.lastCapturedPokemon = last ? `${last.name}${last.shiny ? ' ✨' : ''}` : '';
      updateHUDState();
    }).catch(() => {});

    loadConfig().then(() => {
      createQuickToggle();
      createHUD();
      discoveryTick();
      autoCatchTick();
      ballManagerTick();
      utilityScan();
      updateHUDState(true);
    });

    observer = new MutationObserver(queueMutations);
    observer.observe(document.documentElement, { childList:true, subtree:true });

    setInterval(autoCatchTick, PERF.catchPollMs);
    setInterval(ballManagerTick, PERF.inventoryPollMs);
    setInterval(discoveryTick, PERF.discoveryMs);
    setInterval(utilityScan, PERF.utilityMs);
    setInterval(watchdog, PERF.watchdogMs);
    setInterval(updateHUDClock, PERF.hudClockMs);
    window.addEventListener('resize', () => { if (hudPosition) applyHudPosition(hudPosition); }, { passive:true });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once:true });
  else start();
})();
