/* Detector de captura confirmada. Só grava quando há indicação positiva de sucesso. */
(() => {
  'use strict';

  const accentless = value => String(value ?? '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '');

  function sanitizeName(raw) {
    if (!raw) return '';
    const name = raw
      .replace(/^[\s:–—-]*(?:um|uma|o|a|pok[eé]mon)\s+/i, '')
      .replace(/\s*(?:[!.,;:]|\s*[|•].*)$/g, '')
      .replace(/\s+(?:com|de)\s+(?:iv|quality|qualidade|potencial|lvl|level|n[ií]vel)\b.*$/i, '')
      .replace(/\s*[([]\s*(?:shiny|iv|quality|qualidade|lv\.?|lvl|nv\.?)\b.*$/i, '')
      .replace(/\s+com\s+sucesso[.!]?$/i, '')
      .replace(/^shiny\s+/i, '')
      .replace(/\s+\b(?:shiny|normal)\b$/i, '')
      .trim();
    if (!name || name.length > 70 || name.split(/\s+/).length > 7) return '';
    if (!/^[\p{L}\p{N}]/u.test(name)) return '';
    if (/^(?:pokemon|pok[eé]mon|captura|capturado|com sucesso|sucesso|pokebola|pok[eé]bola)$/i.test(accentless(name))) return '';
    return name;
  }

  function isPositiveCapture(message) {
    const raw = String(message ?? '').replace(/\s+/g, ' ').trim();
    if (raw.length < 5 || raw.length > 300) return false;
    const plain = accentless(raw).toLowerCase();
    if (!/(captur|capture|caught)/.test(plain)) return false;
    if (/(?:nao|not|falh|failed|escap|fugiu|fugid|quebr|sem sucesso|tentativa|chance|probabilidade|status|taxa de captura)/.test(plain)) return false;
    return /(?:capturou|capturad[oa]|captura concluida|captura realizada|sucesso na captura|caught|captured)/i.test(plain);
  }

  function parseCapture(message) {
    const raw = String(message ?? '').replace(/\s+/g, ' ').trim();
    if (!isPositiveCapture(raw)) return null;

    const patterns = [
      /(?:voc[eê]\s+)?capturou\s+(?:um(?:a)?\s+)?(?:pok[eé]mon\s+)?(?<name>[\p{L}\p{N}][\p{L}\p{N} .♀♂'’\-]{1,65})(?=\s*(?:!|\s*\(|$))/iu,
      /(?:you\s+)?(?:caught|captured)\s+(?:a\s+)?(?<name>[\p{L}\p{N}][\p{L}\p{N} .♀♂'’\-]{1,65})(?=\s*(?:!|$))/iu,
      /(?<name>[\p{L}\p{N}][\p{L}\p{N} .♀♂'’\-]{1,65}?)\s+(?:foi\s+capturad[oa]|capturad[oa](?:\s+com\s+sucesso)?|was\s+caught)(?:\s|[!.,]|$)/iu,
      /(?:pok[eé]mon\s+)?capturad[oa](?:\s+com\s+sucesso)?\s*[:!–-]\s*(?<name>[\p{L}\p{N}][\p{L}\p{N} .♀♂'’\-]{1,65})(?=\s*(?:!|\s*\(|$))/iu,
      /(?:captura\s+(?:realizada|conclu[ií]da)\s+com\s+sucesso|sucesso\s+na\s+captura)\s*[:!–-]\s*(?<name>[\p{L}\p{N}][\p{L}\p{N} .♀♂'’\-]{1,65})(?=\s*(?:!|$))/iu
    ];

    for (const pattern of patterns) {
      const m = raw.match(pattern);
      if (!m) continue;
      const name = sanitizeName(m.groups?.name);
      if (!name) continue;
      return { name, shiny: /\bshiny\b/i.test(raw), message: raw };
    }
    return null;
  }

  const api = Object.freeze({ parseCapture, sanitizeName, isPositiveCapture });
  globalThis.PokeIdleCaptureParser = api;
})();
