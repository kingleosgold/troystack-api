// The widget's daily change measures from the same reference as /v1/prices,
// the last reading of the previous futures session, not a rolling 24 hours.
//   node --test
// In-process only: supabase is replaced with a fake, no network.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

process.env.SUPABASE_URL ||= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-dummy-service-role-key';

test.before(() => { test.mock.method(console, 'log', () => {}); test.mock.method(console, 'error', () => {}); });
test.after(() => { test.mock.restoreAll(); });

const SRC = path.join(__dirname, '..', 'src');
const SUPABASE_PATH = require.resolve(path.join(SRC, 'lib', 'supabase'));
const WIDGET_PATH = require.resolve(path.join(SRC, 'routes', 'widget'));
const FETCHER_PATH = require.resolve(path.join(SRC, 'services', 'price-fetcher'));

// Load the widget route, and the price fetcher it reads the reference from,
// fresh against `supabase`, then put the real modules back.
function loadWidget(supabase) {
  const saved = require.cache[SUPABASE_PATH];
  delete require.cache[WIDGET_PATH];
  delete require.cache[FETCHER_PATH];
  require.cache[SUPABASE_PATH] = { id: SUPABASE_PATH, filename: SUPABASE_PATH, loaded: true, exports: supabase };
  try {
    return require(WIDGET_PATH);
  } finally {
    delete require.cache[WIDGET_PATH];
    delete require.cache[FETCHER_PATH];
    if (saved) require.cache[SUPABASE_PATH] = saved; else delete require.cache[SUPABASE_PATH];
  }
}

// A price_log that answers a bounded read with the newest row in the window,
// an unbounded one with the newest row of all, and the sparkline's paged read
// with nothing. Counts the bounded reads.
function priceLog(rows) {
  let boundedReads = 0;
  const from = () => {
    let gte = null;
    let lt = null;
    let lte = null;
    let gt = null;
    const q = {
      select: () => q, order: () => q, limit: () => q,
      gte: (_c, v) => { gte = v; return q; },
      lt: (_c, v) => { lt = v; return q; },
      lte: (_c, v) => { lte = v; return q; },
      gt: (c, v) => { gt = [c, v]; return q; },
      range: () => Promise.resolve({ data: [], error: null }),
      single: () => {
        if (gte || lt || lte) boundedReads += 1;
        const hit = rows
          .filter((r) => (!gte || r.timestamp >= gte) && (!lt || r.timestamp < lt) && (!lte || r.timestamp <= lte) && (!gt || r[gt[0]] > gt[1]))
          .sort((a, b) => b.timestamp.localeCompare(a.timestamp));
        return Promise.resolve(hit.length ? { data: hit[0], error: null } : { data: null, error: { message: 'no rows' } });
      },
    };
    return q;
  };
  return { from, boundedReads: () => boundedReads };
}

const row = (timestamp, gold, silver) => ({ timestamp, gold_price: gold, silver_price: silver, platinum_price: 1550, palladium_price: 1100 });

async function getWidget(router) {
  const layer = router.stack.find((l) => l.route && l.route.path === '/widget-data');
  let body;
  let status = 200;
  const res = { json: (b) => { body = b; return res; }, status: (s) => { status = s; return res; } };
  await layer.route.stack[0].handle({ query: {} }, res);
  return { status, body };
}

test("the widget's change measures from the previous session's last reading", async (t) => {
  // Thursday's session closes at 5 PM EST, 22:00 UTC, and Friday's opens at 23:00 UTC.
  const db = priceLog([
    row('2026-11-12T14:00:00.000Z', 3850, 49.5), // a rolling 24 hours would land here
    row('2026-11-12T22:55:00.000Z', 3881.7, 49.96), // Thursday's last reading
    row('2026-11-12T23:55:00.000Z', 3882.9, 50), // Friday's session
    row('2026-11-13T15:00:00.000Z', 3900, 50.5), // now
  ]);
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-13T15:00:30Z') });
  const { status, body } = await getWidget(loadWidget(db));
  assert.strictEqual(status, 200);
  assert.strictEqual(body.change.gold.prevClose, 3881.7);
  assert.strictEqual(body.change.silver.prevClose, 49.96);
  assert.strictEqual(body.change.gold.amount, 18.3);
  assert.strictEqual(body.change.gold.percent, 0.47);
  assert.strictEqual(body.metals[0].change_pct, 0.47);
  assert.strictEqual(body.metals[1].change_pct, 1.08);
});

test('over the weekend the widget keeps showing Friday against Thursday', async (t) => {
  const db = priceLog([
    row('2026-11-12T22:55:00.000Z', 3881.7, 49.96), // Thursday's last reading
    row('2026-11-13T21:59:00.000Z', 3920, 50.2), // Friday's last reading
  ]);
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-14T15:00:00Z') }); // Saturday
  const { body } = await getWidget(loadWidget(db));
  assert.strictEqual(body.change.gold.prevClose, 3881.7);
  assert.strictEqual(body.change.gold.amount, 38.3);
});

test('once Sunday evening opens the widget measures from Friday', async (t) => {
  const db = priceLog([
    row('2026-11-12T22:55:00.000Z', 3881.7, 49.96),
    row('2026-11-13T21:59:00.000Z', 3920, 50.2),
    row('2026-11-15T23:30:00.000Z', 3925, 50.3),
  ]);
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-15T23:30:30Z') });
  const { body } = await getWidget(loadWidget(db));
  assert.strictEqual(body.change.gold.prevClose, 3920);
  assert.strictEqual(body.change.gold.amount, 5);
});

