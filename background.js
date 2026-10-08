const TARGET = 'https://pokeidle.io/*';
const GAME_URL = 'https://pokeidle.io/app';

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

async function updateBadge(enabled) {
  try {
    await chrome.action.setBadgeText({ text: enabled ? 'ON' : 'OFF' });
    await chrome.action.setBadgeBackgroundColor({ color: enabled ? '#218a51' : '#8a3438' });
    await chrome.action.setTitle({ title: enabled ? 'PokeIdle.io Auto Helper — ATIVO' : 'PokeIdle.io Auto Helper — PAUSADO' });
  } catch (_) {}
}

async function toggleMaster() {
  const { enabled = true } = await chrome.storage.sync.get({ enabled:true });
  const next = !enabled;
  await chrome.storage.sync.set({ enabled:next });
  await updateBadge(next);
  return next;
}

const alertCooldown = new Map();
async function notifyAlert(message) {
  const key = String(message.key || message.message || 'alert');
  const now = Date.now();
  const prior = alertCooldown.get(key) || 0;
  const cooldown = message.level === 'out' ? 60000 : 180000;
  if (now - prior < cooldown) return false;
  alertCooldown.set(key, now);
  for (const [k, stamp] of alertCooldown) {
    if (now - stamp > 3600000) alertCooldown.delete(k);
  }
  try {
    await chrome.notifications.create(`pio-${key}-${now}`, {
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: String(message.title || 'PokeIdle.io Auto Helper'),
      message: String(message.message || 'Aviso'),
      priority: message.level === 'out' ? 2 : 1
    });
    return true;
  } catch (_) {
    return false;
  }
}

async function protectTab(tabId, url) {
  if (!url || !url.startsWith('https://pokeidle.io/')) return;
  const { preventDiscard = true } = await chrome.storage.sync.get({ preventDiscard:true });
  if (!preventDiscard) return;
  try { await chrome.tabs.update(tabId, { autoDiscardable:false }); } catch (_) {}
}

async function protectExistingTabs() {
  try {
    const tabs = await chrome.tabs.query({ url:TARGET });
    for (const tab of tabs) if (tab.id != null) await protectTab(tab.id, tab.url);
  } catch (_) {}
}

chrome.runtime.onInstalled.addListener(async details => {
  const current = await chrome.storage.sync.get(DEFAULTS);
  // Migração v1.0 -> v1.1: a captura real desta interface tem ~2 s de delay.
  // Só altera automaticamente o valor antigo padrão (4050), preservando valores
  // personalizados pelo usuário.
  if (details?.reason === 'update' && Number(current.cooldownMs) === 4050) {
    current.cooldownMs = 2050;
  }
  await chrome.storage.sync.set(current);
  await updateBadge(!!current.enabled);
  await protectExistingTabs();
});

chrome.runtime.onStartup.addListener(async () => {
  const { enabled = true } = await chrome.storage.sync.get({ enabled:true });
  await updateBadge(enabled);
  await protectExistingTabs();
});

chrome.commands.onCommand.addListener(async command => {
  if (command === 'toggle-helper') await toggleMaster();
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url || changeInfo.status === 'complete') protectTab(tabId, tab.url || changeInfo.url);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync') return;
  if (changes.preventDiscard) protectExistingTabs();
  if (changes.enabled) updateBadge(!!changes.enabled.newValue);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'BALL_ALERT') {
    notifyAlert(message).then(shown => sendResponse({ ok:true, shown }), () => sendResponse({ ok:false }));
    return true;
  }

  if (message?.type === 'OPEN_GAME') {
    (async () => {
      const tabs = await chrome.tabs.query({ url:TARGET });
      const existing = tabs.find(t => t.id != null && (t.url || '').includes('/app')) || tabs.find(t => t.id != null);
      if (existing?.id != null) {
        await chrome.tabs.update(existing.id, { active:true });
        if (existing.windowId != null) {
          try { await chrome.windows.update(existing.windowId, { focused:true }); } catch (_) {}
        }
      } else {
        await chrome.tabs.create({ url:GAME_URL });
      }
      sendResponse({ ok:true });
    })();
    return true;
  }

  if (message?.type === 'TOGGLE_MASTER') {
    toggleMaster().then(enabled => sendResponse({ ok:true, enabled }), () => sendResponse({ ok:false }));
    return true;
  }
});

// Histórico de capturas: escrita serializada para não perder eventos próximos.
let captureWriteQueue = Promise.resolve();
const pendingSignature = new Map();
const MAX_HISTORY = 1000;

function serializeCaptureWrite(task) {
  const run = captureWriteQueue.then(task);
  captureWriteQueue = run.catch(error => console.warn('[PokeIdle.io Auto Helper] Falha ao gravar captura:', error));
  return run;
}

function validCaptureName(name) {
  return typeof name === 'string' && /^[\p{L}\p{N}][\p{L}\p{N} .♀♂'’\-]{0,69}$/u.test(name.trim());
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'CAPTURE_CONFIRMED') {
    const name = String(message.name || '').trim();
    if (!validCaptureName(name) || sender?.url?.startsWith('https://pokeidle.io/') !== true) {
      sendResponse({ ok:false });
      return;
    }

    const ts = Date.now();
    const tabId = sender.tab?.id ?? 'unknown';
    const signature = `${tabId}/${name.toLocaleLowerCase('pt-BR')}/${!!message.shiny}`;
    const prior = pendingSignature.get(signature) || 0;
    if (ts - prior < 2800) {
      sendResponse({ ok:true, duplicate:true });
      return;
    }
    pendingSignature.set(signature, ts);
    for (const [key, when] of pendingSignature) if (ts - when > 15000) pendingSignature.delete(key);

    serializeCaptureWrite(async () => {
      const { captureData = {} } = await chrome.storage.local.get('captureData');
      const old = captureData && typeof captureData === 'object' ? captureData : {};
      const history = Array.isArray(old.history) ? old.history : [];
      const species = old.species && typeof old.species === 'object' ? { ...old.species } : {};
      const speciesKey = name.toLocaleLowerCase('pt-BR');
      const oldSpecies = species[speciesKey] || { name, count:0, shiny:0 };
      species[speciesKey] = {
        name: oldSpecies.name || name,
        count: Number(oldSpecies.count || 0) + 1,
        shiny: Number(oldSpecies.shiny || 0) + (message.shiny ? 1 : 0)
      };
      history.unshift({ name, shiny:!!message.shiny, at:ts });
      const next = {
        total: Number(old.total || 0) + 1,
        species,
        history: history.slice(0, MAX_HISTORY),
        lastCaptureAt: ts
      };
      await chrome.storage.local.set({ captureData:next });
      return next.total;
    }).then(total => sendResponse({ ok:true, total }), () => sendResponse({ ok:false }));
    return true;
  }

  if (message?.type === 'RESET_CAPTURE_DATA') {
    serializeCaptureWrite(async () => {
      await chrome.storage.local.set({ captureData:{ total:0, species:{}, history:[], lastCaptureAt:0 } });
    }).then(() => sendResponse({ ok:true }), () => sendResponse({ ok:false }));
    return true;
  }
});

chrome.storage.sync.get({ enabled:true }).then(({ enabled }) => updateBadge(!!enabled)).catch(() => {});
