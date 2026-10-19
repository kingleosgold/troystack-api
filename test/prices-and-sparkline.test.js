// Platinum and palladium come from Yahoo with gold and silver, and the
// sparkline covers the last 24 trading hours.
//   node --test
// In-process only: axios and supabase are replaced with fakes, no network.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

process.env.SUPABASE_URL ||= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-dummy-service-role-key';

// The price fetcher logs a lot, and its lines are kept out of stdout while
// this file runs. Node 22's runner reads a test file's output in chunks, and a
// log line that arrives in the same chunk right after one of the runner's own
// messages is read as a message, which fails the whole file. The Friday close
// is written in the background now, so its log line can land between tests.
test.before(() => { test.mock.method(console, 'log', () => {}); });
test.after(() => { test.mock.restoreAll(); });

const SRC = path.join(__dirname, '..', 'src');
const { buildMarketBlock } = require(path.join(SRC, 'services', 'troy-context'));
const SUPABASE_PATH = require.resolve(path.join(SRC, 'lib', 'supabase'));
const AXIOS_PATH = require.resolve('axios');

function fakeModule(filename, exports) {
  return { id: filename, filename, loaded: true, exports };
}

// Load `target` with fakes in place of supabase (and axios when given), then
// put the real modules back.
function loadWith(target, { supabase, axios }) {
  const targetPath = require.resolve(path.join(SRC, target));
  const saved = { supa: require.cache[SUPABASE_PATH], axios: require.cache[AXIOS_PATH] };
  delete require.cache[targetPath];
  require.cache[SUPABASE_PATH] = fakeModule(SUPABASE_PATH, supabase);
  if (axios) require.cache[AXIOS_PATH] = fakeModule(AXIOS_PATH, axios);
  try {
    return require(targetPath);
  } finally {
    delete require.cache[targetPath];
    if (saved.supa) require.cache[SUPABASE_PATH] = saved.supa; else delete require.cache[SUPABASE_PATH];
    if (saved.axios) require.cache[AXIOS_PATH] = saved.axios; else delete require.cache[AXIOS_PATH];
  }
}

// ---------- price fetcher ----------

function fakeAxios(quotes, metalPriceRates) {
  return {
    get: async (url) => {
      const yahoo = url.match(/\/chart\/([A-Z]+=F)$/);
      if (yahoo) {
        const price = quotes[yahoo[1]];
        if (price == null) throw new Error(`no quote for ${yahoo[1]}`);
        return { data: { chart: { result: [{ meta: { regularMarketPrice: price } }] } } };
      }
      if (url.includes('metalpriceapi.com') && metalPriceRates) return { data: { rates: metalPriceRates } };
      throw new Error(`unexpected url ${url}`);
    },
  };
}

test('all four metals come from Yahoo when it answers', async () => {
  const { fetchFromYahooFinance } = loadWith('services/price-fetcher', {
    supabase: {},
    axios: fakeAxios({ 'GC=F': 4320.9, 'SI=F': 64.69, 'PL=F': 1797.7, 'PA=F': 1276 }),
  });
  const got = await fetchFromYahooFinance();
  assert.deepStrictEqual(got, {
    gold: 4320.9, silver: 64.69, platinum: 1797.7, palladium: 1276, source: 'yahoo_finance',
    live: { gold: true, silver: true, platinum: true, palladium: true },
  });
});

test('a platinum miss on Yahoo falls back to MetalPriceAPI, then to the last live value', async () => {
  process.env.METAL_PRICE_API_KEY ||= 'test-key';
  const quotes = { 'GC=F': 4320.9, 'SI=F': 64.69, 'PL=F': 1797.7, 'PA=F': 1276 };
  const rates = { XPT: 1 / 1801.5, XPD: 1 / 1279.25 };
  const axios = fakeAxios(quotes, rates);
  const { fetchFromYahooFinance } = loadWith('services/price-fetcher', { supabase: {}, axios });

  await fetchFromYahooFinance(); // live Pt 1797.7 becomes the last known value
  delete quotes['PL=F'];
  const viaMetalPrice = await fetchFromYahooFinance();
  assert.strictEqual(viaMetalPrice.platinum, 1801.5);
  assert.strictEqual(viaMetalPrice.palladium, 1276, 'palladium still comes from Yahoo');
  assert.strictEqual(viaMetalPrice.live.platinum, true, 'MetalPriceAPI is a live read too');

  delete rates.XPT;
  const viaLastKnown = await fetchFromYahooFinance();
  assert.strictEqual(viaLastKnown.platinum, 1801.5, 'falls back to the last live platinum, not the startup value');
  assert.deepStrictEqual(viaLastKnown.live, { gold: true, silver: true, platinum: false, palladium: true }, "this time's platinum wasn't read live");
});

