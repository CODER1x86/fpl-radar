// FPL Radar v2 tools: Squad Sync (screenshot), What-If review, live gameweek, price pressure, Ask Radar.
// Uses the globals of app.js (D, PJ, TEAM, TEAMDATA, PROXY, prox, t, esc, when, f1, getSync, setSync).

// ------------------------------------------------------------------ shared: points with FPL auto-subs
const RV = (() => {
  const valid = (xi, pos) => { const c = { 1: 0, 2: 0, 3: 0, 4: 0 }; xi.forEach(i => c[pos[i]] = (c[pos[i]] || 0) + 1); return c[1] === 1 && c[2] >= 3 && c[3] >= 2 && c[4] >= 1; };
  // o: {xi, bench (GK first), cap, vice, chip, live:{id:{p,m}}, pos:{id:1..4}, done:id=>bool (match finished)}
  function scoreGW(o) {
    const L = o.live || {}, pts = i => (L[i] || {}).p || 0, played = i => ((L[i] || {}).m || 0) > 0, fin = o.done || (() => true);
    let xi = o.xi.slice(); const subs = [];
    if (o.chip === 'bboost') xi = o.xi.concat(o.bench);
    else {
      const bench = o.bench.slice();
      for (let k = 0; k < xi.length; k++) {
        const out = xi[k]; if (played(out) || !fin(out)) continue;
        for (let j = 0; j < bench.length; j++) {
          const inn = bench[j]; if (inn == null || !played(inn)) continue;
          const gk = o.pos[out] === 1; if (gk !== (o.pos[inn] === 1)) continue;
          const nx = xi.slice(); nx[k] = inn; if (!valid(nx, o.pos)) continue;
          xi = nx; bench[j] = null; subs.push([out, inn]); break;
        }
      }
    }
    let cap = o.cap; const mult = o.chip === '3xc' ? 3 : 2;
    if (cap != null && !played(cap) && fin(cap)) cap = (o.vice != null && played(o.vice) && xi.includes(o.vice)) ? o.vice : null;
    const mul = {}; xi.forEach(i => mul[i] = i === cap ? mult : 1);
    return { total: xi.reduce((s, i) => s + pts(i) * mul[i], 0), xi, subs, cap, mul };
  }
  // What-if over finished gameweeks. A = keep the squad of GW `from` (no transfers after it); B = today's squad.
  function compare(o) { // o: {mode, from, gws, base:{xi,bench,cap,vice}, picks:{g:picks}, live:{g:map}, hist:{g:row}, chips:{g:name}, pos}
    const set = new Set(o.base.xi.concat(o.base.bench)), out = [];
    for (const g of o.gws) {
      const h = o.hist[g]; if (!h) continue;
      const actual = h.points - (h.event_transfers_cost || 0), chip = o.chips[g];
      let alt;
      if (chip === 'freehit') alt = h.points;
      else {
        let cap = o.base.cap, vice = o.base.vice;
        if (o.mode === 'A' && o.picks[g]) {
          const ac = (o.picks[g].picks.find(x => x.is_captain) || {}).element, av = (o.picks[g].picks.find(x => x.is_vice_captain) || {}).element;
          cap = [ac, av, o.base.cap].find(x => set.has(x));
          vice = [av, o.base.vice, o.base.cap].find(x => set.has(x) && x !== cap);
        }
        alt = scoreGW({ ...o.base, cap, vice, chip: chip === 'bboost' || chip === '3xc' ? chip : null, live: o.live[g], pos: o.pos }).total;
      }
      out.push({ g, actual, alt, diff: actual - alt, hits: h.event_transfers_cost || 0 });
    }
    return out;
  }
  function ledger(transfers, from, last, live) {
    const sumPts = (i, a) => { let s = 0; for (let g = a; g <= last; g++) s += ((live[g] || {})[i] || {}).p || 0; return s; };
    return (transfers || []).filter(x => x.event > from && x.event <= last).map(x => ({ g: x.event, out: x.element_out, in: x.element_in, v: sumPts(x.element_in, x.event) - sumPts(x.element_out, x.event) }))
      .sort((a, b) => b.g - a.g || b.v - a.v);
  }
  const liveMap = lv => { const m = {}; (lv.elements || []).forEach(e => m[e.id] = { p: e.stats.total_points, m: e.stats.minutes }); return m; };
  const lineup = pk => { const s = pk.picks.slice().sort((a, b) => a.position - b.position);
    return { xi: s.slice(0, 11).map(x => x.element), bench: s.slice(11).map(x => x.element), cap: (s.find(x => x.is_captain) || {}).element, vice: (s.find(x => x.is_vice_captain) || {}).element }; };
  return { scoreGW, compare, ledger, liveMap, lineup, valid };
})();

