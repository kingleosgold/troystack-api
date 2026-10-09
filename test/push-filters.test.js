// Price alert routes refuse ids that would change their PostgREST filters.
//   node --test
// Pure in-process tests: supabase is replaced with a recording fake.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

process.env.SUPABASE_URL ||= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-dummy-service-role-key';

const USER = '11111111-1111-4111-8111-111111111111';
const ALERT = '33333333-3333-4333-8333-333333333333';

// Records every filter call and answers like an empty table.
function recordingSupabase(log) {
  const chain = new Proxy({}, {
    get(_, prop) {
      if (prop === 'then') {
        return (resolve) => resolve({ data: [], error: null });
      }
      return (...args) => {
        log.push([prop, ...args]);
        if (prop === 'single') return Promise.resolve({ data: { id: ALERT }, error: null });
        return chain;
      };
    },
  });
  return { from: (table) => { log.push(['from', table]); return chain; } };
}

function loadPushRouter(log) {
  const supabasePath = require.resolve(path.join(__dirname, '..', 'src', 'lib', 'supabase'));
  const pushPath = require.resolve(path.join(__dirname, '..', 'src', 'routes', 'push'));
  delete require.cache[pushPath];
  require.cache[supabasePath] = { id: supabasePath, filename: supabasePath, loaded: true, exports: recordingSupabase(log) };
  try {
    return require(pushPath);
  } finally {
    delete require.cache[supabasePath];
    delete require.cache[pushPath];
  }
}

async function call(router, method, routePath, req) {
  const layer = router.stack.find((l) => l.route && l.route.path === routePath && l.route.methods[method]);
  assert.ok(layer, `${method} ${routePath} exists`);
  let status = 200;
  let body;
  const res = {
    status(code) { status = code; return res; },
    json(b) { body = b; return res; },
  };
  await layer.route.stack[0].handle({ params: {}, query: {}, body: {}, ...req }, res);
  return { status, body };
}

const INJECTION = 'x,user_id.not.is.null';

test('isDeviceId takes Expo ids and the anon fallback, nothing with filter syntax', () => {
  const { isDeviceId } = loadPushRouter([]);
  assert.strictEqual(isDeviceId('6F9619FF-8B86-D011-B42D-00C04FC964FF'), true);
  assert.strictEqual(isDeviceId('anon-1727712000000'), true);
  for (const bad of [INJECTION, 'a.b', 'a(b)', '', 'x'.repeat(101), 42, null, undefined]) {
    assert.strictEqual(isDeviceId(bad), false, `refuses ${String(bad)}`);
  }
});

test('listing alerts refuses an injected device_id before any query runs', async () => {
  const log = [];
  const router = loadPushRouter(log);
  const res = await call(router, 'get', '/price-alerts', { query: { device_id: INJECTION } });
  assert.strictEqual(res.status, 400);
  assert.ok(!log.some(([op]) => op === 'or'), 'no or() filter was built');
});

test('a valid listing builds the same or() filter as before', async () => {
  const log = [];
  const router = loadPushRouter(log);
  const res = await call(router, 'get', '/price-alerts', { query: { user_id: USER, device_id: 'anon-1727712000000' } });
  assert.strictEqual(res.status, 200);
  const or = log.find(([op]) => op === 'or');
  assert.deepStrictEqual(or, ['or', `user_id.eq.${USER},device_id.eq.anon-1727712000000`]);
});

test('deleting all alerts refuses an injected device_id', async () => {
  const log = [];
  const router = loadPushRouter(log);
  const res = await call(router, 'delete', '/price-alerts', { query: { user_id: USER, device_id: INJECTION } });
  assert.strictEqual(res.status, 400);
  assert.ok(!log.some(([op]) => op === 'delete'), 'nothing was deleted');
});

test('creating an alert refuses a bad device_id or a non-UUID id', async () => {
  const router = loadPushRouter([]);
  const base = { metal: 'silver', targetPrice: 60, direction: 'above' };
  assert.strictEqual((await call(router, 'post', '/price-alerts', { body: { ...base, device_id: INJECTION } })).status, 400);
  assert.strictEqual((await call(router, 'post', '/price-alerts', { body: { ...base, device_id: 'anon-1', id: '1727712000000' } })).status, 400);
  assert.strictEqual((await call(router, 'post', '/price-alerts', { body: { ...base, device_id: 'anon-1', id: ALERT } })).status, 200);
  assert.strictEqual((await call(router, 'post', '/price-alerts', { body: { ...base, userId: USER } })).status, 200);
});

test('editing or deleting one alert needs a UUID id', async () => {
  const router = loadPushRouter([]);
  assert.strictEqual((await call(router, 'patch', '/price-alerts/:id', { params: { id: 'not-a-uuid' }, body: { enabled: false } })).status, 400);
  assert.strictEqual((await call(router, 'delete', '/price-alerts/:id', { params: { id: 'not-a-uuid' } })).status, 400);
  assert.strictEqual((await call(router, 'patch', '/price-alerts/:id', { params: { id: ALERT }, body: { enabled: false } })).status, 200);
  assert.strictEqual((await call(router, 'delete', '/price-alerts/:id', { params: { id: ALERT } })).status, 200);
});
