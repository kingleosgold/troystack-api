// What Troy knows about today: services/troy-context.js. No network.
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildMarketBlock, createMarketContext, plain, usableOneLiner } = require('../src/services/troy-context');

const SPOT = {
  prices: { gold: 4198.4, silver: 60.35, platinum: 1679.7, palladium: 1155 },
  change: {
    gold: { amount: 17.2, percent: 0.41, prevClose: 4181.2 },
    silver: { amount: 0.62, percent: 1.04, prevClose: 59.73 },
    platinum: { amount: -3.1, percent: -0.18, prevClose: 1682.8 },
    palladium: {},
  },
  marketsClosed: false,
};

const SIGNAL = {
  title: 'Fed minutes hammered paper gold, but the PBOC\u2019s record physical buying tells the real story',
  troy_one_liner: 'Paper sold the Fed minutes \u2014 physical buyers in Beijing bought the dip.',
  troy_commentary: 'Long commentary.',
  published_at: '2026-10-08T21:30:00Z',
};

test('the block names each move, the latest Signal and the newest headlines', () => {
  const block = buildMarketBlock({
    spot: SPOT,
    signal: SIGNAL,
    headlines: [
      { title: 'Gold\u2019s resilience tested by yields \u2014 and a strong dollar', published_at: '2026-10-08T20:00:00Z' },
      { title: 'Mexico silver output slips again', published_at: '2026-10-07T15:00:00Z' },
    ],
  });
  assert.match(block, /Gold: up \$17\.20 \(0\.41%\) since the last close/);
  assert.match(block, /Silver: up \$0\.62 \(1\.04%\) since the last close/);
  assert.match(block, /Platinum: down \$3\.10 \(0\.18%\) since the last close/);
  assert.match(block, /Palladium: change since the last close unavailable/);
  assert.ok(!block.includes('4,198') && !block.includes('60.35'), "spot itself is left to the route's part of the prompt");
  assert.match(block, /YOUR LATEST STACK SIGNAL \(published Oct 8, 2026\):/);
  assert.match(block, /physical buyers in Beijing bought the dip/);
  assert.match(block, /- Mexico silver output slips again \(Oct 7, 2026\)/);
  assert.ok(!/[\u2014]/.test(block), 'no long dashes reach Troy');
  assert.match(block, /Don't invent headlines/);
});

test('a cut-off one-liner falls back to the commentary, and closed markets are said', () => {
  const block = buildMarketBlock({ spot: { ...SPOT, marketsClosed: true }, signal: { ...SIGNAL, troy_one_liner: 'Fed' }, headlines: [] });
  assert.match(block, /Long commentary\./);
  assert.match(block, /Markets are closed right now/);
  assert.ok(!block.includes('NEWEST HEADLINES'));
});

test('nothing fetched means no block at all', () => {
  assert.equal(buildMarketBlock({ spot: null, signal: null, headlines: [] }), '');
  assert.equal(buildMarketBlock(), '');
});

test('helpers keep words and drop long dashes', () => {
  assert.equal(plain('Gold \u2014 up again'), 'Gold, up again');
  assert.equal(plain('1990\u20132011'), '1990-2011');
  assert.equal(usableOneLiner('Fed'), '');
  assert.equal(usableOneLiner('Silver broke out of its range today.'), 'Silver broke out of its range today.');
});

function fakeDb({ fail = false, syntheses = 0 } = {}) {
  const calls = [];
  // Newest first: a run of synthesis editions, then an ordinary story.
  const rows = [
    ...Array.from({ length: syntheses }, (_, i) => ({ ...SIGNAL, title: `Edition ${i}`, is_stack_signal: true })),
    { title: 'A headline that matters today', published_at: '2026-10-08T20:00:00Z', is_stack_signal: false },
    { ...SIGNAL, is_stack_signal: true },
  ];
  function query() {
    const q = {
      filters: {},
      orFilter: null,
      select() { return q; },
      eq(col, val) { q.filters[col] = val; return q; },
      or(expr) { q.orFilter = expr; return q; },
      order() { return q; },
      limit(n) {
        calls.push(q.filters.is_stack_signal === true ? 'signal' : 'headlines');
        if (fail) return Promise.resolve({ data: null, error: { message: 'db down' } });
        let data = rows;
        if (q.filters.is_stack_signal === true) data = rows.filter((r) => r.is_stack_signal);
        if (q.orFilter === 'is_stack_signal.is.null,is_stack_signal.eq.false') data = rows.filter((r) => !r.is_stack_signal);
        return Promise.resolve({ data: data.slice(0, n), error: null });
      },
    };
    return q;
  }
  return { calls, from: () => query() };
}

test('moves are read with every question, the Signal reads are kept for five minutes', async () => {
  let t = 0;
  let spot = SPOT;
  let spotCalls = 0;
  const db = fakeDb();
  const get = createMarketContext({ fetchSpot: async () => { spotCalls += 1; return spot; }, db, now: () => t });
  const first = await get();
  assert.match(first, /TODAY'S MARKET/);
  assert.match(first, /A headline that matters today/);
  assert.ok(!/- Fed minutes/.test(first), 'the synthesis is not listed again as a headline');
  assert.equal(db.calls.length, 2);

  // A minute later the price cron has moved silver. The next answer says so,
  // without reading the database again.
  t = 60 * 1000;
  spot = { ...SPOT, change: { ...SPOT.change, silver: { amount: 0.91, percent: 1.52 } } };
  const second = await get();
  assert.match(second, /Silver: up \$0\.91 \(1\.52%\)/);
  assert.equal(spotCalls, 2);
  assert.equal(db.calls.length, 2);

  t = 6 * 60 * 1000;
  await get();
  assert.equal(db.calls.length, 4);
});

test('failed parts are left out, and an empty read is retried soon', async () => {
  let t = 0;
  const db = fakeDb({ fail: true });
  const get = createMarketContext({ fetchSpot: async () => { throw new Error('feed down'); }, db, now: () => t });
  assert.equal(await get(), '');
  t = 20 * 1000;
  await get();
  assert.equal(db.calls.length, 2, 'not yet');
  t = 31 * 1000;
  await get();
  assert.equal(db.calls.length, 4);
});

test('the moves still come through when the database is down', async () => {
  const get = createMarketContext({ fetchSpot: async () => SPOT, db: fakeDb({ fail: true }), now: () => 0 });
  const block = await get();
  assert.match(block, /Gold: up \$17\.20/);
  assert.ok(!block.includes('STACK SIGNAL'));
});

test('headlines come through even after a run of synthesis editions', async () => {
  const get = createMarketContext({ fetchSpot: async () => SPOT, db: fakeDb({ syntheses: 12 }), now: () => 0 });
  const block = await get();
  assert.match(block, /- A headline that matters today/);
  assert.ok(!/- Edition/.test(block), 'syntheses are not listed as headlines');
});

test('questions that arrive during a refresh share it', async () => {
  let spotCalls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const db = fakeDb();
  const get = createMarketContext({ fetchSpot: async () => { spotCalls += 1; await gate; return SPOT; }, db, now: () => 0 });
  const answers = Promise.all([get(), get(), get()]);
  release();
  const [a, b, c] = await answers;
  assert.equal(spotCalls, 1, 'one spot read');
  assert.equal(db.calls.length, 2, 'one signal read and one headlines read');
  assert.equal(a, b);
  assert.equal(b, c);
});
