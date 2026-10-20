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
        : { data: { user: null }, error: { message: 'invalid JWT', status: 403 } }),
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
  const check = createUserTokenCheck({ supabase: fakeSupabase(), enforce: true, log: (line) => logs.push(line), ...opts });
  return { check, logs };
}

test('a call naming no user passes without a log', async () => {
  const { check, logs } = setup();
  const { passed, res } = await call(check, { query: { device_id: 'abc' } });
  assert.equal(passed, true);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(logs, []);
});

test('a user id with no token is refused with 401, and counted without the id', async () => {
  const { check, logs } = setup();
  const { passed, res } = await call(check, { query: { user_id: USER } });
  assert.equal(passed, false);
  assert.equal(res.statusCode, 401);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /no session GET \/v1\/push\/price-alerts/);
  assert.ok(!logs[0].includes(USER));
});

test('a token Supabase refuses is a 401 and is counted', async () => {
  const { check, logs } = setup();
  const { passed, res } = await call(check, { body: { userId: USER }, method: 'POST', token: BAD });
  assert.equal(passed, false);
  assert.equal(res.statusCode, 401);
  assert.equal(logs[0], '[UserToken] session not verified POST /v1/push/price-alerts');
});

test('an API key in the header is not taken for a session', async () => {
  const { check, logs } = setup();
  const { passed, res } = await call(check, { query: { userId: USER }, token: 'ts_live_0123456789abcdef' });
  assert.equal(passed, false);
  assert.equal(res.statusCode, 401);
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
  assert.equal(unsigned.res.statusCode, 401);
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

test('a percent-escaped snapshot id stays out of the log', async () => {
  const { check, logs } = setup({ pathUserId: true });
  const escaped = OTHER.replace(/2/g, '%32');
  await call(check, { baseUrl: '/v1/snapshots', path: `/${escaped}` });
  assert.equal(logs.length, 1);
  assert.equal(logs[0], '[UserToken] no session GET /v1/snapshots/:id');
});

test('a session check that throws is a 503 and one log line', async () => {
  const logs = [];
  const supabase = { auth: { getUser: async () => { throw new Error('fetch failed'); } } };
  const check = createUserTokenCheck({ supabase, enforce: true, log: (line) => logs.push(line) });
  const { passed, res } = await call(check, { query: { userId: USER }, token: GOOD });
  assert.equal(passed, false);
  assert.equal(res.statusCode, 503);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /session not verified GET \/v1\/push\/price-alerts, check failed: fetch failed/);
});

for (const [name, error] of [
  ['a network failure', { name: 'AuthRetryableFetchError', message: 'fetch failed', status: 0 }],
  ['a Supabase 5xx', { name: 'AuthRetryableFetchError', message: 'Bad Gateway', status: 502 }],
  ['a rate limit', { name: 'AuthApiError', message: 'Too many requests', status: 429 }],
  ['an error with no status', { name: 'AuthUnknownError', message: 'Unexpected token' }],
]) {
  test(`${name} returned by the session check is a 503, not a sign-out`, async () => {
    const logs = [];
    const supabase = { auth: { getUser: async () => ({ data: { user: null }, error }) } };
    const check = createUserTokenCheck({ supabase, enforce: true, log: (line) => logs.push(line) });
    const { passed, res } = await call(check, { body: { userId: USER }, method: 'POST', token: GOOD });
    assert.equal(passed, false);
    assert.equal(res.statusCode, 503);
    assert.match(logs[0], /check failed: /);
    assert.ok(logs[0].endsWith(error.message));
  });
}

test('a token Supabase answers with no user and no error is a 401', async () => {
  const supabase = { auth: { getUser: async () => ({ data: { user: null }, error: null }) } };
  const check = createUserTokenCheck({ supabase, enforce: true, log: () => {} });
  const { passed, res } = await call(check, { query: { userId: USER }, token: GOOD });
  assert.equal(passed, false);
  assert.equal(res.statusCode, 401);
});

test('a signed-out phone keeping alerts by device id still passes', async () => {
  const { check, logs } = setup();
  const { passed } = await call(check, { method: 'POST', baseUrl: '/v1/push', path: '/price-alerts', body: { device_id: 'abc', userId: '' } });
  assert.equal(passed, true);
  assert.deepEqual(logs, []);
});

test('route labels hide every id', () => {
  const label = routeLabel({ method: 'GET', baseUrl: '/v1/troy', path: `/conversations/${OTHER}` });
  assert.equal(label, 'GET /v1/troy/conversations/:id');
  const escaped = routeLabel({ method: 'GET', baseUrl: '/v1/troy', path: `/conversations/${OTHER.replace(/2/g, '%32')}` });
  assert.equal(escaped, 'GET /v1/troy/conversations/:id');
});

test('without enforce, a user id with no token or a refused token still passes and is counted', async () => {
  const { check, logs } = setup({ enforce: false });
  const none = await call(check, { query: { user_id: USER } });
  assert.equal(none.passed, true);
  const bad = await call(check, { body: { userId: USER }, method: 'POST', token: BAD });
  assert.equal(bad.passed, true);
  const other = await call(check, { query: { userId: OTHER }, token: GOOD });
  assert.equal(other.res.statusCode, 403);
  assert.equal(logs.length, 3);
  assert.match(logs[0], /no session/);
  assert.match(logs[1], /session not verified/);
  assert.match(logs[2], /refused another account/);
});

test('index.js refuses no-session calls on push, troy and snapshots, and not yet on articles', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');
  assert.ok(src.includes('const userTokenCheck = createUserTokenCheck({ supabase: supabaseClient, enforce: true });'));
  assert.ok(src.includes("app.use('/v1/push', publicLimiter, userTokenCheck, pushRouter);"));
  assert.ok(src.includes("app.use('/v1/troy', publicLimiter, troyTokenCheck, troyChatRouter);"));
  assert.ok(src.includes('createUserTokenCheck({ supabase: supabaseClient, pathUserId: true, enforce: true })'));
  const social = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'social.js'), 'utf8');
  assert.ok(social.includes("router.use('/articles', createUserTokenCheck({ supabase }));"));
});