test('with nothing logged for the reference session the change reads zero, not an older move', async (t) => {
  const db = priceLog([
    row('2026-11-11T21:00:00.000Z', 3800, 49), // Wednesday only
    row('2026-11-13T15:00:00.000Z', 3900, 50.5),
  ]);
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-13T15:00:30Z') });
  const { status, body } = await getWidget(loadWidget(db));
  assert.strictEqual(status, 200);
  assert.strictEqual(body.change.gold.percent, 0);
  assert.strictEqual(body.change.gold.prevClose, 3900);
});

test('the reference is read once per session, not on every widget request', async (t) => {
  const db = priceLog([
    row('2026-11-12T22:55:00.000Z', 3881.7, 49.96),
    row('2026-11-13T15:00:00.000Z', 3900, 50.5),
  ]);
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-13T15:00:30Z') });
  const router = loadWidget(db);
  await getWidget(router);
  await getWidget(router);
  await getWidget(router);
  assert.strictEqual(db.boundedReads(), 1);
});

test('a metal missing from the newest reading reads no change, not a 100% drop', async (t) => {
  const db = priceLog([
    row('2026-11-12T22:55:00.000Z', 3881.7, 49.96),
    { timestamp: '2026-11-13T15:00:00.000Z', gold_price: 3900, silver_price: 50.5, platinum_price: null, palladium_price: 0 },
  ]);
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-13T15:00:30Z') });
  const { status, body } = await getWidget(loadWidget(db));
  assert.strictEqual(status, 200);
  assert.strictEqual(body.change.platinum.percent, 0);
  assert.strictEqual(body.change.platinum.amount, 0);
  assert.strictEqual(body.change.platinum.prevClose, 1550);
  assert.strictEqual(body.change.palladium.percent, 0);
  assert.strictEqual(body.metals[2].change_pct, 0);
  assert.strictEqual(body.metals[3].change_pct, 0);
  assert.strictEqual(body.change.gold.percent, 0.47);
});

test('a metal missing from the newest reading shows its last logged price with no change', async (t) => {
  const db = priceLog([
    row('2026-11-12T22:55:00.000Z', 3881.7, 49.96),
    { timestamp: '2026-11-13T14:00:00.000Z', gold_price: 3890, silver_price: 50.4, platinum_price: 1561.2, palladium_price: 1104.5 },
    { timestamp: '2026-11-13T15:00:00.000Z', gold_price: 3900, silver_price: 50.5, platinum_price: null, palladium_price: 0 },
  ]);
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-13T15:00:30Z') });
  const { status, body } = await getWidget(loadWidget(db));
  assert.strictEqual(status, 200);
  assert.strictEqual(body.metals[2].price, 1561.2);
  assert.strictEqual(body.metals[3].price, 1104.5);
  assert.strictEqual(body.metals[2].change_pct, 0);
  assert.strictEqual(body.metals[3].change_pct, 0);
  assert.deepStrictEqual(body.change.palladium, { amount: 0, percent: 0, prevClose: 1100 });
  assert.strictEqual(body.metals[0].price, 3900);
  assert.strictEqual(body.change.gold.percent, 0.47);
});

test('a metal missing on both sides shows its last logged price and no change', async (t) => {
  const db = priceLog([
    { timestamp: '2026-11-12T20:00:00.000Z', gold_price: 3870, silver_price: 49.9, platinum_price: 1540, palladium_price: 1090 },
    { timestamp: '2026-11-12T22:55:00.000Z', gold_price: 3881.7, silver_price: 49.96, platinum_price: null, palladium_price: null },
    { timestamp: '2026-11-13T15:00:00.000Z', gold_price: 3900, silver_price: 50.5, platinum_price: null, palladium_price: 0 },
  ]);
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-13T15:00:30Z') });
  const { status, body } = await getWidget(loadWidget(db));
  assert.strictEqual(status, 200);
  assert.strictEqual(body.metals[3].price, 1090);
  assert.deepStrictEqual(body.change.palladium, { amount: 0, percent: 0, prevClose: 1090 });
  assert.deepStrictEqual(body.change.platinum, { amount: 0, percent: 0, prevClose: 1540 });
});

test('a metal never logged with a price stays null rather than failing the widget', async (t) => {
  const db = priceLog([
    { timestamp: '2026-11-12T22:55:00.000Z', gold_price: 3881.7, silver_price: 49.96, platinum_price: null, palladium_price: 1100 },
    { timestamp: '2026-11-13T15:00:00.000Z', gold_price: 3900, silver_price: 50.5, platinum_price: null, palladium_price: 1100 },
  ]);
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-13T15:00:30Z') });
  const { status, body } = await getWidget(loadWidget(db));
  assert.strictEqual(status, 200);
  assert.strictEqual(body.metals[2].price, null);
  assert.deepStrictEqual(body.change.platinum, { amount: 0, percent: 0, prevClose: null });
  assert.strictEqual(body.change.palladium.percent, 0);
  assert.strictEqual(body.change.palladium.prevClose, 1100);
});