test('no gold or silver from Yahoo still fails the source', async () => {
  const { fetchFromYahooFinance } = loadWith('services/price-fetcher', {
    supabase: {},
    axios: fakeAxios({ 'SI=F': 64.69, 'PL=F': 1797.7, 'PA=F': 1276 }),
  });
  await assert.rejects(fetchFromYahooFinance(), /no gold\/silver/);
});

// ---------- sparkline ----------

// One row a minute between two instants, newest first like the real query.
function minuteRows(startIso, endIso) {
  const rows = [];
  const start = Date.parse(startIso);
  for (let t = start, i = 0; t <= Date.parse(endIso); t += 60 * 1000, i++) {
    rows.push({
      timestamp: new Date(t).toISOString(),
      gold_price: 4300 + (i % 50) * 0.2,
      silver_price: 64 + (i % 40) * 0.01,
      platinum_price: 1790 + (i % 30) * 0.1,
      palladium_price: 1270 + (i % 20) * 0.1,
    });
  }
  return rows.reverse();
}

// Answers .from().select().order().range(a, b) from `rows`, never returning
// more than `cap` rows per call, like a PostgREST row cap.
function fakePriceLog(rows, cap) {
  const calls = [];
  const query = {
    select() { return query; },
    order(col, opts) { assert.strictEqual(opts.ascending, false, 'reads newest first'); return query; },
    range(from, to) {
      calls.push([from, to]);
      const n = Math.min(to - from + 1, cap);
      return Promise.resolve({ data: rows.slice(from, from + n), error: null });
    },
  };
  return { client: { from: () => query }, calls };
}

async function getSparkline(router) {
  const layer = router.stack.find((l) => l.route && l.route.path === '/sparkline-24h');
  let body;
  const res = { json: (b) => { body = b; }, status() { return res; } };
  await layer.route.stack[0].handle({ query: {} }, res);
  return body;
}

test('weekday sparkline spans the last 24 trading hours and ends on the newest price', async () => {
  // Tue 2026-09-22 08:00 ET to Wed 2026-09-23 12:00 ET (EDT is UTC-4)
  const rows = minuteRows('2026-09-22T12:00:00Z', '2026-09-23T16:00:00Z');
  const { client, calls } = fakePriceLog(rows, 1000);
  const body = await getSparkline(loadWith('routes/widget', { supabase: client }));

  assert.strictEqual(body.success, true);
  for (const metal of ['gold', 'silver', 'platinum', 'palladium']) {
    assert.strictEqual(body.sparklines[metal].length, 96, `${metal} has 96 points`);
  }
  const first = Date.parse(body.timestamps[0]);
  const last = Date.parse(body.timestamps[95]);
  assert.strictEqual(body.timestamps[95], rows[0].timestamp, 'the last point is the newest row');
  assert.ok(last - first >= 23.5 * 3600 * 1000, 'about 24 hours, not 96 minutes');
  assert.ok(new Set(body.sparklines.platinum).size > 1, 'platinum moves');
  assert.strictEqual(calls.length, 2, 'two pages of 1,000 cover ~1,440 minutes');
});

test('a smaller row cap still pages through to 24 hours', async () => {
  const rows = minuteRows('2026-09-22T12:00:00Z', '2026-09-23T16:00:00Z');
  const { client } = fakePriceLog(rows, 500);
  const body = await getSparkline(loadWith('routes/widget', { supabase: client }));
  assert.strictEqual(body.sparklines.gold.length, 96);
  assert.ok(Date.parse(body.timestamps[95]) - Date.parse(body.timestamps[0]) >= 23.5 * 3600 * 1000);
});

