// Node tests for the browser tools (auto-subs, what-if, OCR matching). Run: node --test tests/js
const test = require('node:test'), assert = require('node:assert');
const { RV, SYNC } = require('../../dashboard/features.js');

// squad: GK 1,2 · DEF 3-7 · MID 8-12 · FWD 13-15
const pos = {}; [1, 2].forEach(i => pos[i] = 1); [3, 4, 5, 6, 7].forEach(i => pos[i] = 2); [8, 9, 10, 11, 12].forEach(i => pos[i] = 3); [13, 14, 15].forEach(i => pos[i] = 4);
const base = { xi: [1, 3, 4, 5, 8, 9, 10, 11, 13, 14, 15], bench: [2, 6, 12, 7], cap: 13, vice: 8 }; // 3-4-3
const live = over => { const m = {}; for (let i = 1; i <= 15; i++) m[i] = { p: 2, m: 90 }; return Object.assign(m, over); };

test('captain doubled, bench ignored', () => {
  assert.equal(RV.scoreGW({ ...base, live: live({ 13: { p: 10, m: 90 } }), pos }).total, 2 * 10 + 10 * 2);
});
test('auto-sub keeps a valid formation and vice takes the armband', () => {
  // DEF 3 did not play: first outfield bench player is DEF 6 -> keeps 3 DEF. Captain 13 did not play -> vice 8 doubles.
  const r = RV.scoreGW({ ...base, live: live({ 3: { p: 0, m: 0 }, 13: { p: 0, m: 0 }, 8: { p: 6, m: 90 } }), pos });
  assert.deepEqual(r.subs, [[3, 6], [13, 12]]);
  assert.equal(r.cap, 8);
  assert.equal(r.total, 12 + 9 * 2 + 2);   // vice 6x2 + nine others at 2 + sub 12 at 2
});
test('a DEF cannot be replaced by a MID when only 3 DEF start', () => {
  const r = RV.scoreGW({ ...base, bench: [2, 12, 6, 7], live: live({ 3: { p: 0, m: 0 } }), pos });
  assert.deepEqual(r.subs, [[3, 6]]);
});
test('no sub while the match is not finished', () => {
  const r = RV.scoreGW({ ...base, live: live({ 3: { p: 0, m: 0 } }), pos, done: i => i !== 3 });
  assert.equal(r.subs.length, 0);
});
test('bench boost and triple captain', () => {
  assert.equal(RV.scoreGW({ ...base, chip: 'bboost', live: live({}), pos }).total, 15 * 2 + 2);
  assert.equal(RV.scoreGW({ ...base, chip: '3xc', live: live({}), pos }).total, 10 * 2 + 6);
});
test('what-if A: hits on the actual side, free hit neutral, transfer ledger', () => {
  const picks = { 5: { picks: base.xi.concat(base.bench).map((e, k) => ({ element: e, position: k + 1, is_captain: e === 13, is_vice_captain: e === 8 })) } };
  picks[6] = { picks: [...picks[5].picks.filter(x => x.element !== 15), { element: 99, position: 11, is_captain: true }].map(x => ({ ...x, is_captain: x.element === 99 })) };
  picks[7] = picks[6];
  const L = { 6: live({ 15: { p: 1, m: 90 } }), 7: live({}) }; L[6][99] = { p: 12, m: 90 }; L[7][99] = { p: 5, m: 90 };
  const hist = { 6: { points: 50, event_transfers_cost: 4 }, 7: { points: 40, event_transfers_cost: 0 } };
  const rows = RV.compare({ mode: 'A', from: 5, gws: [6, 7], base, picks, live: L, hist, chips: { 7: 'freehit' }, pos });
  // GW6: actual captain 99 not in the old squad -> vice 8 captains the what-if team
  assert.equal(rows[0].actual, 46); assert.equal(rows[0].alt, 10 * 2 + 1 + 2);
  assert.equal(rows[1].alt, 40);   // free hit week counts the same
  const led = RV.ledger([{ event: 6, element_in: 99, element_out: 15 }], 5, 7, L);
  assert.deepEqual(led, [{ g: 6, out: 15, in: 99, v: (12 + 5) - (1 + 2) }]);
});
test('OCR matching: names, typos, quotas, prior squad fallback, bank', () => {
  const P = {}; let id = 1;
  const add = (n, posn, own = 5) => { P[id] = { id, n, posn, own }; return id++; };
  const gk = [add('Verbruggen', 1), add('Dubravka', 1)], df = [add('Gabriel', 2, 40), add('Mitchell', 2), add('Bogle', 2), add("O'Shea", 2), add('van Ewijk', 2)];
  const md = [add('Mbeumo', 3, 30), add('Groß', 3), add('B.Fernandes', 3, 30), add('Tavernier', 3), add('Thomas', 3)];
  const fw = [add('Haaland', 4, 60), add('Calvert-Lewin', 4), add('João Pedro', 4, 30)];
  const other = add('Wissa', 4, 10); add('Gabriel', 3, 1); // homonym in another position
  const prior = gk.concat(df, md, fw);
  const text = 'Pick Team\nVerbruggen Dubravka\nGabrlel Mitchell Bogle O\'Shea van Ewijk\nMbeumo Gross B.Fernandes Tavernier\nHaaland Wissa Joao Pedro\nMoney Remaining £0.4m  Free Transfers 1';
  const r = SYNC.match(text, P, prior);
  assert.equal(r.squad.length, 15);
  assert.ok(r.squad.includes(other) && !r.squad.includes(fw[1]), 'Wissa in, Calvert-Lewin out');
  assert.ok(r.squad.includes(df[0]), 'typo Gabrlel matched to the squad Gabriel (DEF)');
  assert.ok(!r.seen.has(md[4]) && r.squad.includes(md[4]), 'Thomas not seen, kept from prior squad');
  assert.equal(SYNC.money(text), 0.4); assert.equal(SYNC.freeT(text), 1);
});
