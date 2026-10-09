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
  assert.match(block, /Gold: up \$17\.20 \(0\.41%\) today/);
  assert.match(block, /Silver: up \$0\.62 \(1\.04%\) today/);
  assert.match(block, /Platinum: down \$3\.10 \(0\.18%\) today/);
  assert.match(block, /Palladium: today's change unavailable/);
  assert.ok(!block.includes('4,198') && !block.includes('60.35'), "spot itself is left to the route's part of the prompt");
  assert.match(block, /YOUR LATEST STACK SIGNAL \(published Oct 8, 2026, 5:30 PM ET\):/);
  assert.match(block, /Prices and moves in the Signal are as of when it was published/);
  assert.match(block, /use only CURRENT SPOT and TODAY'S MARKET/);
  assert.match(block, /physical buyers in Beijing bought the dip/);
  assert.match(block, /- Mexico silver output slips again \(Oct 7, 2026\)/);
  assert.ok(!/[\u2014]/.test(block), 'no long dashes reach Troy');
  assert.match(block, /Don't invent headlines/);
});

test('dates are New York dates, so an evening article keeps its own day', () => {
  // Stack Signal writes in the evening ET, after midnight UTC.
  const block = buildMarketBlock({
    spot: SPOT,
    signal: { ...SIGNAL, published_at: '2026-10-09T00:30:00Z' },
    headlines: [{ title: 'Oil surge revives inflation fears', published_at: '2026-10-09T00:45:00Z' }],
  });
  assert.match(block, /YOUR LATEST STACK SIGNAL \(published Oct 8, 2026, 8:30 PM ET\):/);
  assert.match(block, /- Oil surge revives inflation fears \(Oct 8, 2026\)/);
});

test('a cut-off one-liner falls back to the commentary, and closed markets are said', () => {
  const block = buildMarketBlock({ spot: { ...SPOT, marketsClosed: true }, signal: { ...SIGNAL, troy_one_liner: 'Fed' }, headlines: [] });
  assert.match(block, /Long commentary\./);
  assert.match(block, /Markets are closed right now/);
  assert.ok(!block.includes('NEWEST HEADLINES'));
});

test('the block opens with the date and time in New York', () => {
  const block = buildMarketBlock({ spot: SPOT, now: Date.parse('2026-10-09T18:05:00Z') });
  assert.ok(block.startsWith('RIGHT NOW: Friday, October 9, 2026, 2:05 PM ET.'));
  assert.ok(!block.includes('as of when it was published'), 'no Signal, so nothing to warn about');
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
  // Which reads fail right now. Tests can change these between questions.
  const failing = { signal: fail, headlines: fail };
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
        const kind = q.filters.is_stack_signal === true ? 'signal' : 'headlines';
        calls.push(kind);
        if (failing[kind]) return Promise.resolve({ data: null, error: { message: 'db down' } });
        let data = rows;
        if (q.filters.is_stack_signal === true) data = rows.filter((r) => r.is_stack_signal);
        if (q.orFilter === 'is_stack_signal.is.null,is_stack_signal.eq.false') data = rows.filter((r) => !r.is_stack_signal);
        return Promise.resolve({ data: data.slice(0, n), error: null });
      },
    };
    return q;
  }
  return { calls, failing, from: () => query() };
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

test('a read that fails keeps the last good answer and is tried again soon', async () => {
  let t = 0;
  const db = fakeDb();
  const get = createMarketContext({ fetchSpot: async () => SPOT, db, now: () => t });
  await get();
  db.failing.signal = true;
  db.failing.headlines = true;
  t = 6 * 60 * 1000;
  const block = await get();
  assert.match(block, /YOUR LATEST STACK SIGNAL/);
  assert.match(block, /A headline that matters today/);
  assert.equal(db.calls.length, 4);
  db.failing.signal = false;
  db.failing.headlines = false;
  t += 31 * 1000;
  await get();
  assert.equal(db.calls.length, 6, 'tried again after half a minute');
});

