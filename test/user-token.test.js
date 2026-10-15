// The session check on routes that take a user id.
//   node --test
// Pure in-process tests: supabase is a fake and req and res are plain objects.

const test = require('node:test');
const assert = require('node:assert');

const { createUserTokenCheck, claimedUserIds, routeLabel } = require('../src/middleware/user-token');

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const GOOD = 'aaa.bbb.ccc';
const BAD = 'ddd.eee.fff';

function fakeSupabase() {
  return {
    auth: {
      getUser: async (token) => (token === GOOD
        ? { data: { user: { id: USER } }, error: null }
        : { data: { user: null }, error: { message: 'invalid JWT' } }),
    },
  };
}

function call(check, { method = 'GET', baseUrl = '/v1/push', path = '/price-alerts', body, query = {}, token } = {}) {
  const req = { method, baseUrl, path, body, query, headers: token ? { authorization: `Bearer ${token}` } : {} };
  const res = {
    statusCode: 200,
    payload: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; },
  };
  let passed = false;
  return Promise.resolve(check(req, res, () => { passed = true; })).then(() => ({ req, res, passed }));
}

function setup(opts = {}) {
  const logs = [];
  const check = createUserTokenCheck({ supabase: fakeSupabase(), log: (line) => logs.push(line), ...opts });
  return { check, logs };
}

test('a call naming no user passes without a log', async () => {
  const { check, logs } = setup();
  const { passed, res } = await call(check, { query: { device_id: 'abc' } });
  assert.equal(passed, true);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(logs, []);
});

test('a user id with no token still passes, and is counted without the id', async () => {
  const { check, logs } = setup();
  const { passed } = await call(check, { query: { user_id: USER } });
  assert.equal(passed, true);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /no session GET \/v1\/push\/price-alerts/);
  assert.ok(!logs[0].includes(USER));
});

test('a token that fails the check passes in step one and is counted', async () => {
  const { check, logs } = setup();
  const { passed } = await call(check, { body: { userId: USER }, method: 'POST', token: BAD });
  assert.equal(passed, true);
  assert.match(logs[0], /session not verified/);
});

test('an API key in the header is not taken for a session', async () => {
  const { check, logs } = setup();
  const { passed } = await call(check, { query: { userId: USER }, token: 'ts_live_0123456789abcdef' });
  assert.equal(passed, true);
  assert.match(logs[0], /no session/);
});

test('a valid token for the same account passes and names the session user', async () => {
  const { check, logs } = setup();
  const { passed, req } = await call(check, { body: { userId: USER.toUpperCase() }, method: 'POST', token: GOOD });
  assert.equal(passed, true);
  assert.equal(req.sessionUserId, USER);
  assert.deepEqual(logs, []);
});

test('a valid token naming another account is refused with 403', async () => {
  const { check, logs } = setup();
  const { passed, res } = await call(check, { query: { userId: OTHER }, token: GOOD });
  assert.equal(passed, false);
  assert.equal(res.statusCode, 403);
  assert.match(logs[0], /refused another account/);
  assert.ok(!logs[0].includes(OTHER));
});

test('any mismatched id in the call is refused, even next to the right one', async () => {
  const { check } = setup();
  const { res } = await call(check, { body: { userId: USER, user_id: OTHER }, method: 'POST', token: GOOD });
  assert.equal(res.statusCode, 403);
});

test('snapshots read the user id from the path', async () => {
  const { check } = setup({ pathUserId: true });
  const other = await call(check, { baseUrl: '/v1/snapshots', path: `/${OTHER}`, token: GOOD });
  assert.equal(other.res.statusCode, 403);
  const own = await call(check, { baseUrl: '/v1/snapshots', path: `/${USER}`, token: GOOD });
  assert.equal(own.passed, true);
});

test('a user id sent as an array is checked like a string', async () => {
  const { check } = setup();
  const other = await call(check, { body: { userId: [OTHER] }, method: 'POST', token: GOOD });
  assert.equal(other.res.statusCode, 403);
  const own = await call(check, { query: { userId: [USER] }, token: GOOD });
  assert.equal(own.passed, true);
});

test('a user id that is not a string still counts as a claim', async () => {
  const { check, logs } = setup();
  const signed = await call(check, { body: { userId: { id: OTHER } }, method: 'POST', token: GOOD });
  assert.equal(signed.res.statusCode, 403);
  const unsigned = await call(check, { body: { userId: [OTHER] }, method: 'POST' });
  assert.equal(unsigned.passed, true);
  assert.match(logs[logs.length - 1], /no session/);
});

test('a percent-escaped snapshot path is decoded before it is checked', async () => {
  const { check } = setup({ pathUserId: true });
  const escaped = OTHER.replace(/2/g, '%32');
  const { res } = await call(check, { baseUrl: '/v1/snapshots', path: `/${escaped}`, token: GOOD });
  assert.equal(res.statusCode, 403);
});

test('a conversation id in the path is not taken for a user id', () => {
  const ids = claimedUserIds({ path: `/conversations/${OTHER}`, query: { userId: USER } });
  assert.deepEqual(ids, [USER]);
});

test('route labels hide every id', () => {
  const label = routeLabel({ method: 'GET', baseUrl: '/v1/troy', path: `/conversations/${OTHER}` });
  assert.equal(label, 'GET /v1/troy/conversations/:id');
});