test('on a Saturday the sparkline skips weekend rows and ends at Friday close', async () => {
  // Thu 2026-09-24 12:00 ET to Fri 2026-09-25 16:59 ET, plus rows logged Saturday
  const friday = minuteRows('2026-09-24T16:00:00Z', '2026-09-25T20:59:00Z');
  const saturday = minuteRows('2026-09-26T04:00:00Z', '2026-09-26T04:30:00Z');
  const { client } = fakePriceLog([...saturday, ...friday], 1000);
  const body = await getSparkline(loadWith('routes/widget', { supabase: client }));

  assert.strictEqual(body.sparklines.gold.length, 96);
  assert.strictEqual(body.timestamps[95], '2026-09-25T20:59:00.000Z', 'last point is Friday 4:59 PM ET');
  assert.ok(body.timestamps.every((t) => !t.startsWith('2026-09-26')), 'no Saturday rows');
});

// ---------- one reading for Troy ----------

// A Supabase stand-in that answers every chain. app_state gives the saved
// Friday close and every other table has nothing.
function chainable(fridayClose) {
  return {
    from(table) {
      const result = table === 'app_state' ? { data: { value: fridayClose }, error: null } : { data: null, error: null };
      const q = new Proxy({}, {
        get(_, prop) {
          if (prop === 'then') return (resolve, reject) => Promise.resolve(result).then(resolve, reject);
          return () => q;
        },
      });
      return q;
    },
  };
}

const FRIDAY = {
  prices: { gold: 4210.5, silver: 61.2, platinum: 1690, palladium: 1160 },
  change: { gold: { amount: 12.3, percent: 0.29 }, silver: { amount: -0.4, percent: -0.65 }, platinum: {}, palladium: {}, source: 'calculated' },
  source: 'yahoo_finance',
  timestamp: '2026-10-09T20:59:00.000Z',
};
const offline = { get: async () => { throw new Error('offline'); } };

test("over a weekend Troy's price reading is the Friday close, the same one the app gets", async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-10T16:00:00Z') }); // Saturday, noon in New York
  const fetcher = loadWith('services/price-fetcher', { supabase: chainable(FRIDAY), axios: offline });
  await fetcher.initPriceFetcher();
  const snap = fetcher.getPriceSnapshot();
  assert.deepStrictEqual(snap.prices, FRIDAY.prices);
  assert.deepStrictEqual(snap.change, FRIDAY.change);
  assert.strictEqual(snap.source, 'yahoo_finance (friday-close)');
  assert.strictEqual(snap.marketsClosed, true);
  assert.strictEqual(snap.quotedAt, FRIDAY.timestamp, "an older live close without quotedAt gives the time it was saved");
  const app = await fetcher.getSpotPrices();
  assert.deepStrictEqual(app.prices, snap.prices);
  assert.deepStrictEqual(app.change, snap.change);
});

test('on a trading day the reading is the live cache, whatever Friday left', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-08T16:00:00Z') }); // Thursday
  const fetcher = loadWith('services/price-fetcher', { supabase: chainable(FRIDAY), axios: offline });
  await fetcher.initPriceFetcher();
  const snap = fetcher.getPriceSnapshot();
  assert.strictEqual(snap.marketsClosed, false);
  assert.strictEqual(snap.source, 'static-fallback');
  assert.notDeepStrictEqual(snap.prices, FRIDAY.prices);
});

test('price reads that arrive together share one live fetch', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-08T16:00:00Z') }); // Thursday
  let goldQuotes = 0;
  const axios = fakeAxios({ 'GC=F': 4320.9, 'SI=F': 64.69, 'PL=F': 1797.7, 'PA=F': 1276 });
  const counting = {
    get: async (url) => {
      if (url.endsWith('GC=F')) goldQuotes += 1;
      return axios.get(url);
    },
  };
  const fetcher = loadWith('services/price-fetcher', { supabase: chainable(null), axios: counting });
  const [a, b, c] = await Promise.all([fetcher.getSpotPrices(), fetcher.getSpotPrices(), fetcher.fetchLiveSpotPrices()]);
  assert.strictEqual(goldQuotes, 1, 'one trip to Yahoo for all three');
  assert.strictEqual(a.prices.gold, 4320.9);
  assert.deepStrictEqual(a.prices, b.prices);
  assert.deepStrictEqual(c.prices, a.prices, 'the cron and the reads get the same fetch');
  await fetcher.fetchLiveSpotPrices();
  assert.strictEqual(goldQuotes, 2, 'a later fetch goes out again');
});

