(() => {
  'use strict';
  const headingKey = 'proximidade para capturar';
  const ownUi = el => !!el?.closest?.('#pio-auto-helper-hud,#pio-auto-helper-quick-toggle,#pio-auto-helper-toasts');
  const clean = x => String(x ?? '').replace(/\s+/g, ' ').trim();
  const norm = x => clean(x).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const text = el => clean(el?.textContent || '');
  const rect = el => el?.getBoundingClientRect?.() || null;
  const levelToken = /\b(?:nv\.?|n[ií]vel|nivel|lv\.?)\s*\d{1,3}\b/giu;
  const labelPattern = /^([\p{L}][\p{L}\p{N} .♀♂'’\-]{0,39}?)\s+(?:nv\.?|n[ií]vel|nivel|lv\.?)\s*(\d{1,3})$/iu;

  function parse(raw) {
    const s = clean(raw).replace(/^[^\p{L}]+/u,'');
    if (!s || s.length > 62 || /proximidade|capturar|automac|estoque|pok[eé]bola|painel/i.test(norm(s))) return null;
    const levels = s.match(levelToken) || [];
    if (levels.length !== 1) return null;
    const m = s.match(labelPattern);
    if (!m || !m[1].trim() || m[1].trim().split(' ').length > 5) return null;
    return { name:clean(m[1]), level:Number(m[2]), label:s };
  }

  function visible(el) {
    if (!el?.isConnected || ownUi(el) || el.hidden || el.getAttribute?.('aria-hidden') === 'true') return false;
    const r = rect(el);
    return !!r && r.width >= 1 && r.height >= 1;
  }

  function rectCandidate(node, boundary, data) {
    let best = null;
    let score = -1e4;
    for (let cur = node, depth=0; cur && cur !== boundary && depth<9; cur=cur.parentElement,depth++) {
      if (!visible(cur) || !boundary.contains(cur)) continue;
      if (text(cur).length > 100 || !parse(text(cur))) continue;
      const r=rect(cur);
      if (!r || r.width < 90 || r.width > 420 || r.height < 17 || r.height > 92) continue;
      if (cur.disabled || cur.getAttribute?.('aria-disabled')==='true') continue;
      let points = 0;
      if (r.width>=140 && r.width<=315) points+=65;
      if (r.height>=24 && r.height<=58) points+=75;
      if (cur.matches?.('button,a,[role="button"],[tabindex]')) points+=45;
      const style=getComputedStyle(cur);
      if (style.cursor==='pointer') points+=60;
      if (style.pointerEvents==='none') continue;
      if (style.backgroundColor && style.backgroundColor !== 'rgba(0, 0, 0, 0)' && style.backgroundColor !== 'transparent') points+=14;
      if (depth) points+=5;
      points+=Math.min(25, r.width/12);
      if (points>score) { best=cur; score=points; }
    }
    if (!best) return null;
    const r=rect(best);
    return {row:best, name:data.name, level:data.level, label:data.label, rect:r, score};
  }

  function collectRows(root) {
    if (!root?.isConnected) return [];
    let nodes;
    try { nodes=root.querySelectorAll('div,span,button,a,li,p,strong,b,small,[role="button"]'); }
    catch (_) { return []; }
    const out=[];
    const seen=new Set();
    let n=0;
    for (const el of nodes) {
      if (++n>550) break;
      if (!visible(el)) continue;
      const data=parse(text(el));
      if (!data) continue;
      const row=rectCandidate(el,root,data);
      if (!row) continue;
      if (seen.has(row.row)) continue;
      seen.add(row.row);
      out.push(row);
    }
    out.sort((a,b)=>a.rect.top-b.rect.top || a.rect.left-b.rect.left || b.score-a.score);
    const unique=[];
    for (const item of out) {
      if (unique.some(u=> Math.abs(u.rect.top-item.rect.top)<12 && Math.abs(u.rect.left-item.rect.left)<35)) {
        const i=unique.findIndex(u=>Math.abs(u.rect.top-item.rect.top)<12 && Math.abs(u.rect.left-item.rect.left)<35);
        if (item.score>unique[i].score) unique[i]=item;
        continue;
      }
      unique.push(item);
    }
    return unique.sort((a,b)=>a.rect.top-b.rect.top || a.rect.left-b.rect.left);
  }

  function findHeading(doc=document) {
    const list=doc.querySelectorAll('h1,h2,h3,h4,h5,strong,b,span,p,div');
    let candidate=null;
    let checked=0;
    for (const node of list) {
      if (++checked>4200) break;
      if (!visible(node) || ownUi(node)) continue;
      const s=norm(text(node));
      if (s===headingKey) return node;
      if (!candidate && s.startsWith(headingKey) && s.length < headingKey.length+17 && !/(?:nv\.?|nivel|lv\.?)/.test(s)) candidate=node;
    }
    return candidate;
  }

  function locate(doc=document) {
    const heading=findHeading(doc);
    if (!heading) return {root:null, rows:[], reason:'Título PROXIMIDADE PARA CAPTURAR não encontrado'};
    let bestRoot=null, bestRows=[], fallback=null;
    for (let cur=heading.parentElement,depth=0; cur && cur!==doc.body && depth<10;cur=cur.parentElement,depth++) {
      const r=rect(cur);
      if (!r || r.width<150 || r.width>690 || r.height<64 || r.height>850 || !visible(cur)) continue;
      if (!fallback) fallback=cur;
      const rows=collectRows(cur);
      if (rows.length) {
        bestRoot=cur;
        bestRows=rows;
        break;
      }
    }
    if (bestRoot) return {root:bestRoot,rows:bestRows,reason:bestRows.length+' linha(s) de Pokémon'};
    return {root:fallback,rows:[],reason:fallback?'Painel localizado; aguardando linhas de Pokémon':'Título localizado; painel sem geometria válida'};
  }

  function clickCandidate(row, doc=document) {
    if (!row?.row?.isConnected || !visible(row.row)) return {ok:false,reason:'Linha não está visível'};
    const r=rect(row.row);
    if (!r || r.top<0 || r.left<0 || r.bottom>innerHeight+4 || r.right>innerWidth+4) return {ok:false,reason:'Linha fora da área visível'};
    const x=Math.min(r.right-9,r.left+Math.max(20,r.width*.54));
    const y=r.top+r.height/2;
    const hit=doc.elementFromPoint(x,y);
    if (!hit || !(hit===row.row || row.row.contains(hit))) return {ok:false,reason:'Clique bloqueado por elemento sobreposto'};
    if (hit.disabled || hit.getAttribute?.('aria-disabled')==='true') return {ok:false,reason:'Controle desabilitado'};
    try { hit.click(); return {ok:true,reason:'Clique DOM enviado',target:hit}; }
    catch (e) { return {ok:false,reason:'Falha no clique DOM: '+String(e?.message||e)}; }
  }

  globalThis.PIOCaptureTargeting={parse,collectRows,findHeading,locate,clickCandidate};
})();