test('one read failing does not hold the other back', async () => {
  let t = 0;
  const db = fakeDb();
  db.failing.signal = true;
  const get = createMarketContext({ fetchSpot: async () => SPOT, db, now: () => t });
  const first = await get();
  assert.ok(!first.includes('STACK SIGNAL ('), 'no Signal yet');
  assert.match(first, /A headline that matters today/);
  db.failing.signal = false;
  t = 31 * 1000;
  const second = await get();
  assert.match(second, /YOUR LATEST STACK SIGNAL/);
  assert.deepEqual(db.calls, ['signal', 'headlines', 'signal'], 'only the failed read went again');
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

test('moves are left out when prices come from a fallback, and Troy is told prices are stale', () => {
  for (const source of ['static-fallback', 'cached-fallback', 'static-fallback (friday-close)']) {
    const block = buildMarketBlock({ spot: { ...SPOT, source, timestamp: '2026-10-09T13:40:00Z' }, signal: SIGNAL });
    assert.ok(!block.includes("TODAY'S MARKET"), source);
    assert.ok(!block.includes('use only CURRENT SPOT'), 'a stale CURRENT SPOT is never called the price now');
    assert.match(block, /live prices are unavailable right now/);
    assert.match(block, /YOUR LATEST STACK SIGNAL/, 'the rest still comes through');
  }
  const placeholder = buildMarketBlock({ spot: { ...SPOT, source: 'static-fallback' } });
  assert.match(placeholder, /placeholder numbers, not market prices\. Don't quote them\./);
  // The time given is when the prices were last read live, not when the last failed fetch rebuilt the cache.
  const cached = buildMarketBlock({ spot: { ...SPOT, source: 'cached-fallback', timestamp: '2026-10-09T15:02:00Z', quotedAt: '2026-10-09T13:40:00Z' } });
  assert.match(cached, /CURRENT SPOT is the last price read, Oct 9, 2026, 9:40 AM ET, and may be out of date/);
  assert.ok(!cached.includes('11:02'), 'not the time of the last failed fetch');
  const unknown = buildMarketBlock({ spot: { ...SPOT, source: 'cached-fallback (friday-close)', quotedAt: null } });
  assert.match(unknown, /CURRENT SPOT is the last price read, and may be out of date/, "no time when it isn't known");
  const live = buildMarketBlock({ spot: { ...SPOT, source: 'yahoo_finance' } });
  assert.match(live, /Gold: up \$17\.20/);
  assert.ok(!live.includes('PRICES RIGHT NOW'));
});

test('a stalled read gives way to the last good answer instead of holding the question', async () => {
  let t = 0;
  let hang = false;
  const db = fakeDb();
  const never = new Promise(() => {});
  const stalling = {
    from(table) {
      const q = db.from(table);
      const limit = q.limit;
      q.limit = (n) => (hang ? never : limit(n));
      return q;
    },
  };
  const get = createMarketContext({ fetchSpot: async () => (hang ? never : SPOT), db: stalling, now: () => t, waitMs: 20 });
  const first = await get();
  assert.match(first, /YOUR LATEST STACK SIGNAL/);
  hang = true;
  t += 6 * 60 * 1000;
  const started = Date.now();
  const second = await get();
  assert.ok(Date.now() - started < 1000, 'answered without waiting on the stalled reads');
  assert.match(second, /YOUR LATEST STACK SIGNAL/, 'the last good Signal is kept');
  assert.match(second, /A headline that matters today/);
  assert.ok(!second.includes("TODAY'S MARKET"), 'no moves while spot is stalled');
});

test("a route's own price reading is used for the moves instead of a second read", async () => {
  let spotCalls = 0;
  const db = fakeDb();
  const get = createMarketContext({ fetchSpot: async () => { spotCalls += 1; return SPOT; }, db, now: () => 0 });
  const mine = { ...SPOT, change: { ...SPOT.change, gold: { amount: -5, percent: -0.12 } } };
  const block = await get(mine);
  assert.equal(spotCalls, 0, 'no second spot read');
  assert.match(block, /Gold: down \$5\.00 \(0\.12%\) today/);
});

test('a read that hangs is given up on, and its late answer never replaces a newer one', async () => {
  let t = 0;
  const db = fakeDb();
  let release;
  let signalReads = 0;
  const hanging = {
    from(table) {
      const q = db.from(table);
      const limit = q.limit;
      q.limit = (n) => {
        if (q.filters.is_stack_signal !== true) return limit(n);
        signalReads += 1;
        if (signalReads === 1) {
          // The first Signal read hangs until the test lets it answer, late and stale.
          return new Promise((resolve) => {
            release = () => resolve({ data: [{ ...SIGNAL, troy_one_liner: 'An old read that came back late.' }], error: null });
          });
        }
        return limit(n);
      };
      return q;
    },
  };
  const get = createMarketContext({ fetchSpot: async () => SPOT, db: hanging, now: () => t, waitMs: 20, stallMs: 10_000 });
  const first = await get();
  assert.ok(!first.includes('STACK SIGNAL ('), 'nothing yet while the read hangs');
  t = 5_000;
  await get();
  assert.equal(signalReads, 1, 'a read still inside its time is shared');
  t = 11_000;
  const third = await get();
  assert.equal(signalReads, 2, 'a hung read is given up on');
  assert.match(third, /physical buyers in Beijing bought the dip/);
  release();
  await new Promise((r) => setTimeout(r, 0));
  t = 12_000;
  const fourth = await get();
  assert.match(fourth, /physical buyers in Beijing bought the dip/, 'the late answer is ignored');
  assert.ok(!fourth.includes('An old read'));
});

test('a spot read that hangs is given up on too', async () => {
  let t = 0;
  let spotReads = 0;
  const get = createMarketContext({
    fetchSpot: () => {
      spotReads += 1;
      return spotReads === 1 ? new Promise(() => {}) : Promise.resolve(SPOT);
    },
    db: fakeDb(),
    now: () => t,
    waitMs: 20,
    stallMs: 10_000,
  });
  assert.ok(!(await get()).includes("TODAY'S MARKET"));
  t = 11_000;
  assert.match(await get(), /Gold: up \$17\.20/);
  assert.equal(spotReads, 2);
});
