// Node tests for the Ask Radar chat helpers. Run: node --test tests/js
const test = require('node:test'), assert = require('node:assert');
const { CHAT } = require('../../dashboard/chat.js');

const P = {}; for (let i = 1; i <= 20; i++) P[i] = { id: i, n: 'P' + i, t: 'T', c: 5 + i / 10, posn: 1, b: [i, i, i] };
const sumXI = (ids, PP, g) => ({ xp: ids.reduce((s, i) => s + PP[i].b[g], 0) }); // stub for FREngine.bestXI

test('compare splits shared, threats and edges and sorts by xP', () => {
  const mine = [1, 2, 3, 4], theirs = [3, 4, 10, 20];
  const c = CHAT.compare(mine, theirs, P, sumXI, 3);
  assert.deepEqual(c.shared, [3, 4]);
  assert.deepEqual(c.threats, [20, 10]);
  assert.deepEqual(c.edges, [2, 1]);
  assert.equal(c.threatXP, 90); assert.equal(c.edgeXP, 9);
  assert.equal(c.mine.horizon, 30); assert.equal(c.theirs.horizon, 111); assert.equal(c.mine.next, 10);
});
test('compare survives missing players and no bestXI', () => {
  const c = CHAT.compare([1, 99], [99], P, null, 3);
  assert.deepEqual(c.shared, [99]); assert.equal(c.mine.next, null); assert.equal(c.mine.horizon, 0);
});
test('guessKind: 9+ shared players means it is my own team', () => {
  const mine = Array.from({ length: 15 }, (_, i) => i + 1);
  assert.equal(CHAT.guessKind([1, 2, 3, 4, 5, 6, 7, 8, 9], mine), 'mine');
  assert.equal(CHAT.guessKind([1, 2, 3, 4, 5, 16, 17, 18, 19, 20], mine), 'scout');
});
test('history keeps the last text turns only', () => {
  const msgs = [{ role: 'user', content: 'a' }, { role: 'card', html: 'x' }, { role: 'assistant', content: 'b', model: 'm' }, { role: 'user', content: 'c' }];
  assert.deepEqual(CHAT.history(msgs, 2), [{ role: 'assistant', content: 'b' }, { role: 'user', content: 'c' }]);
});
test('fmt escapes HTML and keeps bold and line breaks', () => {
  assert.equal(CHAT.fmt('<img onerror=x> **Saka**\n- go'), '&lt;img onerror=x&gt; <b>Saka</b><br>• go');
});