test("built-in prices stay labeled built-in when the next fetch fails too", async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-08T16:00:00Z') }); // Thursday
  const fetcher = loadWith('services/price-fetcher', { supabase: chainable(null), axios: offline });
  await fetcher.fetchLiveSpotPrices();
  assert.strictEqual(fetcher.getPriceSnapshot().source, 'static-fallback');
  await fetcher.fetchLiveSpotPrices();
  assert.strictEqual(fetcher.getPriceSnapshot().source, 'static-fallback', 'never relabeled as a cached reading');
});

// A database whose read of yesterday's prices hangs until the test lets it go,
// the first read unless the test names another. Rows written to price_log are
// kept so the test can check them.
function stallingDb(hangOnRead = 1) {
  let reached;
  let release;
  const stalled = new Promise((resolve) => { reached = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const logged = [];
  let reads = 0;
  const query = {
    select: () => query, gte: () => query, lte: () => query, order: () => query, limit: () => query,
    single: () => {
      reads += 1;
      if (reads !== hangOnRead) return Promise.resolve({ data: null, error: null });
      reached();
      return gate.then(() => ({ data: null, error: null }));
    },
    insert: (row) => { logged.push(row); return Promise.resolve({ error: null }); },
    upsert: () => Promise.resolve({ error: null }),
  };
  return { stalled, release: () => release(), logged, from: () => query };
}

test('a replaced fetch that finishes late leaves the newer prices alone', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-09T21:30:00Z') }); // Friday, 5:30 PM in New York
  const quotes = { 'GC=F': 5140.5, 'SI=F': 86.9, 'PL=F': 2160, 'PA=F': 1775 };
  const db = stallingDb();
  const fetcher = loadWith('services/price-fetcher', { supabase: db, axios: fakeAxios(quotes) });

  // The first fetch reads gold at $5,140.50, then hangs on the database.
  const slow = fetcher.fetchLiveSpotPrices();
  await db.stalled;

  // Half a minute later the next caller replaces it and reads $5,160.25.
  quotes['GC=F'] = 5160.25;
  t.mock.timers.tick(31 * 1000);
  await fetcher.fetchLiveSpotPrices();

  // Then the first fetch comes back.
  db.release();
  await slow;
  assert.strictEqual(fetcher.getCachedPrices().gold, 5160.25, 'the cache keeps the newer price');
  assert.strictEqual(fetcher.getPriceSnapshot().prices.gold, 5160.25, 'so does the Friday close');
  assert.deepStrictEqual(db.logged.map((row) => row.gold_price), [5160.25], 'only the newer price went to price_log');
});

// Lets waiting promise callbacks run without moving the mocked clock.
const settle = () => new Promise((resolve) => setImmediate(resolve));

test('a fetch that hangs on a database read releases its callers with the cached prices at 30 seconds', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.parse('2026-10-08T16:00:00Z') }); // Thursday, noon in New York
  const quotes = { 'GC=F': 4320.9, 'SI=F': 64.69, 'PL=F': 1797.7, 'PA=F': 1276 };
  const db = stallingDb(2); // the second fetch hangs on its read of yesterday's prices
  const fetcher = loadWith('services/price-fetcher', { supabase: db, axios: fakeAxios(quotes) });

  // A good fetch puts gold at $4,320.90 in the cache.
  await fetcher.fetchLiveSpotPrices();

  // Two minutes on, the cache is stale, so a price read and the cron share the
  // next fetch. It reads gold at $4,400, then hangs on the database.
  t.mock.timers.tick(2 * 60 * 1000);
  quotes['GC=F'] = 4400;
  const released = {};
  fetcher.getSpotPrices().then((reading) => { released.read = reading; });
  fetcher.fetchLiveSpotPrices().then((cache) => { released.cron = cache; });
  await db.stalled;

  t.mock.timers.tick(29 * 1000);
  await settle();
  assert.deepStrictEqual(released, {}, 'both still wait at 29 seconds');

  t.mock.timers.tick(1000);
  await settle();
  assert.strictEqual(released.read?.prices.gold, 4320.9, 'the price read gets the cached price');
  assert.strictEqual(released.cron?.prices.gold, 4320.9, 'and so does the cron');

  // The next caller starts a fresh fetch, and the hung one writes nothing once it's let go.
  quotes['GC=F'] = 4450;
  await fetcher.fetchLiveSpotPrices();
  assert.strictEqual(fetcher.getCachedPrices().gold, 4450);
  db.release();
  await settle();
  assert.strictEqual(fetcher.getCachedPrices().gold, 4450, "the replaced fetch didn't put back $4,400");
});

