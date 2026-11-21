// Node tests for the Cup model. Run: node --test tests/js
const test = require('node:test'), assert = require('node:assert');
const { CUP } = require('../../dashboard/cup.js');

const mk = (id, posn, t, c, xp) => ({ id, posn, t, c, b: [xp, xp, xp], st: 'a' });
// simple bestXI stub: top 11 by xP for gameweek k, captain = best
const bestXI = (ids, P, k) => { const s = ids.filter(i => P[i]).sort((a, b) => P[b].b[k] - P[a].b[k]); const xi = s.slice(0, 11);
  return { xi, bench: s.slice(11), captain: xi[0], xp: xi.reduce((x, i) => x + P[i].b[k], 0) + P[xi[0]].b[k] }; };

test('phi is a proper normal CDF', () => {
  assert.ok(Math.abs(CUP.phi(0) - 0.5) < 1e-6); assert.ok(Math.abs(CUP.phi(1.96) - 0.975) < 1e-3); assert.ok(Math.abs(CUP.phi(-1) - 0.1587) < 1e-3);
});
test('identical teams are a coin flip; shared players cancel', () => {
  const P = {}; for (let i = 1; i <= 11; i++) P[i] = mk(i, 3, 'A', 5, i);
  const L = { xi: [...Array(11)].map((_, i) => i + 1), captain: 11 };
  const r = CUP.h2h(L, L, P, 0); assert.equal(r.diff, 0); assert.ok(Math.abs(r.win - 0.5) < 1e-9); assert.equal(r.swing.length, 0);
});
test('captain difference and hits move the edge', () => {
  const P = { 1: mk(1, 3, 'A', 5, 8), 2: mk(2, 3, 'B', 5, 4) };
  const me = { xi: [1, 2], captain: 1 }, opp = { xi: [1, 2], captain: 2 };
  const r = CUP.h2h(me, opp, P, 0); assert.equal(r.diff, 4); assert.ok(r.win > 0.5);
  assert.equal(CUP.h2h(me, opp, P, 0, { myHits: 4 }).diff, 0);
  assert.equal(CUP.h2h(me, opp, P, 0, { myChip: '3xc' }).diff, 12);
});
test('transfers: cup weight prefers the differential, season weight the steady pick', () => {
  const P = {}; for (let i = 1; i <= 15; i++) P[i] = mk(i, 3, 'T' + i, 5, 3);
  P[20] = { ...mk(20, 3, 'X', 5, 5), b: [6, 3, 3] };   // big this GW only (helps the cup)
  P[21] = { ...mk(21, 3, 'Y', 5, 5), b: [3.2, 7, 7] }; // better long term
  const squad = [...Array(15)].map((_, i) => i + 1), opp = { xi: squad.slice(0, 11), captain: 1 };
  const ctx = { squad, bank: 0, sell: {}, k: 0, W: [1, 0.9, 0.8], opp, bestXI, ft: 1 };
  const cup = CUP.transfers({ ...ctx, w: 1 }, P), season = CUP.transfers({ ...ctx, w: 0 }, P);
  assert.equal(cup.moves[0].in, 20); assert.ok(cup.moves[0].dWin > 0);
  assert.equal(season.moves[0].in, 21); assert.ok(season.moves[0].dSeason > 0);
});
test('transfers respect budget and the 3-per-club rule; no free transfer means a -4 hit', () => {
  const P = {}; for (let i = 1; i <= 15; i++) P[i] = mk(i, 3, i <= 3 ? 'ARS' : 'T' + i, 5, 3);
  P[30] = mk(30, 3, 'ARS', 5, 9); P[31] = mk(31, 3, 'Z', 9, 9); P[32] = mk(32, 3, 'Q', 5, 6);
  const squad = [...Array(15)].map((_, i) => i + 1), opp = { xi: squad.slice(0, 11), captain: 1 };
  const r = CUP.transfers({ squad, bank: 0.5, sell: {}, k: 0, W: [1], opp, bestXI, ft: 0, w: 0.5 }, P);
  const ins = new Set(r.moves.map(m => m.in));
  assert.ok(!ins.has(31), 'over budget'); assert.ok(r.moves.filter(m => m.in === 30).every(m => P[m.out].t === 'ARS'), 'club limit');
  assert.ok(r.moves.every(m => m.hit === 4));
});
test('ties() reads the FPL entry cup block from either side', () => {
  const entry = { leagues: { classic: [{ name: 'Egypt', has_cup: true, cup_league: 9, cup_qualified: true }],
    cup: { status: { qualification_event: 16 }, matches: [
      { id: 1, event: 17, entry_1_entry: 7, entry_1_name: 'Me', entry_2_entry: 8, entry_2_name: 'Rival', entry_1_points: 60, entry_2_points: 50, winner: 7, knockout_name: 'Round 1' },
      { id: 2, event: 18, entry_1_entry: 9, entry_1_name: 'Next', entry_2_entry: 7, entry_2_name: 'Me', winner: null, knockout_name: 'Round 2' }] } } };
  const r = CUP.ties(entry, 7);
  assert.equal(r.ties[0].opp, 9); assert.equal(r.ties[0].oppName, 'Next'); assert.equal(r.ties[0].won, null);
  assert.equal(r.ties[1].won, true); assert.equal(r.ties[1].myPts, 60); assert.equal(r.status.qEvent, 16); assert.equal(r.leagueCups[0].name, 'Egypt');
});
