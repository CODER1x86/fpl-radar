// FPL Radar Cup: your FPL Cup / league-cup ties, a head-to-head projection against the opponent, and transfers +
// captain picks balanced between beating that opponent this gameweek and your season-long expected points.
// Data: /entry/{id}/ (leagues.cup + league cups) and the opponent's public picks/history, through the read-only proxy.

// ------------------------------------------------------------------ pure model (tested in tests/js/cup.test.js)
const CUP = (() => {
  // standard normal CDF (Abramowitz–Stegun 7.1.26)
  function phi(z) { const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2), y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z / 2);
    return z >= 0 ? (1 + y) / 2 : (1 - y) / 2; }
  // expected points and variance of one player in gameweek index k. Uses the model's P90 for the next GW when present,
  // otherwise an over-dispersed Poisson-like spread (FPL returns are lumpy: blanks plus occasional hauls).
  function pv(p, k) { const m = p && p.b ? p.b[k] || 0 : 0; let v = Math.max(1, 2 * m);
    if (k === 0 && p && p.u1 > m) v = Math.max(v, ((p.u1 - m) / 1.2816) ** 2); return [m, v]; }
  // multipliers for a lineup: XI x1, captain x2 (x3 with Triple Captain), Bench Boost counts the bench
  function mults(L, chip) { const o = {}; L.xi.forEach(i => o[i] = 1); if (chip === 'bboost') (L.bench || []).forEach(i => o[i] = 1);
    if (L.captain != null) o[L.captain] = chip === '3xc' ? 3 : 2; return o; }
  // Head to head: only what DIFFERS between the two teams decides the tie. A player both of you start with the
  // same multiplier cancels out exactly. hits = points already deducted (cup scores are after hits).
  function h2h(me, opp, P, k, o = {}) {
    const A = mults(me, o.myChip), B = mults(opp, o.oppChip), ids = new Set([...Object.keys(A), ...Object.keys(B)].map(Number));
    let mu = -(o.myHits || 0) + (o.oppHits || 0), va = 0; const swing = [];
    for (const i of ids) { const d = (A[i] || 0) - (B[i] || 0); if (!d) continue; const [m, v] = pv(P[i], k); mu += d * m; va += d * d * v; swing.push({ id: i, d, a: A[i] || 0, b: B[i] || 0, xp: +(d * m).toFixed(2) }); }
    const sd = Math.sqrt(va + 4); // + a little noise for auto-subs / minutes surprises
    swing.sort((a, b) => Math.abs(b.xp) - Math.abs(a.xp));
    const myXP = Object.entries(A).reduce((s, [i, m]) => s + m * pv(P[i], k)[0], 0) - (o.myHits || 0);
    const oppXP = Object.entries(B).reduce((s, [i, m]) => s + m * pv(P[i], k)[0], 0) - (o.oppHits || 0);
    return { diff: +mu.toFixed(2), sd: +sd.toFixed(2), win: phi(mu / sd), myXP: +myXP.toFixed(1), oppXP: +oppXP.toFixed(1), swing };
  }
  // Captain choice in a knockout: favourites should cover the opponent's captain, underdogs should differ.
  function captains(me, opp, P, k, o = {}) {
    return me.xi.filter(i => P[i]).map(c => ({ id: c, xp: pv(P[c], k)[0], win: h2h({ ...me, captain: c }, opp, P, k, o).win }))
      .sort((a, b) => b.win - a.win);
  }
  // Single transfers scored two ways: change in cup win probability (this GW) and change in season xP (weighted
  // horizon). w = weight on the cup (0 = season only, 1 = cup only). One win-% point is valued at `rate` xP.
  // ctx: {squad, bank, sell:{id:price}, k, W:[weights], opp, oppOpts, bestXI, ft, w, rate, maxOut}
  function transfers(ctx, P) {
    const { squad, bank, sell, k, W, opp, bestXI } = ctx, w = ctx.w ?? 0.5, rate = ctx.rate ?? 0.5, hit = (ctx.ft ?? 1) >= 1 ? 0 : 4;
    const lineup = ids => { const r = bestXI(ids, P, k); return r ? { xi: r.xi, bench: r.bench, captain: r.captain } : null; };
    const season = ids => W.reduce((s, wt, g) => { const r = bestXI(ids, P, g); return s + wt * (r ? r.xp : 0); }, 0);
    const L0 = lineup(squad); if (!L0) return { base: null, moves: [] };
    const base = h2h(L0, opp, P, k, ctx.oppOpts), s0 = season(squad), clubs = {};
    squad.forEach(i => { const t = (P[i] || {}).t; clubs[t] = (clubs[t] || 0) + 1; });
    const pool = Object.values(P).filter(p => p.b && (p.b[k] || 0) >= 1.5 && !['i', 's', 'u', 'n'].includes(p.st) && !squad.includes(p.id));
    const moves = [];
    for (const o of squad) { const po = P[o]; if (!po) continue; const budget = bank + (sell[o] ?? po.c);
      const cands = pool.filter(p => p.posn === po.posn && p.c <= budget + 1e-9 && ((clubs[p.t] || 0) - (po.t === p.t ? 1 : 0)) < 3)
        .sort((a, b) => (b.b[k] || 0) - (a.b[k] || 0)).slice(0, ctx.maxIn || 25);
      for (const p of cands) { const sq = squad.map(x => x === o ? p.id : x), L = lineup(sq); if (!L) continue;
        const r = h2h(L, opp, P, k, { ...ctx.oppOpts, myHits: hit });
        const dWin = r.win - base.win, dSeason = season(sq) - s0 - hit;
        moves.push({ out: o, in: p.id, dWin, dSeason: +dSeason.toFixed(2), win: r.win, score: +((1 - w) * dSeason + w * dWin * 100 * rate).toFixed(2), hit }); } }
    moves.sort((a, b) => b.score - a.score);
    return { base, moves, seasonBase: +s0.toFixed(1) };
  }
  // all cup ties found on the public entry: overall FPL Cup + any league cups
  function ties(entry, myId) {
    const L = (entry && entry.leagues) || {}, raw = [].concat((L.cup && L.cup.matches) || [], L.cup_matches || []), seen = new Set(), out = [];
    for (const m of raw) { if (!m || seen.has(m.id)) continue; seen.add(m.id);
      const me1 = m.entry_1_entry === myId, oppId = me1 ? m.entry_2_entry : m.entry_1_entry;
      out.push({ id: m.id, event: m.event, league: m.league, round: m.knockout_name || '', bye: !!m.is_bye || !oppId,
        opp: oppId, oppName: me1 ? m.entry_2_name : m.entry_1_name, oppPlayer: me1 ? m.entry_2_player_name : m.entry_1_player_name,
        myPts: me1 ? m.entry_1_points : m.entry_2_points, oppPts: me1 ? m.entry_2_points : m.entry_1_points,
        winner: m.winner, won: m.winner == null ? null : m.winner === myId, tiebreak: m.tiebreak || null }); }
    out.sort((a, b) => b.event - a.event);
    const st = (L.cup && L.cup.status) || {};
    const leagueCups = ((L.classic || []).filter(l => l.has_cup || l.cup_league)).map(l => ({ name: l.name, cup: l.cup_league, qualified: l.cup_qualified }));
    return { ties: out, status: { qEvent: st.qualification_event ?? null, qNumbers: st.qualification_numbers ?? null, qRank: st.qualification_rank ?? null, qState: st.qualification_state ?? null }, leagueCups };
  }
  return { phi, pv, h2h, captains, transfers, ties, mults };
})();