test('a caller who joins a hung fetch at 20 seconds is released at 30, not 50', async (t) => {
  const start = Date.parse('2026-10-08T16:00:00Z'); // Thursday, noon in New York
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: start });
  let goldQuotes = 0;
  const yahoo = fakeAxios({ 'GC=F': 4320.9, 'SI=F': 64.69, 'PL=F': 1797.7, 'PA=F': 1276 });
  const counting = {
    get: async (url) => {
      if (url.endsWith('GC=F')) goldQuotes += 1;
      return yahoo.get(url);
    },
  };
  const db = stallingDb();
  const fetcher = loadWith('services/price-fetcher', { supabase: db, axios: counting });

  let firstAt = null;
  let lateAt = null;
  fetcher.fetchLiveSpotPrices().then(() => { firstAt = Date.now() - start; });
  await db.stalled;

  t.mock.timers.tick(20 * 1000);
  fetcher.fetchLiveSpotPrices().then(() => { lateAt = Date.now() - start; });
  assert.strictEqual(goldQuotes, 1, 'the late caller joins the fetch already running');

  t.mock.timers.tick(9999);
  await settle();
  assert.strictEqual(lateAt, null, 'still waiting just before 30 seconds');

  t.mock.timers.tick(1);
  await settle();
  assert.strictEqual(firstAt, 30 * 1000);
  assert.strictEqual(lateAt, 30 * 1000, 'released 30 seconds after the fetch started, not 30 after it joined');

  db.release();
  await settle();
});

// A database that keeps the Friday close in app_state. The test can hold
// Friday close writes on their way in and let them go one at a time, and
// `landed` lists the gold price of each close in the order its write landed.
// It can also hold the next read of the Friday close ('close') or of the last
// platinum and palladium prices ('ptpd'), and a held read answers with what
// was stored when it was made.
function fridayCloseDb(stored = null) {
  let holding = 0;
  const held = [];
  const landed = [];
  const heldReads = {};
  const land = (close) => { stored = close; landed.push(close.prices.gold); return { error: null }; };
  const missing = { data: null, error: { code: 'PGRST116' } };
  return {
    landed,
    stored: () => stored,
    hold: (count) => { holding = count; },
    release: () => held.shift()(),
    holdRead(kind) {
      let release;
      heldReads[kind] = new Promise((resolve) => { release = resolve; });
      return () => release();
    },
    from(table) {
      let kind = table === 'app_state' ? 'close' : 'yesterday';
      const q = {
        select: () => q, eq: () => q, gte: () => q, lte: () => q, order: () => q, limit: () => q,
        gt: () => { kind = 'ptpd'; return q; },
        single: () => {
          const answer = table === 'app_state' && stored ? { data: { value: stored }, error: null } : missing;
          const gate = heldReads[kind];
          delete heldReads[kind];
          return gate ? gate.then(() => answer) : Promise.resolve(answer);
        },
        insert: () => Promise.resolve({ error: null }),
        upsert: (row) => {
          if (holding === 0) return Promise.resolve(land(row.value));
          holding -= 1;
          return new Promise((resolve) => held.push(() => resolve(land(row.value))));
        },
      };
      return q;
    },
  };
}

const FRIDAY_QUOTES = { 'GC=F': 4300, 'SI=F': 64.5, 'PL=F': 1790, 'PA=F': 1270 };

