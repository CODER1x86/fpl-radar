// FPL Radar in-browser planning engine (port of wc/model.py): lets the app plan for ANY team id.
// Inputs: all-player projections (data/players.json) + the team's public FPL data (via the read-only proxy).
(function (G) {
  const POS = { 1: 'GKP', 2: 'DEF', 3: 'MID', 4: 'FWD' }, POSN = { GKP: 1, DEF: 2, MID: 3, FWD: 4 };
  const FORMS = []; for (let d = 3; d <= 5; d++) for (let m = 2; m <= 5; m++) { const f = 10 - d - m; if (f >= 1 && f <= 3) FORMS.push([d, m, f]); }

  function players(pj) { // -> {id: row}
    const out = {}, c = pj.cols;
    for (const r of pj.rows) { const o = {}; c.forEach((k, j) => o[k] = r[j]); o.posn = o.pos; o.pos = POS[o.pos]; o.team = o.t; out[o.id] = o; }
    return out;
  }
  function bestXI(ids, P, k) {
    const by = { 1: [], 2: [], 3: [], 4: [] }, xp = i => (P[i] ? P[i].b[k] || 0 : 0);
    for (const i of ids) if (P[i]) by[P[i].posn].push(i);
    for (const q in by) by[q].sort((a, b) => xp(b) - xp(a));
    if (!by[1].length) return null;
    let best = null;
    for (const [d, m, f] of FORMS) {
      if (by[2].length < d || by[3].length < m || by[4].length < f) continue;
      const xi = [by[1][0], ...by[2].slice(0, d), ...by[3].slice(0, m), ...by[4].slice(0, f)];
      const v = xi.reduce((s, i) => s + xp(i), 0);
      if (!best || v > best[0]) best = [v, xi, `${d}-${m}-${f}`];
    }
    if (!best) return null;
    const [v, xi, form] = best, cap = xi.reduce((a, b) => xp(b) > xp(a) ? b : a), rest = xi.filter(i => i !== cap);
    const vice = rest.reduce((a, b) => xp(b) > xp(a) ? b : a);
    const bench = by[1].slice(1).concat(ids.filter(i => P[i] && !xi.includes(i) && P[i].posn !== 1).sort((a, b) => xp(b) - xp(a)));
    return { xi, formation: form, captain: cap, vice, bench, xp: +(v + xp(cap)).toFixed(2) };
  }
  const wval = (ids, P, W) => W.reduce((s, w, k) => { const r = bestXI(ids, P, k); return s + w * (r ? r.xp : 0); }, 0);

  function planTransfers(squad, P, bank, sell, ft, W, roll = 1.5, hit = 4, maxMoves = null, top = 35) {
    let cur = squad.slice(), money = bank || 0;
    const sp = {}; cur.forEach(i => sp[i] = sell[i] ?? (P[i] ? P[i].c : 0));
    let base = wval(cur, P, W); const start = base;
    ft = ft ?? 1; maxMoves = maxMoves ?? ft + 2;
    const score = i => W.reduce((s, w, k) => s + w * (P[i].b[k] || 0), 0);
    const pool = {};
    for (const q of [1, 2, 3, 4]) pool[q] = Object.values(P).filter(p => p.posn === q && !['u', 'n'].includes(p.st)).sort((a, b) => score(b.id) - score(a.id)).slice(0, top).map(p => p.id);
    const moves = []; let stop = null, firstStep = null;
    while (moves.length < maxMoves) {
      const tc = {}; cur.forEach(x => tc[P[x].team] = (tc[P[x].team] || 0) + 1);
      let best = null; const cands = [];
      for (const o of cur) {
        if (!P[o]) continue;
        const budget = money + sp[o];
        for (const i of pool[P[o].posn]) {
          if (cur.includes(i) || P[i].c > budget + 1e-9) continue;
          if (P[i].team !== P[o].team && (tc[P[i].team] || 0) >= 3) continue;
          const v = wval(cur.filter(x => x !== o).concat(i), P, W);
          cands.push({ out: o, in: i, gain: +(v - base).toFixed(2), bank_after: +(budget - P[i].c).toFixed(1) });
          if (!best || v > best[0]) best = [v, o, i];
        }
      }
      if (!firstStep) firstStep = cands;
      if (!best) { stop = 'no affordable improvement'; break; }
      const [v, o, i] = best, gain = v - base, free = moves.length < ft;
      const need = free ? (ft - moves.length >= 5 ? 0.3 : roll) : hit;
      if (gain <= need) { stop = { next_out: o, next_in: i, next_gain: +gain.toFixed(2), threshold: need, reason: free ? 'next move not worth a free transfer' : 'next move not worth a -4 hit' }; break; }
      money = money + sp[o] - P[i].c; cur = cur.filter(x => x !== o).concat(i); sp[i] = P[i].c;
      moves.push({ out: o, in: i, gain: +gain.toFixed(2), type: free ? 'free' : 'hit', bank_after: +money.toFixed(1) });
      base = v;
    }
    const hits = moves.filter(m => m.type === 'hit').length;
    const seen = new Set(), bestPerOut = (firstStep || []).sort((a, b) => b.gain - a.gain).filter(c => !seen.has(c.out) && seen.add(c.out));
    return { moves, squad: cur, gain: +(base - start).toFixed(2), net: +(base - start - 4 * hits).toFixed(2), hits,
      ft_after: Math.min(5, ft - Math.min(moves.length, ft) + 1), bank_after: +money.toFixed(1), selling: sp, stop, bestPerOut };
  }
  function dreamTeam(P, k, perPos = 25) {
    const xp = i => P[i].b[k] || 0;
    const pool = Object.values(P).filter(p => !['u', 'n'].includes(p.st)).sort((a, b) => b.b[k] - a.b[k]);
    let best = null;
    for (const [d, m, f] of FORMS) {
      const need = { 1: 1, 2: d, 3: m, 4: f }, got = { 1: [], 2: [], 3: [], 4: [] }, clubs = {};
      for (const p of pool) { if (got[p.posn].length < need[p.posn] && (clubs[p.team] || 0) < 3) { got[p.posn].push(p.id); clubs[p.team] = (clubs[p.team] || 0) + 1; } }
      const xi = [...got[1], ...got[2], ...got[3], ...got[4]]; if (xi.length !== 11) continue;
      const v = xi.reduce((s, i) => s + xp(i), 0); if (!best || v > best[0]) best = [v, xi, `${d}-${m}-${f}`];
    }
    if (!best) return null; const cap = best[1].reduce((a, b) => xp(b) > xp(a) ? b : a);
    return { xi: best[1], formation: best[2], captain: cap, xp: +(best[0] + xp(cap)).toFixed(2) };
  }
  function budgetXI(P, k, budget) {
    const d = dreamTeam(P, k); if (!d) return null; let xi = d.xi.slice(), guard = 0;
    const cost = ids => ids.reduce((s, i) => s + P[i].c, 0);
    while (cost(xi) > budget + 1e-9 && guard++ < 40) {
      const tc = {}; xi.forEach(x => tc[P[x].team] = (tc[P[x].team] || 0) + 1); let best = null;
      for (const o of xi) for (const p of Object.values(P)) {
        if (xi.includes(p.id) || p.posn !== P[o].posn || p.c >= P[o].c || ['u', 'n'].includes(p.st)) continue;
        if (p.team !== P[o].team && (tc[p.team] || 0) >= 3) continue;
        const r = (P[o].b[k] - p.b[k]) / (P[o].c - p.c); if (!best || r < best[0]) best = [r, o, p.id];
      }
      if (!best) break; xi = xi.filter(x => x !== best[1]).concat(best[2]);
    }
    const cap = xi.reduce((a, b) => P[b].b[k] > P[a].b[k] ? b : a);
    return { xi, captain: cap, xp: +(xi.reduce((s, i) => s + P[i].b[k], 0) + P[cap].b[k]).toFixed(2), cost: +cost(xi).toFixed(1) };
  }
  // normal approximation of a lineup's GW points from per-player mean and spread
  function dist(xi, cap, P, k = 0) {
    let m = 0, v = 0;
    for (const i of xi.concat([cap])) { const p = P[i]; if (!p) continue; m += p.b[k] || 0; const sd = p.sd1 != null ? p.sd1 : Math.max(1.5, Math.sqrt(p.b[k] || 0) * 1.6); v += sd * sd; }
    v += 2 * Math.pow(P[cap] && P[cap].sd1 != null ? P[cap].sd1 : 2.5, 2); // captain counted twice: cov term
    const sd = Math.sqrt(v), z = x => 0.5 * (1 + erf(x / Math.SQRT2)), q = (p) => Math.round(m + sd * inv(p));
    const prob = {}; for (const t of [40, 50, 60, 70, 80]) prob[t] = +(1 - z((t - 0.5 - m) / sd)).toFixed(3);
    return { mean: +m.toFixed(1), p10: q(0.1), p50: q(0.5), p90: q(0.9), prob, approx: true };
  }
  function erf(x) { const t = 1 / (1 + 0.3275911 * Math.abs(x)), y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x); return x >= 0 ? y : -y; }
  function inv(p) { return p === 0.5 ? 0 : (p < 0.5 ? -1 : 1) * 1.2816; } // 10th/90th percentiles only

  function freeTransfers(history, uptoGW) {
    if (!history || !history.current) return null;
    const chips = {}; (history.chips || []).forEach(c => chips[c.event] = c.name);
    const rows = {}; history.current.forEach(r => rows[r.event] = r); let ft = 1;
    for (let g = 2; g < uptoGW; g++) { const r = rows[g]; if (r && !['wildcard', 'freehit'].includes(chips[g])) ft = Math.max(0, ft - (r.event_transfers || 0)); ft = Math.min(5, ft + 1); }
    return ft;
  }
  function sellingPrices(squad, transfers, P) { // purchase price from the public transfer log; 50% sell-on rule
    const last = {}; (transfers || []).forEach(t => { if (!last[t.element_in] || t.event > last[t.element_in].event) last[t.element_in] = t; });
    const out = {}, est = {};
    for (const i of squad) {
      const now = P[i] ? P[i].c : 0, t = last[i];
      if (t) { const buy = t.element_in_cost / 10; out[i] = now > buy ? +(buy + Math.floor((now - buy) * 10 / 2) / 10).toFixed(1) : now; est[i] = false; }
      else { out[i] = now; est[i] = true; } // held since before the transfer log: current price used (estimate)
    }
    return { out, est };
  }
  function chipsPlan(squad, P, gws, history, bank, sell, W) {
    const nxt = gws[0], half = nxt <= 19 ? [1, 19] : [20, 38], used = {};
    (history && history.chips || []).forEach(c => { if (c.event >= half[0] && c.event <= half[1]) used[c.name] = c.event; });
    const funds = (bank || 0) + squad.reduce((s, i) => s + (sell[i] ?? (P[i] ? P[i].c : 0)), 0);
    const per = { '3xc': [], bboost: [], freehit: [] };
    gws.forEach((g, k) => { const r = bestXI(squad, P, k); if (!r) return;
      per['3xc'].push({ gw: g, value: +P[r.captain].b[k].toFixed(2), who: r.captain });
      per.bboost.push({ gw: g, value: +r.bench.reduce((s, i) => s + (P[i] ? P[i].b[k] : 0), 0).toFixed(2) });
      const fh = budgetXI(P, k, funds - 16.5); per.freehit.push({ gw: g, value: +((fh ? fh.xp : 0) - r.xp).toFixed(2) }); });
    // wildcard: best weighted-horizon XI under budget + cheapest bench (same approximation as the server)
    const pseudo = {}; Object.values(P).forEach(p => pseudo[p.id] = { ...p, b: [W.reduce((s, w, k) => s + w * (p.b[k] || 0), 0)] });
    const wxi = budgetXI(pseudo, 0, funds - 16.5); let wcGain = 0, wcN = 0;
    if (wxi) { const have = { 1: 0, 2: 0, 3: 0, 4: 0 }; wxi.xi.forEach(i => have[P[i].posn]++); const need = { 1: 2 - have[1], 2: 5 - have[2], 3: 5 - have[3], 4: 3 - have[4] };
      const tc = {}; wxi.xi.forEach(i => tc[P[i].team] = (tc[P[i].team] || 0) + 1); const bench = [];
      for (const q of [1, 2, 3, 4]) { let n = need[q]; for (const p of Object.values(P).filter(p => p.posn === q && p.st === 'a' && !wxi.xi.includes(p.id)).sort((a, b) => a.c - b.c)) { if (n <= 0) break; if ((tc[p.team] || 0) < 3) { bench.push(p.id); tc[p.team] = (tc[p.team] || 0) + 1; n--; } } }
      const nw = wxi.xi.concat(bench); if (nw.length === 15 && nw.reduce((s, i) => s + P[i].c, 0) <= funds + 1e-9) { wcGain = +(wval(nw, P, W) - wval(squad, P, W)).toFixed(2); wcN = nw.filter(i => !squad.includes(i)).length; } }
    const TH = { '3xc': 9, bboost: 10, freehit: 12, wildcard: 15 }, NAMES = { wildcard: 'Wildcard', freehit: 'Free Hit', bboost: 'Bench Boost', '3xc': 'Triple Captain' };
    return { half, chips: ['wildcard', 'freehit', 'bboost', '3xc'].map(c => {
      const row = { chip: c, name: NAMES[c], available: !(c in used), used_gw: used[c], expires_gw: half[1], gws_left_in_half: half[1] - nxt + 1, threshold: TH[c] };
      if (c === 'wildcard') Object.assign(row, { value_now: wcGain, series: [{ gw: nxt, value: wcGain }], best_gw: nxt, moves: wcN });
      else { const s = per[c], b = s.reduce((a, x) => !a || x.value > a.value ? x : a, null); Object.assign(row, { series: s, value_now: s[0] ? s[0].value : null, best_gw: b ? b.gw : null }); }
      row.verdict = !row.available ? 'used' : (row.best_gw === nxt && (row.value_now || 0) >= TH[c]) ? 'use_now' : (half[1] - nxt + 1 <= 2 ? 'use_before_expiry' : 'hold');
      return row; }) };
  }
  // Build a projection object with the same shape the UI already renders for the owner's server-side plan.
  function buildForTeam(pj, base, team, done = []) {
    const P = players(pj), gws = pj.gws, W = [1, 0.9, 0.8, 0.7, 0.6].slice(0, gws.length);
    const squad0 = team.picks.picks.map(x => x.element).filter(i => P[i]);
    let bank = team.picks.entry_history.bank / 10; const ft0 = freeTransfers(team.history, gws[0]) ?? 1;
    const { out: sell, est } = sellingPrices(squad0, team.transfers, P);
    // apply transfers the manager says he already made this gameweek (not public until the deadline)
    let squad = squad0.slice(); const applied = [];
    for (const [o, i] of done) { if (!squad.includes(o) || squad.includes(i) || !P[i]) continue;
      bank = bank + (sell[o] ?? P[o].c) - P[i].c; squad = squad.filter(x => x !== o).concat(i); sell[i] = P[i].c; applied.push({ out: o, in: i }); }
    const ft = Math.max(0, ft0 - applied.length), hitsDone = Math.max(0, applied.length - ft0);
    const plan = planTransfers(squad, P, bank, sell, ft, W, 1.5, 4, ft + 1);
    const nm = i => P[i] ? P[i].n : String(i);
    const lus = gws.map((g, k) => { const r = bestXI(plan.squad, P, k); if (r) Object.assign(r, { gw: g, xi_n: r.xi.map(nm), bench_n: r.bench.map(nm), captain_n: nm(r.captain), vice_n: nm(r.vice) }); return r; });
    if (lus[0]) lus[0].dist = dist(lus[0].xi, lus[0].captain, P);
    const cur = gws.map((g, k) => { const r = bestXI(squad, P, k); if (r) Object.assign(r, { gw: g, xi_n: r.xi.map(nm), bench_n: r.bench.map(nm), captain_n: nm(r.captain), vice_n: nm(r.vice) }); return r; });
    const scen = (key, xi, cap) => { xi = (xi || []).filter(i => P[i]); if (!xi.length) return null; cap = xi.includes(cap) ? cap : xi.reduce((a, b) => P[b].b[0] > P[a].b[0] ? b : a);
      const rest = xi.filter(i => i !== cap), vice = rest.reduce((a, b) => P[b].b[0] > P[a].b[0] ? b : a);
      return { key, xi, captain: cap, vice, xp: +(xi.reduce((s, i) => s + P[i].b[0], 0) + P[cap].b[0]).toFixed(2), cost: +xi.reduce((s, i) => s + P[i].c, 0).toFixed(1), dist: dist(xi, cap, P), overlap: xi.filter(i => squad.includes(i)), differentials: xi.filter(i => !squad.includes(i)) }; };
    const S = base.scenarios || [], g = k => (S.find(s => s.key === k) || {});
    const funds = bank + squad.reduce((s, i) => s + sell[i], 0);
    const bx = budgetXI(P, 0, funds - 16.5);
    const scenarios = [scen('plan', lus[0] && lus[0].xi, lus[0] && lus[0].captain), scen('current', cur[0] && cur[0].xi, cur[0] && cur[0].captain),
      scen('model', g('model').xi), scen('budget', bx && bx.xi), Object.assign(scen('elite', g('elite').xi, g('elite').captain) || {}, { source_gw: g('elite').source_gw }),
      Object.assign(scen('experts', g('experts').xi, g('experts').captain) || {}, { from_shortlist: g('experts').from_shortlist })].filter(s => s && s.xi);
    const mine = new Set(squad), rows = Object.values(P).map(p => ({ ...p, c: p.c, mine: mine.has(p.id), watch: false }));
    return { ...base, players: rows, squad, bank, free_transfers_est: ft, selling_estimated: Object.values(est).some(Boolean),
      lineups: cur, plan: { ...plan, done: applied.map(m => ({ ...m, out_n: nm(m.out), in_n: nm(m.in) })), hits_done: hitsDone, ft_start: ft0,
        bank_now: +bank.toFixed(1), moves: plan.moves.map(m => ({ ...m, out_n: nm(m.out), in_n: nm(m.in) })),
        stop: plan.stop && plan.stop.next_out ? { ...plan.stop, next_out_n: nm(plan.stop.next_out), next_in_n: nm(plan.stop.next_in) } : plan.stop, lineups: lus },
      chips: chipsPlan(plan.squad, P, gws, team.history, plan.bank_after, plan.selling, W), scenarios,
      transfers: { horizon: 5, best_per_out: plan.bestPerOut.slice(0, 15).map(s => ({ ...s, out_n: nm(s.out), in_n: nm(s.in) })), pairs: [] } };
  }
  G.FREngine = { players, bestXI, planTransfers, buildForTeam, dist, freeTransfers };
})(window);
