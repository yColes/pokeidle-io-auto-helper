const defaults = {
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

const ids = ['enabled','autoCatch','autoSwitchBalls','warnLowBalls','autoReconnect','closePopups','autoReload','showHUD','showQuickToggle','preventDiscard','cooldownMs','lowBallThreshold'];
const $ = id => document.getElementById(id);
const emptyData = () => ({ total:0, species:{}, history:[], lastCaptureAt:0 });
let captures = emptyData();
let captureTab = 'recent';
let lastRendered = '';

async function loadSettings() {
  const s = await chrome.storage.sync.get(defaults);
  for (const id of ids) {
    const el = $(id);
    if (el.type === 'checkbox') el.checked = !!s[id];
    else el.value = s[id];
  }
  updateQuickMasterUi(!!s.enabled);
}

function updateQuickMasterUi(enabled) {
  const btn = $('quickMaster');
  if (!btn) return;
  btn.classList.toggle('active', !enabled);
  $('quickMasterIcon').textContent = enabled ? 'Ⅱ' : '▶';
  $('quickMasterText').textContent = enabled ? 'Pausar tudo' : 'Ativar tudo';
}

async function setMasterEnabled(enabled) {
  await chrome.storage.sync.set({ enabled:!!enabled });
  $('enabled').checked = !!enabled;
  updateQuickMasterUi(!!enabled);
}

async function saveSetting(el) {
  let value = el.type === 'checkbox' ? el.checked : Number(el.value);
  if (el.id === 'cooldownMs') value = Math.max(2000, Math.min(15000, value || 2050));
  if (el.id === 'lowBallThreshold') value = Math.max(1, Math.min(9999, value || 20));
  await chrome.storage.sync.set({ [el.id]:value });
}

async function getGameTab() {
  const tabs = await chrome.tabs.query({ url:'https://pokeidle.io/*' });
  return tabs.find(t => t.id != null && (t.url || '').includes('/app')) || null;
}

function setPageStatus(kind, title, detail) {
  $('dot').className = `dot ${kind}`;
  $('pageStatus').textContent = title;
  $('lastAction').textContent = detail || '';
}

function dateText(timestamp) {
  if (!timestamp) return '—';
  const date = new Date(timestamp);
  return Number.isFinite(date.getTime()) ? date.toLocaleString('pt-BR', { dateStyle:'short', timeStyle:'medium' }) : '—';
}

function makeCaptureRow(name, info, isShiny = false) {
  const row = document.createElement('div');
  row.className = 'capture-row';
  const symbol = document.createElement('span');
  symbol.className = 'capture-symbol';
  symbol.textContent = isShiny ? '✨' : '◉';
  const details = document.createElement('div');
  details.className = 'capture-info';
  const bold = document.createElement('b');
  bold.textContent = name;
  const sub = document.createElement('small');
  sub.textContent = info;
  details.append(bold, sub);
  row.append(symbol, details);
  return row;
}

function renderCaptures(force = false) {
  const species = captures.species && typeof captures.species === 'object' ? Object.values(captures.species) : [];
  const total = Number(captures.total) || 0;
  const history = Array.isArray(captures.history) ? captures.history : [];
  $('capturedTotal').textContent = total.toLocaleString('pt-BR');
  $('captureTotalLabel').textContent = total.toLocaleString('pt-BR');
  $('speciesTotal').textContent = species.length.toLocaleString('pt-BR');
  $('lastPokemon').textContent = history.length ? `${history[0].name}${history[0].shiny ? ' ✨ Shiny' : ''} · ${dateText(history[0].at)}` : 'Nenhum registrado';

  const filter = $('captureSearch').value.trim().toLocaleLowerCase('pt-BR');
  const signature = JSON.stringify([captures, captureTab, filter]);
  if (!force && signature === lastRendered) return;
  lastRendered = signature;

  $('tabRecent').classList.toggle('selected', captureTab === 'recent');
  $('tabSpecies').classList.toggle('selected', captureTab === 'species');
  const list = $('captureList');
  const savedScroll = list.scrollTop;
  list.replaceChildren();

  if (captureTab === 'recent') {
    for (const item of history.filter(x => String(x.name || '').toLocaleLowerCase('pt-BR').includes(filter)).slice(0,80)) {
      list.append(makeCaptureRow(item.name, dateText(item.at), !!item.shiny));
    }
  } else {
    const sorted = species
      .filter(x => String(x.name || '').toLocaleLowerCase('pt-BR').includes(filter))
      .sort((a,b) => (Number(b.count)||0) - (Number(a.count)||0) || String(a.name).localeCompare(String(b.name), 'pt-BR'));
    for (const s of sorted) list.append(makeCaptureRow(s.name, `${s.count} capturado${s.count !== 1 ? 's' : ''}${s.shiny ? ` · ${s.shiny} shiny` : ''}`, !!s.shiny));
  }

  if (!list.childElementCount) {
    const hint = document.createElement('div');
    hint.className = 'empty-captures';
    hint.textContent = filter ? 'Nenhum Pokémon corresponde à pesquisa.' : 'Aguardando a primeira captura confirmada.';
    list.append(hint);
  }
  list.scrollTop = savedScroll;
}

async function loadCaptures() {
  const stored = await chrome.storage.local.get({ captureData:emptyData() });
  captures = stored.captureData || emptyData();
  renderCaptures();
}

function renderBallManager(ball) {
  const stateEl = $('ballManagerState');
  const currentEl = $('currentBall');
  const stockEl = $('currentBallStock');
  const list = $('ballStockList');
  stateEl.className = 'ball-state';

  if (!ball?.detected) {
    stateEl.textContent = 'PROCURANDO';
    currentEl.textContent = 'Não detectada';
    stockEl.textContent = 'Estoque: —';
    list.innerHTML = '<div class="empty-captures">Aguardando os controles de Pokébolas do jogo.</div>';
    return;
  }

  const current = ball.current || null;
  const threshold = Number(ball.threshold || 20);
  currentEl.textContent = current?.name || 'Seleção não identificada';
  if (current && Number.isFinite(current.count)) stockEl.textContent = `Estoque: ${current.count.toLocaleString('pt-BR')}`;
  else if (Number.isFinite(ball.total)) stockEl.textContent = `Estoque total: ${ball.total.toLocaleString('pt-BR')}`;
  else stockEl.textContent = 'Estoque: —';

  if (ball.out) {
    stateEl.textContent = 'SEM BOLAS';
    stateEl.classList.add('bad');
  } else if ((current && Number.isFinite(current.count) && current.count <= threshold) || (!current && Number.isFinite(ball.total) && ball.total <= threshold)) {
    stateEl.textContent = 'BAIXO';
    stateEl.classList.add('warn');
  } else {
    stateEl.textContent = 'OK';
    stateEl.classList.add('ok');
  }

  list.replaceChildren();
  const stocks = Array.isArray(ball.stocks) ? ball.stocks : [];
  for (const item of stocks) {
    const row = document.createElement('div');
    row.className = 'ball-stock-item';
    if (item.current) row.classList.add('current');
    if (Number.isFinite(item.count) && item.count === 0) row.classList.add('empty');
    else if (Number.isFinite(item.count) && item.count <= threshold) row.classList.add('low');
    const name = document.createElement('span');
    name.textContent = `${item.name}${item.switchable ? '' : ' · leitura'}`;
    const amount = document.createElement('b');
    amount.textContent = Number.isFinite(item.count) ? item.count.toLocaleString('pt-BR') : '—';
    row.append(name, amount);
    list.append(row);
  }
  if (!stocks.length) list.innerHTML = '<div class="empty-captures">O painel foi encontrado, mas os estoques ainda não puderam ser lidos.</div>';
}

async function refresh() {
  const stats = await chrome.storage.local.get({ throws:0, reconnects:0, popups:0, lastAction:'Aguardando' });
  $('catches').textContent = stats.throws || 0;
  $('reconnects').textContent = stats.reconnects || 0;
  $('popups').textContent = stats.popups || 0;

  const tab = await getGameTab();
  if (!tab) {
    setPageStatus('bad', 'Jogo não está aberto', stats.lastAction || 'Abra o PokeIdle.io para iniciar');
    renderBallManager(null);
    return;
  }

  try {
    const res = await chrome.tabs.sendMessage(tab.id, { type:'GET_PAGE_STATUS' });
    renderBallManager(res?.ballManager);
    if (res?.disconnected) setPageStatus('warn', 'Jogo desconectado', res.session?.lastAction || 'Tentando recuperar');
    else if (!res?.enabled) setPageStatus('warn', 'Auto Helper pausado', res.session?.lastAction || 'Pausado');
    else if (res?.catchReady) setPageStatus('ok', `Pronto para capturar${res.target ? ` · ${res.target}` : ''}`, res.session?.lastAction || 'Aguardando');
    else if (res?.captureCache && !res?.manualCaptureButton) setPageStatus('warn', 'Painel achado · linha não identificada', 'Clique em “Verificar agora”; se persistir, me envie o HTML de uma linha Nome NvX');
    else setPageStatus('ok', 'Auto Helper ativo', res.session?.lastAction || stats.lastAction || 'Aguardando Pokémon próximo');
  } catch (_) {
    setPageStatus('warn', 'Recarregue a aba do jogo', 'A página ainda não recebeu o helper');
    renderBallManager(null);
  }
}

function csvEscape(value) {
  return `"${String(value ?? '').replace(/"/g, '""')}"`;
}

function exportHistory() {
  const history = Array.isArray(captures.history) ? captures.history : [];
  const lines = [ ['Data/hora','Pokemon','Shiny'].map(csvEscape).join(';') ];
  for (const item of history) lines.push([dateText(item.at), item.name, item.shiny ? 'Sim' : 'Não'].map(csvEscape).join(';'));
  const blob = new Blob(['\uFEFF', lines.join('\r\n')], { type:'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `pokeidle-io-capturas-${new Date().toISOString().slice(0,10)}.csv`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

for (const id of ids) {
  $(id).addEventListener('change', event => saveSetting(event.target).then(() => {
    if (id === 'enabled') updateQuickMasterUi(event.target.checked);
    return refresh();
  }));
}

$('quickMaster').addEventListener('click', async () => {
  const { enabled = true } = await chrome.storage.sync.get({ enabled:true });
  await setMasterEnabled(!enabled);
  await refresh();
});

$('openGame').addEventListener('click', () => chrome.runtime.sendMessage({ type:'OPEN_GAME' }));
$('scanNow').addEventListener('click', async () => {
  const tab = await getGameTab();
  if (tab?.id != null) {
    try { await chrome.tabs.sendMessage(tab.id, { type:'SCAN_NOW' }); } catch (_) {}
  }
  await refresh();
});

$('tabRecent').addEventListener('click', () => { captureTab = 'recent'; renderCaptures(); });
$('tabSpecies').addEventListener('click', () => { captureTab = 'species'; renderCaptures(); });
$('captureSearch').addEventListener('input', () => renderCaptures());
$('exportCaptures').addEventListener('click', exportHistory);
$('resetCaptures').addEventListener('click', async () => {
  if (!confirm('Apagar todas as capturas salvas pela extensão? Isso não afeta seus Pokémon dentro do jogo.')) return;
  const res = await chrome.runtime.sendMessage({ type:'RESET_CAPTURE_DATA' });
  if (res?.ok) await loadCaptures();
});

$('resetStats').addEventListener('click', async () => {
  await chrome.storage.local.set({ throws:0, reconnects:0, popups:0, lastAction:'Contadores zerados', lastActionAt:Date.now() });
  await refresh();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync') {
    if (changes.enabled) {
      const enabled = !!changes.enabled.newValue;
      $('enabled').checked = enabled;
      updateQuickMasterUi(enabled);
      refresh();
    }
    return;
  }
  if (area === 'local' && changes.captureData) {
    captures = changes.captureData.newValue || emptyData();
    renderCaptures();
  }
});

Promise.all([loadSettings(), loadCaptures()]).then(refresh);
setInterval(refresh, 3000);