test("a Friday close write that stalls can't land after a newer close", async (t) => {
  // Friday, 4:30 PM in New York, when every fetch saves the Friday close.
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.parse('2026-10-09T20:30:00Z') });
  const quotes = { ...FRIDAY_QUOTES };
  const db = fridayCloseDb();
  const fetcher = loadWith('services/price-fetcher', { supabase: db, axios: fakeAxios(quotes) });

  // The 4:30 fetch saves a $4,300 close, and its write stalls on the way to the database.
  db.hold(1);
  const first = fetcher.fetchLiveSpotPrices();
  await settle();

  // A minute later the next fetch saves a $4,310 close without waiting on that write.
  t.mock.timers.tick(60 * 1000);
  await first;
  quotes['GC=F'] = 4310;
  let secondDone = false;
  fetcher.fetchLiveSpotPrices().then(() => { secondDone = true; });
  await settle();
  assert.ok(secondDone, "the newer fetch doesn't wait on the stalled write");

  // After the close the app reads the newer close, and then the stalled write goes through.
  t.mock.timers.tick(30 * 60 * 1000); // 5:01 PM, markets closed
  assert.strictEqual(fetcher.getPriceSnapshot().prices.gold, 4310);
  db.release();
  await settle();
  assert.deepStrictEqual(db.landed, [4300, 4310], 'the newer close lands after the stalled one, not before');
  assert.strictEqual(db.stored().prices.gold, 4310);

  // A restart over the weekend reads the newer close back.
  t.mock.timers.setTime(Date.parse('2026-10-10T16:00:00Z')); // Saturday, noon in New York
  const restarted = loadWith('services/price-fetcher', { supabase: db, axios: offline });
  await restarted.initPriceFetcher();
  assert.strictEqual(restarted.getPriceSnapshot().prices.gold, 4310);
});

test('a Friday close replaced while its write waited is never written', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.parse('2026-10-09T20:30:00Z') }); // Friday, 4:30 PM in New York
  const quotes = { ...FRIDAY_QUOTES };
  const db = fridayCloseDb();
  const fetcher = loadWith('services/price-fetcher', { supabase: db, axios: fakeAxios(quotes) });

  db.hold(1);
  const first = fetcher.fetchLiveSpotPrices();
  await settle();

  // While the first write is stuck, fetches a minute apart save closes at $4,310 and $4,320.
  for (const gold of [4310, 4320]) {
    t.mock.timers.tick(60 * 1000);
    quotes['GC=F'] = gold;
    await fetcher.fetchLiveSpotPrices();
  }
  await first;

  db.release();
  await settle();
  assert.deepStrictEqual(db.landed, [4300, 4320], 'the $4,310 close was replaced before its turn, so only the newest follows the stalled write');
  assert.strictEqual(db.stored().prices.gold, 4320);
});

// The close app_state holds before the restarts below, read live at 3 PM on Friday.
const STORED_AT_3PM = {
  prices: { gold: 4200, silver: 63, platinum: 1780, palladium: 1260 },
  change: { gold: {}, silver: {}, platinum: {}, palladium: {}, source: 'unavailable' },
  source: 'yahoo_finance',
  timestamp: '2026-10-09T19:00:00.000Z',
  quotedAt: '2026-10-09T19:00:00.000Z',
  savedAt: '2026-10-09T19:00:00.000Z',
};

test('a startup read of the Friday close that comes back late keeps a newer close saved since', async (t) => {
  // Friday, 5:30 PM in New York, right after a restart.
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.parse('2026-10-09T21:30:00Z') });
  const db = fridayCloseDb(STORED_AT_3PM);
  const fetcher = loadWith('services/price-fetcher', { supabase: db, axios: fakeAxios({ ...FRIDAY_QUOTES, 'GC=F': 4310 }) });

  // The startup read is slow, and a price request's fetch saves a $4,310 close first.
  const releaseLoad = db.holdRead('close');
  const releasePtPd = db.holdRead('ptpd');
  const init = fetcher.initPriceFetcher();
  await fetcher.getSpotPrices();

  // Then the read comes back with the $4,200 close from 3 PM. Startup waits on
  // its next read here, before its own fetch saves another close.
  releaseLoad();
  await settle();
  assert.strictEqual(fetcher.getPriceSnapshot().prices.gold, 4310, 'the close saved since startup is newer, so it stays');

  releasePtPd();
  await init;
});