// ------------------------------------------------------------------ OCR name matching for Squad Sync
const SYNC = (() => {
  const norm = s => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z]/g, '');
  function lev(a, b) { if (Math.abs(a.length - b.length) > 1) return 9; const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
    for (let j = 1; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    return d[a.length][b.length]; }
  // P: {id:{n,posn,own}}; prior: current squad ids. Returns {squad:[15 ids], seen:Set}
  function match(text, P, prior) {
    const words = String(text).split(/[\s|,:;()]+/).map(norm).filter(w => w.length >= 3), grams = new Set();
    words.forEach((w, i) => { grams.add(w); if (words[i + 1]) grams.add(w + words[i + 1]); });
    const byKey = {}; Object.values(P).forEach(p => { const k = norm(p.n); if (k.length >= 3) (byKey[k] = byKey[k] || []).push(p); });
    const pri = new Set(prior), hits = new Map();
    const add = (k, exact) => { const c = byKey[k].slice().sort((a, b) => (pri.has(b.id) - pri.has(a.id)) || (b.own - a.own))[0]; if (!hits.has(c.id)) hits.set(c.id, { p: c, exact }); };
    for (const g of grams) if (byKey[g]) add(g, true);
    for (const k in byKey) { if (k.length < 6 || [...hits.values()].some(h => norm(h.p.n) === k)) continue;
      for (const g of grams) if (lev(g, k) <= 1) { add(k, false); break; } }
    const quota = { 1: 2, 2: 5, 3: 5, 4: 3 }, got = { 1: [], 2: [], 3: [], 4: [] };
    [...hits.values()].sort((a, b) => (pri.has(b.p.id) - pri.has(a.p.id)) || (b.exact - a.exact) || (b.p.own - a.p.own))
      .forEach(h => { if (got[h.p.posn].length < quota[h.p.posn]) got[h.p.posn].push(h.p.id); });
    const seen = new Set([].concat(got[1], got[2], got[3], got[4]));
    for (const i of prior) { const q = P[i] && P[i].posn; if (q && got[q].length < quota[q] && !seen.has(i) && !got[q].includes(i)) got[q].push(i); }
    return { squad: [].concat(got[1], got[2], got[3], got[4]), seen };
  }
  function money(text) { const m = String(text).match(/(?:money\s*remaining|in\s*the\s*bank|bank|itb)[^0-9\-]{0,12}(-?\d{1,3}\.\d)/i); return m ? +m[1] : null; }
  function freeT(text) { const m = String(text).match(/free\s*transfers?[^0-9]{0,12}(\d)/i); return m ? +m[1] : null; }
  return { match, money, freeT, norm };
})();

