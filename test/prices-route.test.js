// GET /v1/prices says when its prices were read live, not only when the
// reading was rebuilt.
//   node --test
// In-process only: the price fetcher is replaced with a fake, no network.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

process.env.SUPABASE_URL ||= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-dummy-service-role-key';

const SRC = path.join(__dirname, '..', 'src');
const ROUTE_PATH = require.resolve(path.join(SRC, 'routes', 'prices'));
const FETCHER_PATH = require.resolve(path.join(SRC, 'services', 'price-fetcher'));
const SUPABASE_PATH = require.resolve(path.join(SRC, 'lib', 'supabase'));

test.before(() => { test.mock.method(console, 'log', () => {}); });
test.after(() => { test.mock.restoreAll(); });

function fakeModule(filename, exports) {
  return { id: filename, filename, loaded: true, exports };
}

// Load routes/prices with getSpotPrices answering `reading`.
function loadRoute(reading) {
  const saved = { route: require.cache[ROUTE_PATH], fetcher: require.cache[FETCHER_PATH], supa: require.cache[SUPABASE_PATH] };
  delete require.cache[ROUTE_PATH];
  require.cache[FETCHER_PATH] = fakeModule(FETCHER_PATH, {
    getSpotPrices: async () => reading,
    getCachedPrices: () => reading.prices,
  });
  require.cache[SUPABASE_PATH] = fakeModule(SUPABASE_PATH, {});
  try {
    return require(ROUTE_PATH);
  } finally {
    delete require.cache[ROUTE_PATH];
    for (const [key, p] of [['route', ROUTE_PATH], ['fetcher', FETCHER_PATH], ['supa', SUPABASE_PATH]]) {
      if (saved[key]) require.cache[p] = saved[key]; else delete require.cache[p];
    }
  }
}

async function getPrices(reading) {
  const router = loadRoute(reading);
  const layer = router.stack.find((l) => l.route && l.route.path === '/' && l.route.methods.get);
  let body;
  const res = { status() { return this; }, json(b) { body = b; return this; } };
  await layer.route.stack[0].handle({ query: {} }, res);
  return body;
}

const PRICES = { gold: 4020.5, silver: 50.25, platinum: 1600, palladium: 1100 };
const CHANGE = { gold: { percent: 0.5 }, silver: { percent: -1 }, platinum: {}, palladium: {}, source: 'calculated' };

test('a cached fallback answers with the time its prices were last read live', async () => {
  const body = await getPrices({
    prices: PRICES, change: CHANGE, source: 'cached-fallback', cacheAgeMinutes: 0, marketsClosed: false,
    timestamp: '2026-11-16T15:10:00.000Z', quotedAt: '2026-11-16T14:52:00.000Z',
  });
  assert.strictEqual(body.success, true);
  assert.strictEqual(body.timestamp, '2026-11-16T15:10:00.000Z', 'timestamp is still the rebuild time');
  assert.strictEqual(body.quotedAt, '2026-11-16T14:52:00.000Z', 'quotedAt is the last live read');
  assert.strictEqual(body.prices.gold.price, 4020.5);
});

test('prices never read live answer quotedAt null, never a missing field', async () => {
  const body = await getPrices({
    prices: PRICES, change: CHANGE, source: 'static-fallback', cacheAgeMinutes: 0, marketsClosed: false,
    timestamp: '2026-11-16T15:10:00.000Z', quotedAt: null,
  });
  assert.ok('quotedAt' in body);
  assert.strictEqual(body.quotedAt, null);
});

test('a reading missing the quotedAt key still answers quotedAt null', async () => {
  const body = await getPrices({
    prices: PRICES, change: CHANGE, source: 'yahoo_finance (friday-close)', cacheAgeMinutes: 0, marketsClosed: true,
    timestamp: '2026-11-13T21:59:50.000Z',
  });
  assert.strictEqual(body.quotedAt, null);
  assert.strictEqual(body.marketsClosed, true);
});