test('/v1/troy refuses conversations with no session but only counts /speak', async () => {
  const logs = [];
  const check = createUserTokenCheck({
    supabase: fakeSupabase(),
    log: (line) => logs.push(line),
    enforce: (req) => !/^\/speak(\/|$)/i.test(req.path || ''),
  });
  const convo = await call(check, { baseUrl: '/v1/troy', path: '/conversations', query: { userId: USER } });
  assert.equal(convo.res.statusCode, 401);
  const speakGet = await call(check, { baseUrl: '/v1/troy', path: '/speak', query: { userId: USER } });
  assert.equal(speakGet.passed, true);
  const speakPost = await call(check, { method: 'POST', baseUrl: '/v1/troy', path: '/speak', body: { userId: USER, text: 'hi' }, token: BAD });
  assert.equal(speakPost.passed, true);
  const otherSpeak = await call(check, { baseUrl: '/v1/troy', path: '/speak', query: { userId: OTHER }, token: GOOD });
  assert.equal(otherSpeak.res.statusCode, 403);
  const speaker = await call(check, { baseUrl: '/v1/troy', path: '/speakers', query: { userId: USER } });
  assert.equal(speaker.res.statusCode, 401);
  assert.equal(logs.length, 5);
});

test('a 401 with no code is our own key refused, so a 503, and a coded 401 is the caller', async () => {
  for (const [error, want] of [
    [{ name: 'AuthApiError', message: 'Invalid API key', status: 401 }, 503],
    [{ name: 'AuthApiError', message: 'invalid JWT', status: 401, code: 'bad_jwt' }, 401],
  ]) {
    const logs = [];
    const supabase = { auth: { getUser: async () => ({ data: { user: null }, error }) } };
    const check = createUserTokenCheck({ supabase, enforce: true, log: (line) => logs.push(line) });
    const { res } = await call(check, { query: { userId: USER }, token: GOOD });
    assert.equal(res.statusCode, want);
  }
});

test('a 5xx whose message is an empty object still logs its name and status', async () => {
  const logs = [];
  const error = { name: 'AuthRetryableFetchError', message: '{}', status: 502 };
  const supabase = { auth: { getUser: async () => ({ data: { user: null }, error }) } };
  const check = createUserTokenCheck({ supabase, enforce: true, log: (line) => logs.push(line) });
  await call(check, { query: { userId: USER }, token: GOOD });
  assert.match(logs[0], /check failed: AuthRetryableFetchError 502$/);
});