if (typeof module !== 'undefined') { module.exports = { RV, SYNC }; }
else {
  // ---------------------------------------------------------------- browser wiring
  let _pj = null, _all = {};
  const ALLP = () => { if (PJ && PJ !== _pj) { _pj = PJ; _all = FREngine.players(PJ); } return PJ ? _all : {}; };
  const nm = i => { const p = (D && D.byId && D.byId[i]) || ALLP()[i]; return p ? p.n : '#' + i; };
  const signed = v => (v > 0 ? '+' : '') + v;
  const posOf = P => { const o = {}; for (const id in P) o[id] = P[id].posn; return o; };
  const lastFinished = () => { const G = D.gw || {}; return G.current ? (G.current_finished ? G.current : G.current - 1) : 0; };

  // ---- Squad Sync -------------------------------------------------------------------------
  const SS = { reasons: new Set(), res: null, busy: false, msg: '' };
  function renderSync() {
    const box = $('#sync'); if (!box || !D) return;
    const act = getSync(), pub = TEAMDATA && TEAMDATA.picks ? TEAMDATA.picks.picks.map(x => x.element) : [];
    let h = '';
    if (act) h += `<div class="card"><div class="big-line ok">✓ ${t('syncActive', { t: when(act.ts) })}</div>${(act.reasons || []).map(r => `<span class="tag">${t(r)}</span> `).join('')}<button class="btn sec" id="sy-clear">${t('syncClear')}</button></div>`;
    h += `<div class="card"><h2>${t('syncTitle')}</h2><p class="small">${t('syncIntro')}</p>
      <div class="small" style="font-weight:700">${t('syncWhy')}</div><div class="rsn">${['rPrice', 'rPending', 'rCant', 'rChip', 'rOther'].map(r => `<button data-r="${r}" class="${SS.reasons.has(r) ? 'on' : ''}">${t(r)}</button>`).join('')}</div>
      <label class="btn file">${t('syncPick')}<input type="file" accept="image/*" id="sy-file"></label>
      <div id="sy-prog" class="small mute" style="margin-top:8px">${esc(SS.msg)}</div>
      <p class="mute small">${t('syncPrivacy')}</p></div>`;
    if (SS.res) {
      const P = ALLP(), r = SS.res, by = { 1: [], 2: [], 3: [], 4: [] }; r.squad.forEach(i => P[i] && by[P[i].posn].push(i));
      const opts = (q, sel) => Object.values(P).filter(p => p.posn === q).sort((a, b) => a.n.localeCompare(b.n)).map(p => `<option value="${p.id}" ${p.id === sel ? 'selected' : ''}>${esc(p.n)} · ${esc(p.t)} · £${p.c}</option>`).join('');
      const PN = { 1: 'GKP', 2: 'DEF', 3: 'MID', 4: 'FWD' };
      const notSeen = r.squad.filter(i => !r.seen.has(i)).length;
      h += `<div class="card"><h2>${t('syncFound', { n: r.seen.size })}</h2>${notSeen ? `<p class="small warn">${t('syncCheck')}</p>` : ''}
        <div class="small mute" style="margin-bottom:4px">${t('syncAll')}</div>
        ${[1, 2, 3, 4].map(q => by[q].map(i => `<div class="srow"><span class="pos">${PN[q]}</span><select data-i="${i}" aria-label="${PN[q]}">${opts(q, i)}</select><span class="tag ${r.seen.has(i) ? 'ok' : 'warn'}">${t(r.seen.has(i) ? 'seen' : 'kept')}</span></div>`).join('')).join('')}
        <div class="two" style="margin-top:10px"><label class="small">${t('syncBank')}<input id="sy-bank" inputmode="decimal" value="${r.bank ?? ''}"></label><label class="small">${t('syncFT')}<input id="sy-ft" inputmode="numeric" value="${r.ft ?? ''}"></label></div>
        <div class="small" style="font-weight:700;margin-top:12px">${t('syncDiff')}</div><div id="sy-diff" class="small"></div>
        <div class="bad small" id="sy-err"></div><button class="btn" id="sy-use">${t('syncUse')}</button></div>`;
    }
    box.innerHTML = h;
    box.querySelectorAll('[data-r]').forEach(b => b.onclick = () => { SS.reasons.has(b.dataset.r) ? SS.reasons.delete(b.dataset.r) : SS.reasons.add(b.dataset.r); b.classList.toggle('on') });
    const clr = $('#sy-clear'); if (clr) clr.onclick = () => { SS.res = null; setSync(null) };
    $('#sy-file').onchange = e => { const f = e.target.files[0]; if (f) readShot(f, pub) };
    if (SS.res) {
      const cur = () => [...box.querySelectorAll('select[data-i]')].map(s => +s.value);
      const diff = () => { const now = cur(), outs = pub.filter(i => !now.includes(i)), ins = now.filter(i => !pub.includes(i));
        $('#sy-diff').innerHTML = outs.length ? outs.map((o, k) => `<div class="row"><span class="bad">▼ ${esc(nm(o))}</span><span class="ok">▲ ${esc(nm(ins[k]))}</span></div>`).join('') : `<span class="mute">${t('syncNone')}</span>`; };
      box.querySelectorAll('select[data-i]').forEach(s => s.onchange = diff); diff();
      $('#sy-use').onclick = () => { const sq = cur(), P = ALLP(), c = { 1: 0, 2: 0, 3: 0, 4: 0 }; sq.forEach(i => c[P[i].posn]++);
        if (new Set(sq).size !== 15 || c[1] !== 2 || c[2] !== 5 || c[3] !== 5 || c[4] !== 3) { $('#sy-err').textContent = t('syncBad'); return; }
        const bank = parseFloat($('#sy-bank').value), ft = parseInt($('#sy-ft').value, 10);
        setSync({ ts: new Date().toISOString(), gw: D.gw.next, squad: sq, bank: isFinite(bank) ? bank : (TEAMDATA.picks.entry_history.bank / 10), ft: isFinite(ft) ? ft : null, reasons: [...SS.reasons] });
        SS.res = null; go('planner', 'plan'); };
    }
  }
  function loadTess() { return window.Tesseract ? Promise.resolve() : new Promise((res, rej) => { const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js'; s.onload = res; s.onerror = () => rej(new Error('download failed')); document.head.appendChild(s); }); }
  async function prep(file) { // grayscale + 2x upscale helps the reader with small white-on-dark labels
    const img = await createImageBitmap(file), k = img.width < 1400 ? 2 : 1, c = document.createElement('canvas');
    c.width = img.width * k; c.height = img.height * k; const x = c.getContext('2d'); x.drawImage(img, 0, 0, c.width, c.height);
    const d = x.getImageData(0, 0, c.width, c.height), a = d.data;
    for (let i = 0; i < a.length; i += 4) { const g = 0.299 * a[i] + 0.587 * a[i + 1] + 0.114 * a[i + 2]; a[i] = a[i + 1] = a[i + 2] = g; }
    x.putImageData(d, 0, 0); return c; }
  async function readShot(file, prior) {
    if (SS.busy) return; SS.busy = true; const pg = p => { SS.msg = t('syncReading', { p: Math.round(p * 100) }); const e = $('#sy-prog'); if (e) e.textContent = SS.msg; };
    try { pg(0); await loadTess();
      const w = await Tesseract.createWorker('eng', 1, { logger: m => { if (m.status === 'recognizing text') pg(m.progress) } });
      const src = await prep(file).catch(() => file);
      const { data } = await w.recognize(src); await w.terminate();
      const P = ALLP(), r = SYNC.match(data.text, P, prior);
      r.bank = SYNC.money(data.text) ?? (TEAMDATA && TEAMDATA.picks ? TEAMDATA.picks.entry_history.bank / 10 : null);
      r.ft = SYNC.freeT(data.text) ?? (D.projection ? D.projection.free_transfers_est : null);
      SS.res = r; SS.msg = '';
    } catch (e) { SS.msg = t('syncLoadErr', { e: e.message || e }); }
    SS.busy = false; renderSync(); }

  // ---- What-If review --------------------------------------------------------------------
  const RS = { mode: 'A', from: null, out: '' };
  function renderReview() {
    const box = $('#review'); if (!box || !D || !TEAMDATA || !TEAMDATA.history) return;
    const last = lastFinished(), lo = 1, hi = RS.mode === 'A' ? last - 1 : last;
    if (RS.from == null || RS.from > hi) RS.from = Math.max(1, last - 5);
    box.innerHTML = `<div class="card"><h2>${t('rvTitle')}</h2>
      <div class="rsn"><button data-m="A" class="${RS.mode === 'A' ? 'on' : ''}">${t('rvModeA')}</button><button data-m="B" class="${RS.mode === 'B' ? 'on' : ''}">${t('rvModeB')}</button></div>
      <div class="two"><label class="small">${t('rvFrom')}<select id="rv-from">${Array.from({ length: Math.max(0, hi - lo + 1) }, (_, k) => lo + k).map(g => `<option value="${g}" ${g === RS.from ? 'selected' : ''}>GW${g}</option>`).join('')}</select></label>
      <button class="btn" id="rv-run" ${hi < lo ? 'disabled' : ''}>${t('rvRun')}</button></div></div><div id="rv-out">${RS.out}</div>`;
    box.querySelectorAll('[data-m]').forEach(b => b.onclick = () => { RS.mode = b.dataset.m; RS.out = ''; renderReview() });
    $('#rv-from').onchange = e => { RS.from = +e.target.value };
    $('#rv-run').onclick = runReview;
  }
  async function runReview() {
    const out = $('#rv-out'), last = lastFinished(), from = RS.from, mode = RS.mode, H = TEAMDATA.history;
    const gws = []; for (let g = mode === 'A' ? from + 1 : from; g <= last; g++) gws.push(g);
    if (!gws.length) { out.innerHTML = `<div class="card empty">${t('rvNone')}</div>`; return; }
    const picks = {}, live = {};
    try {
      for (const g of (mode === 'A' ? [from] : []).concat(gws)) {
        out.innerHTML = `<div class="card empty">${t('rvLoading', { g })}</div>`;
        if (!picks[g]) picks[g] = await prox(`/entry/${TEAM}/event/${g}/picks/`);
        if (gws.includes(g) && !live[g]) live[g] = RV.liveMap(await prox(`/event/${g}/live/`));
      }
    } catch (e) { out.innerHTML = `<div class="card empty">${t('nodata')}</div>`; return; }
    const P = ALLP(), base = RV.lineup(mode === 'A' ? picks[from] : TEAMDATA.picks), hist = {}, chips = {};
    H.current.forEach(r => hist[r.event] = r); (H.chips || []).forEach(c => chips[c.event] = c.name);
    const rows = RV.compare({ mode, from, gws, base, picks, live, hist, chips, pos: posOf(P) });
    const A = rows.reduce((s, r) => s + r.actual, 0), B = rows.reduce((s, r) => s + r.alt, 0), diff = A - B, won = rows.filter(r => r.diff > 0).length;
    const mx = Math.max(4, ...rows.map(r => Math.abs(r.diff)));
    let h = `<div class="card"><div class="small" style="font-weight:700">${t(mode === 'A' ? 'rvSumA' : 'rvSumB', { v: signed(diff), a: gws[0], b: last })}</div>
      <div class="h2h"><div><span class="small mute">${t('rvActual')}</span><b class="num">${A}</b></div><span class="vs ${diff >= 0 ? 'pos' : 'neg'} num">${signed(diff)}</span><div><span class="small mute">${t('rvAlt')}</span><b class="num">${B}</b></div></div>
      <div class="small mute" style="text-align:center">${t('rvWon', { w: won, n: rows.length })}</div>
      <div class="dbars" role="img" aria-label="${t('rvTitle')}">${rows.map(r => { const hgt = Math.round(Math.abs(r.diff) / mx * 50);
        return `<div title="GW${r.g}: ${r.actual} vs ${r.alt}"><span class="u" style="height:${r.diff > 0 ? hgt : 0}%"></span><span class="d" style="height:${r.diff < 0 ? hgt : 0}%"></span></div>`; }).join('')}</div>
      <div class="dlab">${rows.map(r => `<span>${r.g}</span>`).join('')}</div>
      <div class="key"><span><i style="background:#1f5fbf"></i>${t('helped')}</span><span><i style="background:#d9741c"></i>${t('hurt')}</span></div>
      <div class="tbl" style="margin-top:8px"><table><tr><th>GW</th><th>${t('rvActual')}</th><th>${t('rvAlt')}</th><th></th><th>${t('hits')}</th></tr>${rows.map(r => `<tr><td>${r.g}</td><td class="num">${r.actual}</td><td class="num">${r.alt}</td><td class="num ${r.diff >= 0 ? 'pos-v' : 'neg-v'}">${signed(r.diff)}</td><td class="num">${r.hits ? '-' + r.hits : ''}</td></tr>`).join('')}</table></div></div>`;
    if (mode === 'A') { const L = RV.ledger(TEAMDATA.transfers, from, last, live);
      if (L.length) h += `<div class="card"><h2>${t('rvLedger')}</h2>${L.slice(0, 20).map(x => `<div class="move"><span class="mn num">${x.g}</span><span>${esc(nm(x.out))} → <b>${esc(nm(x.in))}</b></span><span class="g num ${x.v >= 0 ? 'pos-v' : 'neg-v'}">${signed(x.v)}</span></div>`).join('')}</div>`; }
    h += `<p class="mute small">${t('rvRules')}</p>`;
    RS.out = h; out.innerHTML = h;
  }

  // ---- Live gameweek ---------------------------------------------------------------------
  let LV_T = 0;
  async function renderLive(force) {
    const box = $('#live'); if (!box || !D || !TEAM) return;
    const G = D.gw || {}, cur = G.current; if (!cur) { box.innerHTML = `<div class="card empty">${t('lvNone')}</div>`; return; }
    if (!force && Date.now() - LV_T < 60000 && box.innerHTML) return; LV_T = Date.now();
    let pk, lv, fx;
    try { [pk, lv, fx] = await Promise.all([prox(`/entry/${TEAM}/event/${cur}/picks/`), prox(`/event/${cur}/live/`), prox('/fixtures/').catch(() => [])]); }
    catch (e) { box.innerHTML = `<div class="card empty">${t('nodata')}</div>`; return; }
    const P = ALLP(), teams = (PJ && PJ.teams) || {}, doneT = {};
    (fx || []).filter(f => f.event === cur).forEach(f => [f.team_h, f.team_a].forEach(tm => { const k = teams[tm] || tm; doneT[k] = (doneT[k] ?? true) && !!(f.finished || f.finished_provisional); }));
    const L = RV.liveMap(lv), base = RV.lineup(pk), chip = pk.active_chip;
    const r = RV.scoreGW({ ...base, chip, live: L, pos: posOf(P), done: i => doneT[P[i] && P[i].t] !== false });
    const hit = (pk.entry_history || {}).event_transfers_cost || 0, subIn = new Set(r.subs.map(s => s[1])), subOut = new Set(r.subs.map(s => s[0]));
    const all = base.xi.concat(base.bench);
    const row = i => { const p = L[i] || { p: 0, m: 0 }, on = r.xi.includes(i), mul = r.mul[i] || 0;
      return `<div class="lv ${on ? '' : 'out'}"><span class="n">${esc(nm(i))}${i === r.cap ? ' <span class="pill">C</span>' : ''}${subIn.has(i) ? ` <span class="tag ok">${t('subIn')}</span>` : ''}${subOut.has(i) ? ` <span class="tag warn">${t('subOut')}</span>` : ''}</span><span class="m">${p.m}${t('lvMin')}</span><span class="p">${on ? p.p * mul : p.p}</span></div>`; };
    let h = `<div class="card hero"><div class="mute small">${t(G.current_finished ? 'lvFinal' : 'lvTitle', { g: cur })}${chip ? ' · ' + (CHIPN[chip] || chip) : ''}</div>
      <div class="xp num">${r.total - hit}<small> ${t('lvPts')}</small></div><div class="small mute">${hit ? '−' + hit + ' ' + t('hits') + ' · ' : ''}${t('lvSub')}</div></div>
      <div class="card">${all.map(row).join('')}</div>`;
    const E = D.projection && D.projection.elite;
    if (E && E.gw === cur) { const eo = {}; E.players.forEach(x => eo[x.id] = x.eo);
      const ids = new Set(r.xi.concat(E.players.filter(x => x.eo >= 10).map(x => x.id)));
      const mv = [...ids].map(i => ({ i, p: (L[i] || {}).p || 0, eo: eo[i] || 0, v: ((r.mul[i] || 0) * 100 - (eo[i] || 0)) / 100 * ((L[i] || {}).p || 0) }))
        .filter(x => x.p).sort((a, b) => Math.abs(b.v) - Math.abs(a.v)).slice(0, 6);
      if (mv.length) h += `<div class="card"><h2>${t('lvMovers')}</h2>${mv.map(x => `<div class="lv"><span class="n">${esc(nm(x.i))}</span><span class="m" style="width:auto">${x.p} pts · EO ${Math.round(x.eo)}%</span><span class="p ${x.v >= 0 ? 'pos-v' : 'neg-v'}">${signed(+x.v.toFixed(1))}</span></div>`).join('')}</div>`; }
    box.innerHTML = h;
  }

  // ---- Price pressure ----------------------------------------------------------------------
  function renderPressure() {
    const box = $('#pressure'); if (!box || !PJ || !D || !D.projection) return;
    const P = Object.values(ALLP()).filter(p => p.ni != null); if (!P.length) { box.innerHTML = `<div class="empty">${t('none')}</div>`; return; }
    const mine = new Set(D.projection.squad), mx = Math.max(...P.map(p => Math.abs(p.ni)), 1);
    const row = p => `<div class="lv"><span class="n">${esc(p.n)} <span class="mute small">${esc(p.t)} · £${p.c}</span></span><span class="pbar"><i style="width:${Math.round(Math.abs(p.ni) / mx * 100)}%;background:${p.ni >= 0 ? '#1f5fbf' : '#d9741c'}"></i></span><span class="p ${p.ni >= 0 ? 'pos-v' : 'neg-v'}" style="width:72px">${p.ni >= 0 ? '+' : ''}${fmtN(p.ni)}</span></div>`;
    const sorted = P.slice().sort((a, b) => b.ni - a.ni);
    box.innerHTML = `<div class="small" style="font-weight:700">${t('prMine')}</div>${P.filter(p => mine.has(p.id)).sort((a, b) => b.ni - a.ni).map(row).join('')}
      <div class="small" style="font-weight:700;margin-top:12px">${t('prRise')}</div>${sorted.slice(0, 8).map(row).join('')}
      <div class="small" style="font-weight:700;margin-top:12px">${t('prFall')}</div>${sorted.slice(-8).reverse().map(row).join('')}`;
  }

  // ---- Ask Radar (free Workers AI through the proxy) -----------------------------------------
  function askContext() {
    const P = D.projection, by = D.byId, g = P.gws || [], pl = P.plan || { moves: [] }, L = (pl.lineups || [])[0] || P.lineups[0] || {};
    const line = p => `${p.n} (${p.t} ${p.pos} £${p.c}${p.st !== 'a' ? ` status ${p.st}${p.ch != null ? ' ' + p.ch + '%' : ''}` : ''}) xP GW${g[0]} ${f1(p.b[0])}, next${g.length} ${f1(p.b.reduce((s, x) => s + x, 0))}${p.news ? ' — ' + p.news : ''}`;
    const sq = (P.squad || []).map(i => by[i]).filter(Boolean);
    const alts = ['GKP', 'DEF', 'MID', 'FWD'].map(pos => pos + ': ' + Object.values(by).filter(p => p.pos === pos && !(P.squad || []).includes(p.id) && p.b).sort((a, b) => (b.b[0] + b.b[1] + b.b[2]) - (a.b[0] + a.b[1] + a.b[2])).slice(0, 6).map(line).join('; ')).join('\n');
    const C = ((P.chips || {}).chips || []).map(c => `${c.name}: ${c.available ? c.verdict + (c.best_gw ? ' best GW' + c.best_gw : '') : 'used'}`).join('; ');
    return [`Gameweeks projected: ${g.join(', ')}. Deadline GW${(D.gw || {}).next}: ${(D.gw || {}).next_deadline}. Bank £${P.bank}m, free transfers ${P.free_transfers_est}.`,
      `MY SQUAD:\n${sq.map(line).join('\n')}`, `PLAN: transfers ${pl.moves.map(m => m.out_n + ' -> ' + m.in_n).join(', ') || 'none (roll)'}; captain ${L.captain_n || '?'}, vice ${L.vice_n || '?'}; XI ${(L.xi_n || []).join(', ')}.`,
      `CHIPS: ${C}`, `BEST ALTERNATIVES (by xP next 3 GWs):\n${alts}`].join('\n\n');
  }
  async function ask(e) {
    e.preventDefault(); const q = $('#ask-q').value.trim(), a = $('#ask-a'); if (!q || !D || !D.projection) return;
    if (!PROXY) { a.textContent = t('askErr', { e: 'no proxy' }); return; }
    a.textContent = t('askWait');
    try { const r = await fetch(PROXY + '/ai', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ q, context: askContext() }) });
      const j = await r.json(); a.textContent = j.answer || t('askErr', { e: j.error || r.status }); }
    catch (err) { a.textContent = t('askErr', { e: err.message || err }); }
  }
  $('#ask-form').addEventListener('submit', ask);
  $('#ask-q').placeholder = t('askPh');

  // ---- hooks called by app.js --------------------------------------------------------------
  window.onPane = (view, p) => {
    if (!D || !D.projection) return;
    if (view === 'squad' && p === 'sync') renderSync();
    if (view === 'squad' && p === 'review') renderReview();
    if (view === 'live' && p === 'live') renderLive();
    if (view === 'explore' && p === 'prices') renderPressure();
  };
  window.onData = () => {
    $('#ask-q').placeholder = t('askPh');
    renderPressure();
    const on = document.querySelector('.view.on'); if (!on) return;
    const v = on.id.slice(2), b = document.querySelector(`[data-seg="${v}"] button.on`); if (b) window.onPane(v, b.dataset.p);
    if (v === 'live') renderLive(true);
  };
}
