// Platinum and palladium come from Yahoo with gold and silver, and the
// sparkline covers the last 24 trading hours.
//   node --test
// In-process only: axios and supabase are replaced with fakes, no network.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

process.env.SUPABASE_URL ||= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-dummy-service-role-key';

const SRC = path.join(__dirname, '..', 'src');
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
  assert.deepStrictEqual(got, { gold: 4320.9, silver: 64.69, platinum: 1797.7, palladium: 1276, source: 'yahoo_finance' });
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

  delete rates.XPT;
  const viaLastKnown = await fetchFromYahooFinance();
  assert.strictEqual(viaLastKnown.platinum, 1801.5, 'falls back to the last live platinum, not the startup value');
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