test('the OpenAPI spec for /v1/prices marks quotedAt nullable and requires it', async () => {
  const llms = require(path.join(SRC, 'routes', 'llms'));
  const layer = llms.stack.find((l) => l.route && l.route.path === '/openapi.json');
  let spec;
  layer.route.stack[0].handle({}, { json(b) { spec = b; return this; } });
  const schema = spec.paths['/v1/prices'].get.responses['200'].content['application/json'].schema;
  assert.strictEqual(schema.properties.quotedAt.nullable, true);
  assert.strictEqual(schema.properties.quotedAt.format, 'date-time');
  assert.ok(schema.required.includes('quotedAt'), 'quotedAt is always sent, null or not');
  assert.ok(!schema.properties.timestamp.nullable, 'timestamp is never null');
  const body = await getPrices({
    prices: PRICES, change: CHANGE, source: 'static-fallback', cacheAgeMinutes: 0, marketsClosed: false,
    timestamp: '2026-11-16T15:10:00.000Z', quotedAt: null,
  });
  for (const key of schema.required) assert.ok(key in body, `the route sends ${key}`);
  for (const key of Object.keys(body)) assert.ok(key in schema.properties, `the spec names ${key}`);
});

// A small check of a body against the spec's schema: every required key is
// sent, every sent key is named, and each value has the named type.
function checkAgainst(schema, value, where) {
  if (value === null) {
    assert.ok(schema.nullable, `${where} is null but the spec doesn't allow it`);
    return;
  }
  if (schema.type === 'object') {
    assert.strictEqual(typeof value, 'object', `${where} is an object`);
    for (const key of schema.required || []) assert.ok(key in value, `${where} sends ${key}`);
    for (const [key, v] of Object.entries(value)) {
      assert.ok(schema.properties && key in schema.properties, `the spec names ${where}.${key}`);
      checkAgainst(schema.properties[key], v, `${where}.${key}`);
    }
    return;
  }
  const type = schema.type === 'integer' ? 'number' : schema.type;
  assert.strictEqual(typeof value, type, `${where} is a ${schema.type}`);
  if (schema.format === 'date-time') assert.ok(!Number.isNaN(Date.parse(value)), `${where} is a date-time`);
}

function pricesSchema() {
  const llms = require(path.join(SRC, 'routes', 'llms'));
  const layer = llms.stack.find((l) => l.route && l.route.path === '/openapi.json');
  let spec;
  layer.route.stack[0].handle({}, { json(b) { spec = b; return this; } });
  return spec.paths['/v1/prices'].get.responses['200'].content['application/json'].schema;
}

const FULL_CHANGE = {
  gold: { amount: 20.1, percent: 0.5, prevClose: 4000.4 },
  silver: { amount: -0.51, percent: -1, prevClose: 50.76 },
  platinum: {}, palladium: {}, source: 'calculated',
};
const NO_CHANGE = { gold: {}, silver: {}, platinum: {}, palladium: {}, source: 'unavailable' };

for (const [name, reading] of [
  ['a fresh fetch', {
    prices: PRICES, change: FULL_CHANGE, source: 'yahoo_finance', cacheAgeMinutes: 0, marketsClosed: false,
    timestamp: '2026-11-16T15:10:00.000Z', quotedAt: '2026-11-16T15:10:00.000Z',
  }],
  ['a cache hit', {
    prices: PRICES, change: FULL_CHANGE, source: 'yahoo_finance', cacheAgeMinutes: 3.4, marketsClosed: false,
    timestamp: '2026-11-16T15:10:00.000Z', quotedAt: '2026-11-16T15:10:00.000Z', live: { gold: true }, spikeRejected: false,
  }],
  ['a Friday close', {
    prices: PRICES, change: NO_CHANGE, source: 'yahoo_finance (friday-close)', cacheAgeMinutes: 0, marketsClosed: true,
    timestamp: '2026-11-13T21:59:41.000Z', quotedAt: '2026-11-13T21:59:41.000Z', live: { gold: true },
  }],
  ['prices never read live', {
    prices: PRICES, change: NO_CHANGE, source: 'static-fallback', cacheAgeMinutes: 0, marketsClosed: false,
    timestamp: '2026-11-16T15:10:00.000Z', quotedAt: null,
  }],
]) {
  test(`the /v1/prices body for ${name} matches its OpenAPI schema`, async () => {
    checkAgainst(pricesSchema(), await getPrices(reading), 'body');
  });
}

test('the spec requires cacheAgeMinutes and the change of all four metals', () => {
  const schema = pricesSchema();
  assert.ok(schema.required.includes('cacheAgeMinutes'));
  assert.ok(schema.required.includes('change'));
  assert.deepStrictEqual(schema.properties.change.required, ['gold', 'silver', 'platinum', 'palladium', 'source']);
  assert.match(schema.properties.timestamp.description, /Friday close is stored/);
  assert.deepStrictEqual(schema.properties.change.properties.source.enum, ['calculated', 'unavailable']);
});