test('built-in prices never become the Friday close, and the stored one stands', async (t) => {
  // Friday, 5:30 PM in New York, right after a restart, with the feeds down.
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.parse('2026-10-09T21:30:00Z') });
  const db = fridayCloseDb(STORED_AT_3PM);
  const fetcher = loadWith('services/price-fetcher', { supabase: db, axios: offline });

  // A price request's fetch runs before the startup read is back, and startup's own fetch after it.
  const releaseLoad = db.holdRead('close');
  const init = fetcher.initPriceFetcher();
  await fetcher.getSpotPrices();
  releaseLoad();
  await init;
  await settle();

  // Both fetches had only built-in prices, so neither saved a close.
  assert.deepStrictEqual(db.landed, []);
  const snap = fetcher.getPriceSnapshot();
  assert.strictEqual(snap.source, 'yahoo_finance (friday-close)');
  assert.strictEqual(snap.prices.gold, 4200);
});

// A close saved on built-in prices, from before they stopped being saved.
const STORED_BUILT_IN = {
  prices: { gold: 5150, silver: 87, platinum: 2170, palladium: 1780 },
  change: { gold: {}, silver: {}, platinum: {}, palladium: {}, source: 'unavailable' },
  source: 'static-fallback',
  timestamp: '2026-10-09T20:45:00.000Z',
  quotedAt: null,
  savedAt: '2026-10-09T20:45:00.000Z',
};

test('a stored close on built-in prices goes unused, and a weekend reading never stands built-in prices in for one', async (t) => {
  // Saturday, noon in New York, right after a restart, with the feeds down.
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.parse('2026-10-10T16:00:00Z') });
  const db = fridayCloseDb(STORED_BUILT_IN);
  const fetcher = loadWith('services/price-fetcher', { supabase: db, axios: offline });
  await fetcher.initPriceFetcher();

  const reading = await fetcher.getSpotPrices();
  assert.strictEqual(reading.source, 'static-fallback', 'the built-in prices, not passed off as a Friday close');
  assert.deepStrictEqual(db.landed, []);
});

test('a weekend reading before the startup read is back leaves the stored close to it', async (t) => {
  // Saturday, noon in New York, right after a restart. The feeds answer with Friday's last trade.
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.parse('2026-10-10T16:00:00Z') });
  const db = fridayCloseDb(FRIDAY);
  const fetcher = loadWith('services/price-fetcher', { supabase: db, axios: fakeAxios({ ...FRIDAY_QUOTES, 'GC=F': 4310 }) });

  // Two price requests come in while the startup read of the stored close is slow.
  const releaseLoad = db.holdRead('close');
  const init = fetcher.initPriceFetcher();
  await fetcher.getSpotPrices();
  await fetcher.getSpotPrices();
  releaseLoad();
  await init;
  await settle();

  // Nothing stood in for the close, so the weekend reads Friday's close and its moves, not a flat day.
  assert.deepStrictEqual(db.landed, []);
  const snap = fetcher.getPriceSnapshot();
  assert.deepStrictEqual(snap.prices, FRIDAY.prices);
  assert.deepStrictEqual(snap.change, FRIDAY.change);
});