if (typeof module !== 'undefined') { module.exports = { CUP }; }
else (() => {
  const CS = { w: 0.5, busy: false, cache: {}, sel: null };
  try { CS.w = +(localStorage.getItem('fr-cup-w') ?? 0.5); } catch (e) { }
  const pct = x => Math.round(x * 100) + '%', sgn = v => (v > 0 ? '+' : '') + v;
  const allP = () => (window.RADAR && RADAR.allP ? RADAR.allP() : {});
  const nm = i => (allP()[i] || {}).n || '#' + i;

  // ---- DOM: a "Cup" sub-page in the Planner tab
  const seg = document.querySelector('[data-seg="planner"]');
  if (seg && !seg.querySelector('[data-p="cup"]')) {
    seg.insertAdjacentHTML('beforeend', `<button data-p="cup" data-t="sgCup">${t('sgCup')}</button>`);
    seg.closest('section').insertAdjacentHTML('beforeend', `<div class="pane" data-pane="planner:cup"><div id="cup"></div></div>`);
    seg.querySelector('[data-p="cup"]').onclick = () => { go('planner', 'cup'); };
  }

  async function oppData(id, gw) {
    const key = id + ':' + gw; if (CS.cache[key]) return CS.cache[key];
    const [entry, hist] = await Promise.all([prox(`/entry/${id}/`), prox(`/entry/${id}/history/`)]);
    const ev = entry.current_event; const picks = ev ? await prox(`/entry/${id}/event/${ev}/picks/`) : null;
    return CS.cache[key] = { entry, hist, picks, ev };
  }
  function oppLineup(picks, P, k) { // their latest public team, re-optimised for the cup GW; captain kept if they still start him
    const sq = picks.picks.map(x => x.element).filter(i => P[i]), r = FREngine.bestXI(sq, P, k); if (!r) return null;
    const lastCap = (picks.picks.find(x => x.is_captain) || {}).element;
    const cap = r.xi.includes(lastCap) && (P[lastCap].b[k] || 0) >= 0.8 * (P[r.captain].b[k] || 0) ? lastCap : r.captain;
    return { xi: r.xi, bench: r.bench, captain: cap, squad: sq, lastCap };
  }
  const chipsLeft = h => { const used = (h && h.chips || []).map(c => c.name), half = (D.gw && D.gw.next) > 19 ? 2 : 1;
    const inHalf = (h && h.chips || []).filter(c => (half === 1 ? c.event <= 19 : c.event > 19)).map(c => c.name);
    return ['wildcard', 'freehit', 'bboost', '3xc'].filter(c => !inHalf.includes(c)); };

  async function render() {
    const box = $('#cup'); if (!box || !D || !D.projection) return;
    if (!TEAMDATA || !TEAMDATA.entry) { box.innerHTML = `<div class="card empty">${t('nodata')}</div>`; return; }
    const info = CUP.ties(TEAMDATA.entry, TEAM), G = D.gw || {}, P = allP(), gws = (PJ && PJ.gws) || [];
    const next = info.ties.find(x => x.winner == null && x.event >= (G.next || 0)) || info.ties.find(x => x.winner == null);
    let h = '';
    // status / history
    if (!info.ties.length) {
      const s = info.status;
      h += `<div class="card"><h2>${t('cupTitle')}</h2><p class="small">${s.qEvent ? t('cupQual', { g: s.qEvent, r: s.qEvent + 1 }) : t('cupNotYet')}</p>
        ${info.leagueCups.length ? `<div class="ch-k">${t('cupLeagues')}</div>${info.leagueCups.map(l => `<div class="row"><span>${esc(l.name)}</span><span class="v small">${l.qualified === false ? t('cupOut') : t('cupWait')}</span></div>`).join('')}` : ''}
        <p class="mute small">${t('cupHow')}</p></div>`;
      box.innerHTML = h; return;
    }
    if (!next) {
      const last = info.ties[0];
      h += `<div class="card"><h2>${t('cupTitle')}</h2><div class="big-line ${last.won ? 'ok' : 'bad'}">${last.won ? t('cupWonLast', { r: esc(last.round) }) : t('cupOutBy', { o: esc(last.oppName || '') })}</div></div>`;
      h += history(info.ties); box.innerHTML = h; return;
    }
    const k = gws.indexOf(next.event);
    h += `<div class="card hero"><div class="mute small">${t('cupTie', { r: esc(next.round || ''), g: next.event })}</div>
      <div style="font-size:20px;font-weight:800">${t('cupVs')} ${esc(next.oppName || t('cupBye'))}</div><div class="mute small">${esc(next.oppPlayer || '')}</div><div id="cup-gauge"></div></div>`;
    if (next.bye) { box.innerHTML = h + `<div class="card">${t('cupByeTxt')}</div>` + history(info.ties); return; }
    if (k < 0) { box.innerHTML = h + `<div class="card small">${t('cupFar', { g: next.event })}</div>` + history(info.ties); return; }
    box.innerHTML = h + `<div class="card empty">${t('cupLoading')}</div>`;
    let od; try { od = await oppData(next.opp, next.event); } catch (e) { box.innerHTML = h + `<div class="card empty">${t('nodata')}</div>`; return; }
    if (!od.picks) { box.innerHTML = h + `<div class="card empty">${t('nodata')}</div>`; return; }
    const opp = oppLineup(od.picks, P, k), oppChips = chipsLeft(od.hist), myChips = chipsLeft(TEAMDATA.history);
    const squad = D.projection.squad, sell = FREngine.sellingPrices(squad, TEAMDATA.transfers, P).out;
    const W = [1, 0.9, 0.8, 0.7, 0.6].slice(0, gws.length);
    const res = CUP.transfers({ squad, bank: D.projection.bank, sell, k, W, opp, bestXI: FREngine.bestXI, ft: D.projection.free_transfers_est, w: CS.w, rate: 0.5 }, P);
    if (!res.base) { box.innerHTML = h + `<div class="card empty">${t('nodata')}</div>`; return; }
    const me = (() => { const r = FREngine.bestXI(squad, P, k); return { xi: r.xi, bench: r.bench, captain: r.captain }; })();
    const caps = CUP.captains(me, opp, P, k).slice(0, 4), fav = res.base.win >= 0.5;
    const shared = me.xi.filter(i => opp.xi.includes(i));
    // gauge + scores
    h += `<div class="card"><h2>${t('cupH2H')}<small>${t('cupGw', { g: next.event })}</small></h2>
      <div class="h2h"><div><span class="small mute">${t('chYou')}</span><b class="num">${f1(res.base.myXP)}</b></div><span class="vs ${fav ? 'pos' : 'neg'} num">${pct(res.base.win)}</span><div><span class="small mute">${esc(next.oppName)}</span><b class="num">${f1(res.base.oppXP)}</b></div></div>
      <div class="wbar"><i style="width:${pct(res.base.win)}"></i></div>
      <p class="small">${t(fav ? 'cupFav' : 'cupDog', { p: pct(res.base.win), d: f1(Math.abs(res.base.diff)) })}</p>
      <div class="ch-k">${t('cupSwing')}</div>${res.base.swing.slice(0, 8).map(s => `<div class="lv"><span class="n">${esc(nm(s.id))}</span><span class="m" style="width:auto">${t(s.a && s.b ? (s.a > s.b ? 'cupMyCap' : 'cupTheirCapS') : s.a ? (s.a > 1 ? 'cupOnlyMeC' : 'cupOnlyMe') : (s.b > 1 ? 'cupOnlyThemC' : 'cupOnlyThem'))}</span><span class="p ${s.xp >= 0 ? 'pos-v' : 'neg-v'}">${sgn(f1(s.xp))}</span></div>`).join('')}
      <div class="small mute" style="margin-top:6px">${t('cupShared', { n: shared.length })}</div></div>`;
    // captain
    h += `<div class="card"><h2>${t('cupCap')}</h2><p class="small">${t(fav ? 'cupCapFav' : 'cupCapDog', { c: esc(nm(opp.captain)) })}</p>
      ${caps.map((c, j) => `<div class="move"><span class="mn num">${j + 1}</span><span>${esc(nm(c.id))}${c.id === opp.captain ? ` <span class="tag">${t('cupTheirCap')}</span>` : ''}<br><span class="mute small">${f1(c.xp)} xP</span></span><span class="g num">${pct(c.win)}</span></div>`).join('')}</div>`;
    // transfers with the cup/season balance slider
    const seenIn = new Set(), top = res.moves.filter(m => !seenIn.has(m.in) && seenIn.add(m.in)).slice(0, 6), roll = !top.length || top[0].score <= 0;
    h += `<div class="card"><h2>${t('cupTr')}</h2>
      <label class="small" for="cup-w">${t('cupBal')}</label><input type="range" id="cup-w" min="0" max="1" step="0.25" value="${CS.w}" aria-label="${t('cupBal')}">
      <div class="dlab small"><span>${t('cupSeason')}</span><span>${t('cupBalanced')}</span><span>${t('cupOnly')}</span></div>
      ${roll ? `<p class="small">${t('cupRoll')}</p>` : ''}
      ${top.map((m, j) => `<div class="move"><span class="mn num">${j + 1}</span><span><span class="bad">▼</span> ${esc(nm(m.out))}<br><span class="ok">▲</span> <b>${esc(nm(m.in))}</b> <span class="mute small">£${(P[m.in] || {}).c}m${m.hit ? ' · −4' : ''}</span></span>
        <span class="g num" style="text-align:end">${sgn(Math.round(m.dWin * 100))}% <span class="mute small">${t('cupWinShort')}</span><br>${sgn(f1(m.dSeason))} <span class="mute small">xP</span></span></div>`).join('')}
      <p class="mute small">${t('cupTrNote')}</p></div>`;
    // chips + intel
    h += `<div class="card"><h2>${t('cupIntel')}</h2>
      <div class="row"><span class="k">${t('cupTheirChips')}</span><span class="v small">${oppChips.map(c => CHIPN[c] || c).join(', ') || '—'}</span></div>
      <div class="row"><span class="k">${t('cupTheirRank')}</span><span class="v num">${fmtN(od.entry.summary_overall_rank)}</span></div>
      <div class="row"><span class="k">${t('cupTheirBank')}</span><span class="v num">£${((od.picks.entry_history || {}).bank || 0) / 10}m</span></div>
      <div class="row"><span class="k">${t('cupTheirLast')}</span><span class="v num">${(od.picks.entry_history || {}).points ?? '—'}</span></div>
      <p class="small">${t('cupChipTip', { c: myChips.includes('3xc') ? CHIPN['3xc'] : '', b: myChips.includes('bboost') ? CHIPN.bboost : '' })}</p>
      <p class="mute small">${t('cupCaveat', { g: od.ev })}</p>
      <button class="btn sec" id="cup-ask">${t('cupAsk')}</button></div>`;
    h += history(info.ties);
    box.innerHTML = h;
    CS.last = { next, res, caps, opp, fav, oppChips }; homeRow();
    $('#cup-w').onchange = e => { CS.w = +e.target.value; try { localStorage.setItem('fr-cup-w', CS.w); } catch (x) { } render(); };
    $('#cup-ask').onclick = () => { const b = document.querySelector('#chat-fab'); if (b) b.click(); const q = document.querySelector('#chat-q'); if (q) { q.value = t('cupAskQ', { o: next.oppName }); q.focus(); } };
  }
  function history(T) {
    const done = T.filter(x => x.winner != null); if (!done.length) return '';
    return `<div class="card"><h2>${t('cupHist')}</h2>${done.map(x => `<div class="row"><span>GW${x.event} · ${esc(x.oppName || t('cupBye'))}</span><span class="v num ${x.won ? 'ok' : 'bad'}">${x.myPts ?? ''}–${x.oppPts ?? ''} ${x.won ? '✓' : '✗'}</span></div>`).join('')}</div>`;
  }
  // context line for Ask Radar
  window.cupContext = () => { const L = CS.last; if (!L) return '';
    return `CUP TIE GW${L.next.event} ${L.next.round || ''} vs ${L.next.oppName}: win probability ${pct(L.res.base.win)}, my xP ${L.res.base.myXP} vs ${L.res.base.oppXP}. `
      + `Their likely captain ${nm(L.opp.captain)}; their chips left ${L.oppChips.join(', ') || 'none'}. Their differentials: ${L.res.base.swing.filter(s => s.d < 0).map(s => nm(s.id)).join(', ')}. `
      + `Best cup-balanced transfers: ${L.res.moves.slice(0, 3).map(m => `${nm(m.out)} -> ${nm(m.in)} (win ${sgn(Math.round(m.dWin * 100))}%, season ${sgn(m.dSeason)} xP)`).join('; ') || 'roll'}. Captains by win %: ${L.caps.map(c => `${nm(c.id)} ${pct(c.win)}`).join(', ')}.`; };
  window.onCupPane = render;
  window.onCupData = () => { CS.cache = {}; const on = document.querySelector('[data-pane="planner:cup"].on'); if (on) render(); else prefetch(); };
  async function prefetch() { // keep a summary ready for Home / Ask Radar without opening the tab
    if (!TEAMDATA || !TEAMDATA.entry || !D || !D.projection) return; const info = CUP.ties(TEAMDATA.entry, TEAM);
    if (info.ties.some(x => x.winner == null && !x.bye)) await render(); else homeRow();
  }
  function homeRow() { // a "Cup" line in Home > This week while a tie is open
    const box = $('#home-todo'); if (!box) return; const old = box.querySelector('[data-go="planner:cup"]'); if (old) old.remove();
    const L = CS.last; if (!L) return;
    box.insertAdjacentHTML('beforeend', `<button class="todo" data-go="planner:cup"><span class="k">${t('sgCup')}</span><span class="v">${t('cupHome', { o: esc(L.next.oppName), p: pct(L.res.base.win) })}</span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 6l6 6-6 6"/></svg></button>`);
  }
})();
