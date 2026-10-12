// Tests for the stack moves Troy gets for "how did my stack do this week"
// questions. price_log is faked, so nothing leaves the machine.
//   node --test

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const Module = require('node:module');

// Fake price_log: answers "last row between F and T" from a fixed list.
let priceRows = [];
const fakeSupabase = {
  from(table) {
    assert.strictEqual(table, 'price_log');
    let floor = '';
    let cutoff = null;
    const api = {
      select() { return api; },
      gte(col, val) { assert.strictEqual(col, 'timestamp'); floor = val; return api; },
      lte(col, val) { assert.strictEqual(col, 'timestamp'); cutoff = val; return api; },
      order() { return api; },
      limit() {
        const row = priceRows
          .filter(r => r.timestamp >= floor && r.timestamp <= cutoff)
          .sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1))[0];
        return Promise.resolve({ data: row ? [row] : [], error: null });
      },
    };
    return api;
  },
};
const supabasePath = require.resolve(path.join(__dirname, '../src/lib/supabase'));
const stub = new Module(supabasePath, null);
stub.filename = supabasePath;
stub.loaded = true;
stub.exports = fakeSupabase;
require.cache[supabasePath] = stub;

const { getStackMoves, formatStackMoves } = require('../src/services/stack-moves');

const NOW = new Date('2026-10-12T04:00:00Z');
const daysAgo = d => new Date(NOW.getTime() - d * 86400000).toISOString();
const row = (d, gold, silver) => ({ timestamp: daysAgo(d), gold_price: gold, silver_price: silver, platinum_price: 1500, palladium_price: 1100 });
const prices = { gold: 4200, silver: 60, platinum: 1500, palladium: 1100 };

const holdings = [
  { metal: 'gold', weight: 1, quantity: 10, purchase_date: '2024-04-01' },
  { metal: 'silver', weight: 100, quantity: 1, purchase_date: '2022-09-20' },
  // Bought three days ago, so it belongs in the 24-hour move only.
  { metal: 'silver', weight: 1, quantity: 50, purchase_date: daysAgo(3).slice(0, 10) },
];

test('the week prices what was already held at last week\'s spot', async () => {
  priceRows = [row(30.2, 4000, 50), row(7.1, 4100, 55), row(1.05, 4180, 59.5)];
  const moves = await getStackMoves(holdings, prices, NOW);
  const week = moves.find(m => m.key === 'week');
  // 10 oz gold 4100 to 4200 and 100 oz silver 55 to 60. The new 50 oz stays out.
  assert.strictEqual(week.before, 46500);
  assert.strictEqual(week.after, 48000);
  assert.strictEqual(week.change, 1500);
  assert.strictEqual(week.pct.toFixed(2), '3.23');
  assert.deepStrictEqual(week.metals.silver, { from: 55, to: 60 });
});

test('a holding bought inside a window counts only in the shorter windows', async () => {
  priceRows = [row(30.2, 4000, 50), row(7.1, 4100, 55), row(1.05, 4180, 59.5)];
  const moves = await getStackMoves(holdings, prices, NOW);
  const day = moves.find(m => m.key === 'day');
  const month = moves.find(m => m.key === 'month');
  // The day window includes the 50 oz bought three days ago.
  assert.strictEqual(day.before, 10 * 4180 + 150 * 59.5);
  assert.strictEqual(month.before, 10 * 4000 + 100 * 50);
});

test('no price history means no windows and a plain note not to guess', async () => {
  priceRows = [];
  const moves = await getStackMoves(holdings, prices, NOW);
  assert.deepStrictEqual(moves, []);
  const text = formatStackMoves(moves);
  assert.match(text, /^STACK MOVES:\n/);
  assert.match(text, /don't estimate one/);
  assert.ok(text.endsWith('\n\n'));
});

test('a holding with no purchase date counts as held', async () => {
  priceRows = [row(7.1, 4100, 55)];
  const moves = await getStackMoves([{ metal: 'gold', weight: 1, quantity: 2 }], prices, NOW);
  const week = moves.find(m => m.key === 'week');
  assert.strictEqual(week.change, 200);
});

test('the prompt block reads as one line per window with the metals that moved', async () => {
  priceRows = [row(30.2, 4000, 50), row(7.1, 4100, 55), row(1.05, 4180, 59.5)];
  const text = formatStackMoves(await getStackMoves(holdings, prices, NOW));
  assert.match(text, /^STACK MOVES \(spot moves on what the user already held, before premiums\):\n/);
  assert.match(text, /- Last 7 days: \+\$1500\.00 \(\+3\.2%\)\. Gold \$4100\.00 to \$4200\.00, Silver \$55\.00 to \$60\.00\.\n/);
  assert.match(text, /- Last 30 days: \+\$3000\.00 \(\+6\.7%\)/);
  assert.ok(text.endsWith("aren't counted in that window.\n\n"));
});

test('a falling window is signed', async () => {
  priceRows = [row(7.1, 4400, 66)];
  const text = formatStackMoves(await getStackMoves([{ metal: 'silver', weight: 10, quantity: 1, purchase_date: '2020-01-01' }], prices, NOW));
  assert.match(text, /- Last 7 days: -\$60\.00 \(-9\.1%\)\. Silver \$66\.00 to \$60\.00/);
});

test('a price from long before a window does not stand in for it', async () => {
  // The logger went quiet: nothing within four days of the day or week start.
  priceRows = [row(31, 4000, 50), row(12, 4100, 55)];
  const moves = await getStackMoves(holdings, prices, NOW);
  assert.deepStrictEqual(moves.map(m => m.key), ['month']);
});

test('a held metal with no price then is left out and named', async () => {
  priceRows = [{ timestamp: daysAgo(7.1), gold_price: 4100, silver_price: 55, platinum_price: null, palladium_price: null }];
  const stack = [
    { metal: 'gold', weight: 1, quantity: 10, purchase_date: '2024-04-01' },
    { metal: 'platinum', weight: 1, quantity: 5, purchase_date: '2024-04-01' },
  ];
  const moves = await getStackMoves(stack, prices, NOW);
  const week = moves.find(m => m.key === 'week');
  assert.strictEqual(week.before, 41000);
  assert.deepStrictEqual(week.missing, ['platinum']);
  const text = formatStackMoves(moves);
  assert.match(text, /- Last 7 days: \+\$1000\.00 \(\+2\.4%\)\. Gold \$4100\.00 to \$4200\.00\. Platinum isn't counted, since there's no price to compare it with\.\n/);
});