test('failed fetches keep the time of the last live price, and the reading reports it', async (t) => {
  // Friday, 4 PM in New York. The feeds answer once, then stay down through the close.
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-09T20:00:00Z') });
  let online = true;
  const live = fakeAxios({ 'GC=F': 4320.9, 'SI=F': 64.69, 'PL=F': 1797.7, 'PA=F': 1276 });
  const fetcher = loadWith('services/price-fetcher', {
    supabase: chainable(null),
    axios: { get: (url) => (online ? live : offline).get(url) },
  });
  await fetcher.fetchLiveSpotPrices();
  online = false;
  for (let i = 0; i < 3; i++) {
    t.mock.timers.tick(60 * 1000);
    await fetcher.fetchLiveSpotPrices();
  }

  const snap = fetcher.getPriceSnapshot();
  assert.strictEqual(snap.source, 'cached-fallback');
  assert.strictEqual(snap.prices.gold, 4320.9);
  assert.strictEqual(snap.timestamp, '2026-10-09T20:03:00.000Z', 'the cache was rebuilt by the last failed fetch');
  assert.strictEqual(snap.quotedAt, '2026-10-09T20:00:00.000Z', 'but its prices were read at 4 PM');
  assert.strictEqual((await fetcher.getSpotPrices()).quotedAt, snap.quotedAt, "the app's reading says the same");
  assert.match(buildMarketBlock({ spot: snap }), /the last price read, Oct 9, 2026, 4:00 PM ET,/, 'and so does Troy');

  // Still down after the close, so the weekend reading is a Friday close saved from the cache.
  t.mock.timers.tick(90 * 60 * 1000);
  await fetcher.fetchLiveSpotPrices();
  const weekend = fetcher.getPriceSnapshot();
  assert.strictEqual(weekend.source, 'cached-fallback (friday-close)');
  assert.strictEqual(weekend.quotedAt, '2026-10-09T20:00:00.000Z');
});

// Like chainable, with yesterday's prices in price_log so today's moves can be measured.
function withYesterday(row) {
  return {
    from(table) {
      const result = table === 'price_log' ? { data: row, error: null } : { data: null, error: null };
      const q = new Proxy({}, {
        get(_, prop) {
          if (prop === 'then') return (resolve, reject) => Promise.resolve(result).then(resolve, reject);
          return () => q;
        },
      });
      return q;
    },
  };
}

test("a metal Yahoo leaves out has no move in Troy's reading, live or as the Friday close", async (t) => {
  // Friday, 4:30 PM in New York. Yahoo answers for every metal but platinum,
  // so the fetch falls back to an older platinum price.
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.parse('2026-10-09T20:30:00Z') });
  const yesterday = { gold_price: 4280, silver_price: 64, platinum_price: 1700, palladium_price: 1250 };
  const fetcher = loadWith('services/price-fetcher', {
    supabase: withYesterday(yesterday),
    axios: fakeAxios({ 'GC=F': 4300, 'SI=F': 64.5, 'PA=F': 1270 }),
  });
  await fetcher.fetchLiveSpotPrices();

  const snap = fetcher.getPriceSnapshot();
  assert.deepStrictEqual(snap.live, { gold: true, silver: true, platinum: false, palladium: true });
  const block = buildMarketBlock({ spot: snap });
  assert.match(block, /Gold: up \$20\.00 \(0\.47%\) today/);
  assert.match(block, /Palladium: up \$20\.00 \(1\.60%\) today/);
  assert.match(block, /Platinum: today's change unavailable/);

  // The app's reading keeps its numbers and carries the same flags.
  const app = await fetcher.getSpotPrices();
  assert.deepStrictEqual(app.change, snap.change);
  assert.deepStrictEqual(app.live, snap.live);

  // After the close the reading is the Friday close, and platinum still has no move.
  t.mock.timers.tick(31 * 60 * 1000);
  const friday = fetcher.getPriceSnapshot();
  assert.strictEqual(friday.source, 'yahoo_finance (friday-close)');
  assert.deepStrictEqual(friday.live, snap.live);
  assert.match(buildMarketBlock({ spot: friday }), /Platinum: today's change unavailable/);
  assert.deepStrictEqual((await fetcher.getSpotPrices()).live, snap.live);
});

test('when MetalPriceAPI stands in for Yahoo, a metal it leaves out is marked as not read live', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.parse('2026-10-08T16:00:00Z') }); // Thursday
  process.env.METAL_PRICE_API_KEY ||= 'test-key';
  // Yahoo has nothing, and MetalPriceAPI has every metal but platinum.
  const rates = { XAU: 1 / 4300, XAG: 1 / 64.5, XPD: 1 / 1270 };
  const fetcher = loadWith('services/price-fetcher', { supabase: chainable(null), axios: fakeAxios({}, rates) });
  await fetcher.fetchLiveSpotPrices();
  const snap = fetcher.getPriceSnapshot();
  assert.strictEqual(snap.source, 'metalpriceapi');
  assert.deepStrictEqual(snap.live, { gold: true, silver: true, platinum: false, palladium: true });
});
