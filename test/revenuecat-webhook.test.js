// The RevenueCat webhook, the only way App Store plans reach profiles once
// migration 006 guards the plan columns.
//   node --test
// Supabase is an in-memory stand-in; nothing leaves the process.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

process.env.SUPABASE_URL ||= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-dummy-service-role-key';

const USER = '7b1c6c1e-1111-4a2b-9c3d-000000000001';
const SECRET = 'rc-test-secret';
// A subscription grant whose expiry has passed gives nothing, so a test that
// expects one to apply sets its expiry from now.
const DAY = 24 * 60 * 60 * 1000;

/**
 * Profiles keyed by id, and app_state values keyed by key, with switches that
 * make reads or writes fail. failRead and failWrite are for profiles, and
 * failStateRead and failStateWrite for app_state.
 */
function fakeSupabase(rows, opts = {}) {
  const writes = [];
  const state = opts.state || {};
  const stateWrites = [];
  // A JSON field of an app_state value, as PostgREST's value->>field filter reads it.
  const valueField = (value, column) => {
    const field = /^value->>(\w+)$/.exec(column)?.[1];
    return field && value && value[field] != null ? String(value[field]) : null;
  };
  function appState() {
    let key;
    const read = {
      select() { return read; },
      eq(col, v) { assert.strictEqual(col, 'key'); key = v; return read; },
      async maybeSingle() {
        if (opts.failStateRead) return { data: null, error: { message: 'connection reset' } };
        // The read is taken now. With opts.holdFirstRecordRead, the first
        // read of a purchase record answers only once that promise settles,
        // the way a slow database answer lands after other writes.
        const data = Object.hasOwn(state, key) ? { value: JSON.parse(JSON.stringify(state[key])) } : null;
        if (key.startsWith('revenuecat_grant:')) {
          db.recordReads += 1;
          if (opts.holdFirstRecordRead && db.recordReads === 1) await opts.holdFirstRecordRead;
        }
        return { data, error: null };
      },
    };
    return {
      select: read.select,
      async upsert(row, options) {
        assert.strictEqual(options?.onConflict, 'key');
        if (opts.failStateWrite) return { error: { message: 'connection reset' } };
        stateWrites.push(row);
        state[row.key] = row.value;
        return { error: null };
      },
      // A key that's already there fails on the primary key, as in Postgres.
      async insert(row) {
        if (opts.failTurn) return { error: { message: 'connection reset' } };
        if (Object.hasOwn(state, row.key)) return { error: { code: '23505', message: 'duplicate key value violates unique constraint' } };
        state[row.key] = JSON.parse(JSON.stringify(row.value));
        return { error: null };
      },
      // Deletes the rows that match every filter, on the key or a JSON field.
      delete() {
        const filters = [];
        const query = {
          eq(column, wanted) {
            filters.push((k, value) => (column === 'key' ? k === wanted : valueField(value, column) === String(wanted)));
            return query;
          },
          lt(column, bound) {
            filters.push((_k, value) => valueField(value, column) != null && valueField(value, column) < bound);
            return query;
          },
          then(resolve, reject) {
            if (opts.failTurn) return Promise.resolve({ error: { message: 'connection reset' } }).then(resolve, reject);
            for (const k of Object.keys(state)) if (filters.every((match) => match(k, state[k]))) delete state[k];
            return Promise.resolve({ error: null }).then(resolve, reject);
          },
        };
        return query;
      },
    };
  }
  const db = {
    writes,
    state,
    stateWrites,
    recordReads: 0,
    // Session tokens and the account each signs in, from opts.users.
    auth: {
      async getUser(token) {
        const id = opts.users?.[token];
        return id ? { data: { user: { id } }, error: null } : { data: { user: null }, error: { message: 'invalid JWT' } };
      },
    },
    from(table) {
      if (table === 'app_state') return appState();
      assert.strictEqual(table, 'profiles');
      let id;
      const read = {
        select() { return read; },
        eq(_col, v) { id = v; return read; },
        async maybeSingle() {
          if (opts.failRead) return { data: null, error: { message: 'connection reset' } };
          return { data: rows[id] ? { ...rows[id] } : null, error: null };
        },
      };
      return {
        select: read.select,
        async upsert(row) {
          if (opts.failWrite) return { error: { message: 'connection reset' } };
          if (!rows[row.id]) rows[row.id] = { subscription_tier: null, subscription_status: null, subscription_expires_at: null, stripe_customer_id: null };
          return { error: null };
        },
        update(fields) {
          return {
            async eq(_col, v) {
              if (opts.failWrite) return { error: { message: 'connection reset' } };
              writes.push({ id: v, fields });
              if (rows[v]) Object.assign(rows[v], fields);
              return { error: null };
            },
          };
        },
      };
    },
  };
  return db;
}

function loadHandler(db) {
  const supabasePath = require.resolve(path.join(__dirname, '..', 'src', 'lib', 'supabase'));
  const modPath = require.resolve(path.join(__dirname, '..', 'src', 'routes', 'revenuecat-webhook'));
  delete require.cache[modPath];
  require.cache[supabasePath] = { id: supabasePath, filename: supabasePath, loaded: true, exports: db };
  try {
    return require(modPath);
  } finally {
    delete require.cache[supabasePath];
    delete require.cache[modPath];
  }
}

async function send(handler, event, { auth = `Bearer ${SECRET}` } = {}) {
  const res = {
    code: 200,
    body: null,
    status(c) { res.code = c; return res; },
    json(b) { res.body = b; return res; },
  };
  await handler({ headers: auth == null ? {} : { authorization: auth }, body: { event } }, res);
  return res;
}

const OTHER = '8c2d7d2f-2222-4b3c-8d4e-000000000002';
// A stand-in for the RevenueCat REST key. It must never show up in a log or
// an answer.
const REST_KEY = 'rc-rest-test-key';
// A web plan check, as stripe.js hands in, that finds no plan bought on the web.
const noWebPlan = async () => ({ tier: 'free' });

// Sets environment variables for the length of fn, and puts them back after.
// A value of null or undefined unsets the variable.
async function withEnv(vars, fn) {
  const before = {};
  for (const [name, value] of Object.entries(vars)) {
    before[name] = process.env[name];
    if (value == null) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [name, value] of Object.entries(before)) {
      if (value == null) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

// RevenueCat's REST API as a stand-in: subscribers by app user id, an answer
// status, and the requests it was sent. An id it doesn't know has bought
// nothing.
function revenueCatApi(subscribers = {}, { status = 200 } = {}) {
  const calls = [];
  async function fetch(url, init = {}) {
    calls.push({ url: String(url), authorization: init.headers?.Authorization });
    const id = decodeURIComponent(String(url).split('/subscribers/')[1] || '');
    const subscriber = subscribers[id] || { subscriptions: {}, non_subscriptions: {} };
    return { ok: status >= 200 && status < 300, status, json: async () => ({ subscriber }) };
  }
  return { calls, fetch };
}

// Runs fn with the REST key set and the stand-in answering in place of fetch.
async function withRevenueCatApi(api, fn) {
  const before = global.fetch;
  global.fetch = api.fetch;
  try {
    return await withEnv({ REVENUECAT_SECRET_KEY: REST_KEY }, fn);
  } finally {
    global.fetch = before;
  }
}

// Everything fn writes to the console, as lines, with the console kept quiet.
async function captureLogs(fn) {
  const lines = [];
  const before = { log: console.log, warn: console.warn, error: console.error };
  for (const name of Object.keys(before)) console[name] = (...args) => lines.push(args.map(String).join(' '));
  try {
    await fn();
  } finally {
    Object.assign(console, before);
  }
  return lines;
}

// Calls the sync route as the app would, with a session token or none.
async function syncAs(handler, token) {
  const res = {
    code: 200,
    body: null,
    status(c) { res.code = c; return res; },
    json(b) { res.body = b; return res; },
  };
  await handler({ headers: token ? { authorization: `Bearer ${token}` } : {} }, res);
  return res;
}

const inDays = (days) => new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();

function withSecret(value, fn) {
  return async () => {
    const before = process.env.REVENUECAT_WEBHOOK_SECRET;
    if (value == null) delete process.env.REVENUECAT_WEBHOOK_SECRET;
    else process.env.REVENUECAT_WEBHOOK_SECRET = value;
    try {
      await fn();
    } finally {
      if (before == null) delete process.env.REVENUECAT_WEBHOOK_SECRET;
      else process.env.REVENUECAT_WEBHOOK_SECRET = before;
    }
  };
}

test('an App Store lifetime purchase makes the profile lifetime', withSecret(SECRET, async () => {
  const rows = { [USER]: { subscription_tier: 'free', subscription_expires_at: null } };
  const db = fakeSupabase(rows);
  const { revenueCatWebhookHandler } = loadHandler(db);
  const res = await send(revenueCatWebhookHandler, { type: 'NON_RENEWING_PURCHASE', app_user_id: USER, product_id: 'stacktracker_lifetime', environment: 'PRODUCTION' });
  assert.strictEqual(res.code, 200);
  assert.deepStrictEqual(rows[USER], { subscription_tier: 'lifetime', subscription_expires_at: null, subscription_status: 'active', trial_end: null });
}));

test('a subscription purchase or renewal makes the profile gold until it expires', withSecret(SECRET, async () => {
  const rows = { [USER]: { subscription_tier: 'free', subscription_expires_at: null } };
  const { revenueCatWebhookHandler } = loadHandler(fakeSupabase(rows));
  const at = Date.now() + 30 * DAY;
  await send(revenueCatWebhookHandler, { type: 'INITIAL_PURCHASE', app_user_id: USER, product_id: 'stacktracker_gold_yearly', expiration_at_ms: at });
  assert.deepStrictEqual(rows[USER], { subscription_tier: 'gold', subscription_expires_at: new Date(at).toISOString(), subscription_status: 'active', trial_end: null });
  const later = at + 365 * 864e5;
  await send(revenueCatWebhookHandler, { type: 'RENEWAL', app_user_id: USER, product_id: 'stacktracker_gold_yearly', expiration_at_ms: later });
  assert.strictEqual(rows[USER].subscription_expires_at, new Date(later).toISOString());
}));

// RevenueCat's catalog, read 10/9, has the App Store selling monthly,
// yearly_gold and lifetime_gold, and its Test Store selling monthly and
// lifetime. The tests above use older ids. The App Store's monthly id has no
// "gold" in it, so the match on "monthly" is what keeps those subscribers Gold.
test('the product ids RevenueCat sends today map to the right plan', withSecret(SECRET, async () => {
  const rows = { [USER]: { subscription_tier: 'free', subscription_expires_at: null } };
  const { mapProductToTier, revenueCatWebhookHandler } = loadHandler(fakeSupabase(rows));
  assert.strictEqual(mapProductToTier('monthly'), 'gold');
  assert.strictEqual(mapProductToTier('yearly_gold'), 'gold');
  assert.strictEqual(mapProductToTier('lifetime_gold'), 'lifetime');
  assert.strictEqual(mapProductToTier('lifetime'), 'lifetime');

  const at = Date.now() + 30 * DAY;
  const renewal = await send(revenueCatWebhookHandler, { type: 'RENEWAL', app_user_id: USER, product_id: 'monthly', environment: 'PRODUCTION', expiration_at_ms: at });
  assert.strictEqual(renewal.code, 200);
  assert.deepStrictEqual(rows[USER], { subscription_tier: 'gold', subscription_expires_at: new Date(at).toISOString(), subscription_status: 'active', trial_end: null });

  const lifetime = await send(revenueCatWebhookHandler, { type: 'NON_RENEWING_PURCHASE', app_user_id: USER, product_id: 'lifetime_gold', environment: 'PRODUCTION' });
  assert.strictEqual(lifetime.code, 200);
  assert.deepStrictEqual(rows[USER], { subscription_tier: 'lifetime', subscription_expires_at: null, subscription_status: 'active', trial_end: null });
}));

test('a sandbox purchase counts, since App Review buys in the sandbox', withSecret(SECRET, async () => {
  const rows = { [USER]: { subscription_tier: 'free', subscription_expires_at: null } };
  const { revenueCatWebhookHandler } = loadHandler(fakeSupabase(rows));
  await send(revenueCatWebhookHandler, { type: 'INITIAL_PURCHASE', app_user_id: USER, product_id: 'stacktracker_gold_monthly', environment: 'SANDBOX', expiration_at_ms: Date.now() + 30 * DAY });
  assert.strictEqual(rows[USER].subscription_tier, 'gold');
}));

test('a plan change uses the product it moved to', withSecret(SECRET, async () => {
  const rows = { [USER]: { subscription_tier: 'gold', subscription_expires_at: null } };
  const { revenueCatWebhookHandler } = loadHandler(fakeSupabase(rows));
  await send(revenueCatWebhookHandler, { type: 'PRODUCT_CHANGE', app_user_id: USER, product_id: 'stacktracker_gold_monthly', new_product_id: 'stacktracker_lifetime' });
  assert.strictEqual(rows[USER].subscription_tier, 'lifetime');
}));

test('lifetime is never replaced by a subscription or ended by one expiring', withSecret(SECRET, async () => {
  const rows = { [USER]: { subscription_tier: 'lifetime', subscription_expires_at: null } };
  const db = fakeSupabase(rows);
  const { revenueCatWebhookHandler } = loadHandler(db);
  await send(revenueCatWebhookHandler, { type: 'RENEWAL', app_user_id: USER, product_id: 'stacktracker_gold_monthly', expiration_at_ms: Date.now() + 30 * DAY });
  await send(revenueCatWebhookHandler, { type: 'CANCELLATION', app_user_id: USER, product_id: 'stacktracker_gold_monthly', cancel_reason: 'UNSUBSCRIBE', expiration_at_ms: Date.UTC(2026, 10, 9) });
  await send(revenueCatWebhookHandler, { type: 'EXPIRATION', app_user_id: USER, product_id: 'stacktracker_gold_monthly' });
  assert.deepStrictEqual(db.writes, []);
  assert.strictEqual(rows[USER].subscription_tier, 'lifetime');
}));

test('turning off auto-renew keeps the plan to the end of the period, and expiry ends it', withSecret(SECRET, async () => {
  const rows = { [USER]: { subscription_tier: 'gold', subscription_expires_at: null } };
  const { revenueCatWebhookHandler } = loadHandler(fakeSupabase(rows));
  const at = Date.UTC(2026, 10, 9);
  await send(revenueCatWebhookHandler, { type: 'CANCELLATION', app_user_id: USER, product_id: 'stacktracker_gold_monthly', cancel_reason: 'UNSUBSCRIBE', expiration_at_ms: at });
  assert.deepStrictEqual(rows[USER], { subscription_tier: 'gold', subscription_expires_at: new Date(at).toISOString() });
  await send(revenueCatWebhookHandler, { type: 'EXPIRATION', app_user_id: USER, product_id: 'stacktracker_gold_monthly' });
  assert.deepStrictEqual(rows[USER], { subscription_tier: 'free', subscription_expires_at: null, subscription_status: null, trial_end: null });
}));

test('a refund ends what was refunded right away', withSecret(SECRET, async () => {
  const rows = { [USER]: { subscription_tier: 'lifetime', subscription_expires_at: null } };
  const { revenueCatWebhookHandler } = loadHandler(fakeSupabase(rows));
  await send(revenueCatWebhookHandler, { type: 'CANCELLATION', app_user_id: USER, product_id: 'stacktracker_gold_monthly', cancel_reason: 'CUSTOMER_SUPPORT' });
  assert.strictEqual(rows[USER].subscription_tier, 'lifetime', 'a refunded subscription leaves lifetime alone');
  await send(revenueCatWebhookHandler, { type: 'CANCELLATION', app_user_id: USER, product_id: 'stacktracker_lifetime', cancel_reason: 'CUSTOMER_SUPPORT' });
  assert.strictEqual(rows[USER].subscription_tier, 'free');
}));

test('a failed database read or write answers 500 so RevenueCat retries', withSecret(SECRET, async () => {
  const rows = { [USER]: { subscription_tier: 'free', subscription_expires_at: null } };
  for (const opts of [{ failRead: true }, { failWrite: true }]) {
    const { revenueCatWebhookHandler } = loadHandler(fakeSupabase(rows, opts));
    const res = await send(revenueCatWebhookHandler, { type: 'NON_RENEWING_PURCHASE', app_user_id: USER, product_id: 'stacktracker_lifetime' });
    assert.strictEqual(res.code, 500, JSON.stringify(opts));
  }
  assert.strictEqual(rows[USER].subscription_tier, 'free');
}));

test('a call without the secret changes nothing, and neither does any call when the secret is unset', async () => {
  const rows = { [USER]: { subscription_tier: 'free', subscription_expires_at: null } };
  const db = fakeSupabase(rows);
  const event = { type: 'NON_RENEWING_PURCHASE', app_user_id: USER, product_id: 'stacktracker_lifetime' };
  await withSecret(SECRET, async () => {
    const { revenueCatWebhookHandler } = loadHandler(db);
    assert.strictEqual((await send(revenueCatWebhookHandler, event, { auth: null })).code, 401);
    assert.strictEqual((await send(revenueCatWebhookHandler, event, { auth: 'Bearer nope' })).code, 401);
    assert.strictEqual((await send(revenueCatWebhookHandler, event, { auth: `Bearer ${SECRET}x` })).code, 401);
  })();
  await withSecret(null, async () => {
    const { revenueCatWebhookHandler } = loadHandler(db);
    assert.strictEqual((await send(revenueCatWebhookHandler, event)).code, 503);
  })();
  assert.deepStrictEqual(db.writes, []);
});

test('the secret matches with or without Bearer in front', withSecret(SECRET, async () => {
  const { authorized } = loadHandler(fakeSupabase({}));
  assert.strictEqual(authorized(SECRET, SECRET), true);
  assert.strictEqual(authorized(`Bearer ${SECRET}`, SECRET), true);
  assert.strictEqual(authorized(`bearer ${SECRET}`, SECRET), true);
  assert.strictEqual(authorized('', SECRET), false);
  assert.strictEqual(authorized(SECRET, ''), false);
}));

test('anonymous users, odd ids, unknown products, transfers and billing issues change nothing', withSecret(SECRET, async () => {
  const rows = { [USER]: { subscription_tier: 'gold', subscription_expires_at: null } };
  const db = fakeSupabase(rows);
  const { revenueCatWebhookHandler } = loadHandler(db);
  const events = [
    { type: 'INITIAL_PURCHASE', app_user_id: '$RCAnonymousID:abc', product_id: 'stacktracker_gold_monthly' },
    { type: 'INITIAL_PURCHASE', app_user_id: 'not-a-uuid', product_id: 'stacktracker_gold_monthly' },
    { type: 'INITIAL_PURCHASE', app_user_id: USER, product_id: 'tip_jar_small' },
    { type: 'EXPIRATION', app_user_id: USER, product_id: 'tip_jar_small' },
    { type: 'TRANSFER', transferred_from: [USER], transferred_to: ['8c2d7d2f-2222-4b3c-8d4e-000000000002'] },
    { type: 'BILLING_ISSUE', app_user_id: USER, product_id: 'stacktracker_gold_monthly' },
    { type: 'TEST', app_user_id: USER },
  ];
  for (const e of events) assert.strictEqual((await send(revenueCatWebhookHandler, e)).code, 200, e.type);
  assert.deepStrictEqual(db.writes, []);
}));

test('a purchase for an account with no profile row makes the row and applies', withSecret(SECRET, async () => {
  const rows = {};
  const db = fakeSupabase(rows);
  const { revenueCatWebhookHandler } = loadHandler(db);
  const res = await send(revenueCatWebhookHandler, { type: 'NON_RENEWING_PURCHASE', app_user_id: USER, product_id: 'stacktracker_lifetime' });
  assert.strictEqual(res.code, 200);
  assert.strictEqual(rows[USER].subscription_tier, 'lifetime');
}));

test('an expiry for an account with no profile row ends nothing', withSecret(SECRET, async () => {
  const db = fakeSupabase({});
  const { revenueCatWebhookHandler } = loadHandler(db);
  const res = await send(revenueCatWebhookHandler, { type: 'EXPIRATION', app_user_id: USER, product_id: 'stacktracker_gold_monthly' });
  assert.strictEqual(res.code, 200);
  assert.strictEqual(res.body.skipped, 'no_profile');
  assert.deepStrictEqual(db.writes, []);
}));

test('a retried expiry for a period already replaced ends nothing', withSecret(SECRET, async () => {
  const renewedTo = Date.UTC(2026, 10, 9);
  const rows = { [USER]: { subscription_tier: 'gold', subscription_status: null, subscription_expires_at: new Date(renewedTo).toISOString() } };
  const db = fakeSupabase(rows);
  const { revenueCatWebhookHandler } = loadHandler(db);
  const res = await send(revenueCatWebhookHandler, { type: 'EXPIRATION', app_user_id: USER, product_id: 'stacktracker_gold_monthly', expiration_at_ms: Date.UTC(2026, 9, 9) });
  assert.strictEqual(res.body.skipped, 'superseded');
  assert.strictEqual(rows[USER].subscription_tier, 'gold');
  // The expiry for the current period still ends it.
  await send(revenueCatWebhookHandler, { type: 'EXPIRATION', app_user_id: USER, product_id: 'stacktracker_gold_monthly', expiration_at_ms: renewedTo });
  assert.strictEqual(rows[USER].subscription_tier, 'free');
}));

test('when an App Store plan ends, a web plan Stripe still holds is kept', withSecret(SECRET, async () => {
  const rows = { [USER]: { subscription_tier: 'gold', subscription_expires_at: '2026-10-09T00:00:00.000Z', stripe_customer_id: 'cus_web' } };
  const mod = loadHandler(fakeSupabase(rows));
  const asked = [];
  mod.setWebPlanCheck(async (id, customer) => {
    asked.push([id, customer]);
    return { tier: 'gold', status: 'trialing', trialEnd: '2026-10-16T00:00:00.000Z' };
  });
  const res = await send(mod.revenueCatWebhookHandler, { type: 'EXPIRATION', app_user_id: USER, product_id: 'stacktracker_gold_monthly' });
  assert.strictEqual(res.code, 200);
  assert.deepStrictEqual(asked, [[USER, 'cus_web']]);
  assert.strictEqual(rows[USER].subscription_tier, 'gold');
  assert.strictEqual(rows[USER].subscription_status, 'trialing');
  assert.strictEqual(rows[USER].trial_end, '2026-10-16T00:00:00.000Z');
  assert.strictEqual(rows[USER].subscription_expires_at, null);
}));

test('a refunded App Store plan leaves a web lifetime in place', withSecret(SECRET, async () => {
  const rows = { [USER]: { subscription_tier: 'gold', subscription_expires_at: null, stripe_customer_id: 'cus_web' } };
  const mod = loadHandler(fakeSupabase(rows));
  mod.setWebPlanCheck(async () => ({ tier: 'lifetime', status: 'active', trialEnd: null }));
  const res = await send(mod.revenueCatWebhookHandler, { type: 'CANCELLATION', app_user_id: USER, product_id: 'stacktracker_gold_yearly', cancel_reason: 'CUSTOMER_SUPPORT' });
  assert.strictEqual(res.body.refunded, true);
  assert.strictEqual(rows[USER].subscription_tier, 'lifetime');
}));

test("when Stripe can't be read the event is answered 500 and nothing is written", withSecret(SECRET, async () => {
  const rows = { [USER]: { subscription_tier: 'gold', subscription_expires_at: null, stripe_customer_id: 'cus_web' } };
  const db = fakeSupabase(rows);
  const mod = loadHandler(db);
  mod.setWebPlanCheck(async () => { throw new Error('Stripe is having a moment'); });
  const res = await send(mod.revenueCatWebhookHandler, { type: 'EXPIRATION', app_user_id: USER, product_id: 'stacktracker_gold_monthly' });
  assert.strictEqual(res.code, 500);
  assert.deepStrictEqual(db.writes, []);
  assert.strictEqual(rows[USER].subscription_tier, 'gold');
}));

// A customer an older checkout made can hold a paid web plan the profile
// never recorded, so Stripe is asked with no customer and stripe.js searches.
test('a profile with no customer id still has Stripe asked, with a null customer', withSecret(SECRET, async () => {
  const rows = { [USER]: { subscription_tier: 'gold', subscription_expires_at: null, stripe_customer_id: null } };
  const mod = loadHandler(fakeSupabase(rows));
  const asked = [];
  mod.setWebPlanCheck(async (id, customer) => {
    asked.push([id, customer]);
    return { tier: 'gold', status: 'active', trialEnd: null };
  });
  const res = await send(mod.revenueCatWebhookHandler, { type: 'EXPIRATION', app_user_id: USER, product_id: 'stacktracker_gold_monthly' });
  assert.strictEqual(res.code, 200);
  assert.deepStrictEqual(asked, [[USER, null]]);
  assert.strictEqual(rows[USER].subscription_tier, 'gold', 'the web plan the search found is kept');
  assert.strictEqual(rows[USER].subscription_status, 'active');

  // A refund asks the same way, and with nothing in Stripe it writes free.
  mod.setWebPlanCheck(async (id, customer) => {
    asked.push([id, customer]);
    return { tier: 'free', status: null, trialEnd: null };
  });
  rows[USER] = { subscription_tier: 'gold', subscription_expires_at: null, stripe_customer_id: null };
  const refund = await send(mod.revenueCatWebhookHandler, { type: 'CANCELLATION', app_user_id: USER, product_id: 'stacktracker_gold_monthly', cancel_reason: 'CUSTOMER_SUPPORT' });
  assert.strictEqual(refund.body.refunded, true);
  assert.deepStrictEqual(asked, [[USER, null], [USER, null]]);
  assert.deepStrictEqual(rows[USER], { subscription_tier: 'free', subscription_expires_at: null, stripe_customer_id: null, subscription_status: null, trial_end: null });
}));

test("a temporary grant during a store outage gives Gold for a day, then the real purchase or the expiry decides", withSecret(SECRET, async () => {
  // The grant came an hour ago, inside its day.
  const at = Date.now() - 3600 * 1000;
  const rows = { [USER]: { subscription_tier: 'free', subscription_status: null, subscription_expires_at: null, stripe_customer_id: null } };
  const db = fakeSupabase(rows);
  const { revenueCatWebhookHandler } = loadHandler(db);
  // The grant names no product.
  let res = await send(revenueCatWebhookHandler, { type: 'TEMPORARY_ENTITLEMENT_GRANT', app_user_id: USER, store: 'APP_STORE', event_timestamp_ms: at });
  assert.strictEqual(res.code, 200);
  assert.strictEqual(rows[USER].subscription_tier, 'gold');
  assert.strictEqual(rows[USER].subscription_status, 'temporary_grant');
  assert.strictEqual(rows[USER].subscription_expires_at, new Date(at + 24 * 3600 * 1000).toISOString());

  // The purchase validates as lifetime.
  await send(revenueCatWebhookHandler, { type: 'NON_RENEWING_PURCHASE', app_user_id: USER, product_id: 'stacktracker_lifetime' });
  assert.strictEqual(rows[USER].subscription_tier, 'lifetime');
  assert.strictEqual(rows[USER].subscription_status, 'active');

  // Another account's grant fails validation, and the expiry ends it even
  // though it names the lifetime product. That account has no purchase on
  // record, so the lifetime purchase above is taken off it.
  rows[USER] = { subscription_tier: 'free', subscription_status: null, subscription_expires_at: null, stripe_customer_id: null };
  delete db.state[`revenuecat_grant:${USER}`];
  await send(revenueCatWebhookHandler, { type: 'TEMPORARY_ENTITLEMENT_GRANT', app_user_id: USER, store: 'APP_STORE', event_timestamp_ms: at });
  res = await send(revenueCatWebhookHandler, { type: 'EXPIRATION', app_user_id: USER, product_id: 'stacktracker_lifetime' });
  assert.strictEqual(res.body.temporary, true);
  assert.strictEqual(rows[USER].subscription_tier, 'free');
  assert.strictEqual(rows[USER].subscription_status, null);
}));

test('a temporary grant leaves an account that already has a plan alone', withSecret(SECRET, async () => {
  const rows = { [USER]: { subscription_tier: 'gold', subscription_status: 'active', subscription_expires_at: '2026-11-09T00:00:00.000Z' } };
  const db = fakeSupabase(rows);
  const { revenueCatWebhookHandler } = loadHandler(db);
  const res = await send(revenueCatWebhookHandler, { type: 'TEMPORARY_ENTITLEMENT_GRANT', app_user_id: USER, store: 'APP_STORE' });
  assert.strictEqual(res.body.kept, 'gold');
  assert.deepStrictEqual(db.writes, []);
}));

test('a reversed refund gives back what was refunded, unless its period has run out', withSecret(SECRET, async () => {
  const rows = { [USER]: { subscription_tier: 'free', subscription_status: null, subscription_expires_at: null } };
  const { revenueCatWebhookHandler } = loadHandler(fakeSupabase(rows));
  const later = Date.now() + 20 * 24 * 3600 * 1000;
  await send(revenueCatWebhookHandler, { type: 'REFUND_REVERSED', app_user_id: USER, product_id: 'stacktracker_gold_yearly', expiration_at_ms: later });
  assert.strictEqual(rows[USER].subscription_tier, 'gold');
  assert.strictEqual(rows[USER].subscription_expires_at, new Date(later).toISOString());

  rows[USER] = { subscription_tier: 'free', subscription_status: null, subscription_expires_at: null };
  await send(revenueCatWebhookHandler, { type: 'REFUND_REVERSED', app_user_id: USER, product_id: 'stacktracker_lifetime', expiration_at_ms: null });
  assert.strictEqual(rows[USER].subscription_tier, 'lifetime');

  rows[USER] = { subscription_tier: 'free', subscription_status: null, subscription_expires_at: null };
  const res = await send(revenueCatWebhookHandler, { type: 'REFUND_REVERSED', app_user_id: USER, product_id: 'stacktracker_gold_monthly', expiration_at_ms: Date.now() - 3600 * 1000 });
  assert.strictEqual(res.body.skipped, 'already_expired');
  assert.strictEqual(rows[USER].subscription_tier, 'free');
}));

const GRANT_KEY = `revenuecat_grant:${USER}`;

function freeRow() {
  return { subscription_tier: 'free', subscription_status: null, subscription_expires_at: null, stripe_customer_id: null };
}

test('a refund that arrives after a renewal ends nothing', withSecret(SECRET, async () => {
  const rows = { [USER]: freeRow() };
  const db = fakeSupabase(rows);
  const { revenueCatWebhookHandler } = loadHandler(db);
  // The account renewed yesterday. The first month's grant was applied when
  // it came, and sent now it would give nothing, since that month is over.
  const renewed = Date.now() - DAY;
  const bought = renewed - 30 * DAY;
  await send(revenueCatWebhookHandler, { type: 'RENEWAL', app_user_id: USER, product_id: 'monthly', purchased_at_ms: renewed, expiration_at_ms: renewed + 30 * DAY });
  const before = { ...rows[USER] };
  const profileWrites = db.writes.length;
  const recordWrites = db.stateWrites.length;

  // The first month's refund comes after the renewal was applied, late or on
  // a retry. Its expiration_at_ms is the time of the refund.
  const res = await send(revenueCatWebhookHandler, { type: 'CANCELLATION', app_user_id: USER, product_id: 'monthly', cancel_reason: 'CUSTOMER_SUPPORT', purchased_at_ms: bought, expiration_at_ms: bought + 5 * DAY });
  assert.strictEqual(res.code, 200);
  assert.strictEqual(res.body.skipped, 'superseded');
  assert.strictEqual(db.writes.length, profileWrites, 'no profile write');
  assert.strictEqual(db.stateWrites.length, recordWrites, 'no record write');
  assert.deepStrictEqual(rows[USER], before);
  assert.strictEqual(rows[USER].subscription_tier, 'gold');
  assert.strictEqual(rows[USER].subscription_expires_at, new Date(renewed + 30 * DAY).toISOString());
}));

test('a refund of the current period still ends it, though its expiry reads as the refund time', withSecret(SECRET, async () => {
  // RevenueCat's sample refund was bought at 1601258901000, and its
  // expiration_at_ms, 1601336705000, is the moment of the refund later that
  // day, not the end of the month. The stored period end is later, so a date
  // check would call this refund replaced. The sample's gap is used from a
  // renewal yesterday, since a grant for a month that's over gives nothing.
  const bought = Date.now() - DAY;
  const refundedAt = bought + (1601336705000 - 1601258901000);
  const rows = { [USER]: freeRow() };
  const db = fakeSupabase(rows);
  const { revenueCatWebhookHandler } = loadHandler(db);
  await send(revenueCatWebhookHandler, { type: 'RENEWAL', app_user_id: USER, product_id: 'monthly', purchased_at_ms: bought, expiration_at_ms: bought + 30 * DAY });
  assert.deepStrictEqual(db.state[GRANT_KEY], { purchasedAt: bought, subscriptionUntil: bought + 30 * DAY });

  const res = await send(revenueCatWebhookHandler, { type: 'CANCELLATION', app_user_id: USER, product_id: 'monthly', cancel_reason: 'CUSTOMER_SUPPORT', purchased_at_ms: bought, expiration_at_ms: refundedAt });
  assert.strictEqual(res.code, 200);
  assert.strictEqual(res.body.refunded, true);
  assert.strictEqual(rows[USER].subscription_tier, 'free');
  assert.strictEqual(rows[USER].subscription_expires_at, null);
}));

test('grants record their purchase time, and a late older grant leaves a newer record alone', withSecret(SECRET, async () => {
  const rows = { [USER]: freeRow() };
  const db = fakeSupabase(rows);
  const { revenueCatWebhookHandler } = loadHandler(db);
  // The first purchase was yesterday, so neither period here has run out.
  const first = Date.now() - DAY;
  const second = first + 30 * DAY;
  await send(revenueCatWebhookHandler, { type: 'INITIAL_PURCHASE', app_user_id: USER, product_id: 'monthly', purchased_at_ms: first, expiration_at_ms: second });
  assert.deepStrictEqual(db.state[GRANT_KEY], { purchasedAt: first, subscriptionUntil: second });
  await send(revenueCatWebhookHandler, { type: 'RENEWAL', app_user_id: USER, product_id: 'monthly', purchased_at_ms: second, expiration_at_ms: second + 30 * DAY });
  assert.deepStrictEqual(db.state[GRANT_KEY], { purchasedAt: second, subscriptionUntil: second + 30 * DAY });

  // The first purchase's event comes again on a retry.
  const res = await send(revenueCatWebhookHandler, { type: 'INITIAL_PURCHASE', app_user_id: USER, product_id: 'monthly', purchased_at_ms: first, expiration_at_ms: second });
  assert.strictEqual(res.code, 200);
  assert.deepStrictEqual(db.state[GRANT_KEY], { purchasedAt: second, subscriptionUntil: second + 30 * DAY });

  // A grant without a purchase time changes no purchase time on record, and
  // this one's expiry is the one already there.
  await send(revenueCatWebhookHandler, { type: 'UNCANCELLATION', app_user_id: USER, product_id: 'monthly', expiration_at_ms: second + 30 * DAY });
  assert.deepStrictEqual(db.stateWrites, [
    { key: GRANT_KEY, value: { purchasedAt: first, subscriptionUntil: second } },
    { key: GRANT_KEY, value: { purchasedAt: second, subscriptionUntil: second + 30 * DAY } },
  ]);
}));

test("a purchase record that can't be read or written answers 500 so RevenueCat retries", withSecret(SECRET, async () => {
  const at = Date.now() - DAY;
  const purchase = { type: 'INITIAL_PURCHASE', app_user_id: USER, product_id: 'monthly', purchased_at_ms: at, expiration_at_ms: at + 30 * DAY };
  for (const fail of ['failStateRead', 'failStateWrite']) {
    const rows = { [USER]: freeRow() };
    const opts = { [fail]: true };
    const db = fakeSupabase(rows, opts);
    const { revenueCatWebhookHandler } = loadHandler(db);
    const res = await send(revenueCatWebhookHandler, purchase);
    assert.strictEqual(res.code, 500, fail);
    // The record is read before anything is written, to see whether a refund
    // already ended this purchase, and written after the profile.
    assert.strictEqual(rows[USER].subscription_tier, fail === 'failStateRead' ? 'free' : 'gold', fail);
    assert.deepStrictEqual(db.stateWrites, [], fail);
    // The retry repeats the profile write, which does no harm, and records the purchase.
    opts[fail] = false;
    const retry = await send(revenueCatWebhookHandler, purchase);
    assert.strictEqual(retry.code, 200, fail);
    assert.strictEqual(rows[USER].subscription_tier, 'gold', fail);
    assert.deepStrictEqual(db.state[GRANT_KEY], { purchasedAt: at, subscriptionUntil: at + 30 * DAY }, fail);
  }

  // A refund whose record can't be read ends nothing until it can be.
  const rows = { [USER]: { subscription_tier: 'gold', subscription_status: null, subscription_expires_at: new Date(at + 30 * DAY).toISOString(), stripe_customer_id: null } };
  const db = fakeSupabase(rows, { failStateRead: true, state: { [GRANT_KEY]: { purchasedAt: at } } });
  const { revenueCatWebhookHandler } = loadHandler(db);
  const res = await send(revenueCatWebhookHandler, { type: 'CANCELLATION', app_user_id: USER, product_id: 'monthly', cancel_reason: 'CUSTOMER_SUPPORT', purchased_at_ms: at, expiration_at_ms: at + DAY });
  assert.strictEqual(res.code, 500);
  assert.deepStrictEqual(db.writes, []);
  assert.strictEqual(rows[USER].subscription_tier, 'gold');
}));

test('a purchase or renewal sent again after its period ran out gives nothing back', withSecret(SECRET, async () => {
  const ended = Date.now() - 3600 * 1000;
  const renewed = ended - 30 * DAY;
  const bought = renewed - 30 * DAY;
  const rows = { [USER]: { ...freeRow(), subscription_tier: 'gold', subscription_expires_at: new Date(ended).toISOString() } };
  const db = fakeSupabase(rows, { state: { [GRANT_KEY]: { purchasedAt: renewed } } });
  const { revenueCatWebhookHandler } = loadHandler(db);
  // The renewed month ran out an hour ago, and its expiry ended the plan.
  await send(revenueCatWebhookHandler, { type: 'EXPIRATION', app_user_id: USER, product_id: 'monthly', expiration_at_ms: ended });
  assert.strictEqual(rows[USER].subscription_tier, 'free');
  const profileWrites = db.writes.length;

  // RevenueCat sends both months' grants again, on a retry or out of order.
  for (const event of [
    { type: 'RENEWAL', purchased_at_ms: renewed, expiration_at_ms: ended },
    { type: 'INITIAL_PURCHASE', purchased_at_ms: bought, expiration_at_ms: renewed },
  ]) {
    const res = await send(revenueCatWebhookHandler, { ...event, app_user_id: USER, product_id: 'monthly' });
    assert.strictEqual(res.code, 200, event.type);
    assert.strictEqual(res.body.skipped, 'already_expired', event.type);
  }
  assert.strictEqual(rows[USER].subscription_tier, 'free');
  assert.strictEqual(db.writes.length, profileWrites, 'no profile write');
  assert.deepStrictEqual(db.stateWrites, [], 'no record write');
}));

test('a grant sent again after its purchase was refunded gives nothing back, and a newer purchase still applies', withSecret(SECRET, async () => {
  const bought = Date.now() - 3 * DAY;
  const purchase = { type: 'INITIAL_PURCHASE', app_user_id: USER, product_id: 'monthly', purchased_at_ms: bought, expiration_at_ms: bought + 30 * DAY };
  const rows = { [USER]: freeRow() };
  const db = fakeSupabase(rows);
  const { revenueCatWebhookHandler } = loadHandler(db);
  await send(revenueCatWebhookHandler, purchase);
  const refund = await send(revenueCatWebhookHandler, { ...purchase, type: 'CANCELLATION', cancel_reason: 'CUSTOMER_SUPPORT', expiration_at_ms: bought + DAY });
  assert.strictEqual(refund.body.refunded, true);
  assert.deepStrictEqual(db.state[GRANT_KEY], { purchasedAt: bought, endedAt: bought });
  const profileWrites = db.writes.length;
  const recordWrites = db.stateWrites.length;

  // The purchase comes again on a retry or out of order, and so does a
  // change to it.
  for (const event of [purchase, { ...purchase, type: 'UNCANCELLATION' }]) {
    const res = await send(revenueCatWebhookHandler, event);
    assert.strictEqual(res.code, 200, event.type);
    assert.strictEqual(res.body.skipped, 'superseded', event.type);
  }
  assert.strictEqual(rows[USER].subscription_tier, 'free');
  assert.strictEqual(db.writes.length, profileWrites, 'no profile write');
  assert.strictEqual(db.stateWrites.length, recordWrites, 'no record write');

  // Subscribing again after the refund comes as a RENEWAL with a newer
  // purchase time, and it applies.
  const again = Date.now() - 3600 * 1000;
  const res = await send(revenueCatWebhookHandler, { ...purchase, type: 'RENEWAL', purchased_at_ms: again, expiration_at_ms: again + 30 * DAY });
  assert.strictEqual(res.body.tier, 'gold');
  assert.strictEqual(rows[USER].subscription_expires_at, new Date(again + 30 * DAY).toISOString());
  assert.deepStrictEqual(db.state[GRANT_KEY], { purchasedAt: again, endedAt: bought, subscriptionUntil: again + 30 * DAY });
}));

test('a purchase that lands after its own refund gives nothing back', withSecret(SECRET, async () => {
  // The purchase's first delivery failed, and the refund came through before
  // RevenueCat sent the purchase again. Nothing was on record for the account.
  const bought = Date.now() - 2 * DAY;
  const rows = { [USER]: freeRow() };
  const db = fakeSupabase(rows);
  const { revenueCatWebhookHandler } = loadHandler(db);
  const refund = await send(revenueCatWebhookHandler, { type: 'CANCELLATION', app_user_id: USER, product_id: 'yearly_gold', cancel_reason: 'CUSTOMER_SUPPORT', purchased_at_ms: bought, expiration_at_ms: bought + DAY });
  assert.strictEqual(refund.body.refunded, true);
  assert.deepStrictEqual(db.state[GRANT_KEY], { endedAt: bought });

  const res = await send(revenueCatWebhookHandler, { type: 'INITIAL_PURCHASE', app_user_id: USER, product_id: 'yearly_gold', purchased_at_ms: bought, expiration_at_ms: bought + 365 * DAY });
  assert.strictEqual(res.body.skipped, 'superseded');
  assert.strictEqual(rows[USER].subscription_tier, 'free');
}));

test('a reversed refund gives the refunded purchase back and clears its end, so its own events apply again', withSecret(SECRET, async () => {
  const bought = Date.now() - 3 * DAY;
  const until = bought + 30 * DAY;
  const purchase = { app_user_id: USER, product_id: 'monthly', purchased_at_ms: bought, expiration_at_ms: until };
  const rows = { [USER]: freeRow() };
  const db = fakeSupabase(rows);
  const { revenueCatWebhookHandler } = loadHandler(db);
  await send(revenueCatWebhookHandler, { ...purchase, type: 'INITIAL_PURCHASE' });
  await send(revenueCatWebhookHandler, { ...purchase, type: 'CANCELLATION', cancel_reason: 'CUSTOMER_SUPPORT', expiration_at_ms: bought + DAY });
  assert.strictEqual(rows[USER].subscription_tier, 'free');
  assert.deepStrictEqual(db.state[GRANT_KEY], { purchasedAt: bought, endedAt: bought });

  const res = await send(revenueCatWebhookHandler, { ...purchase, type: 'REFUND_REVERSED' });
  assert.strictEqual(res.body.tier, 'gold');
  assert.strictEqual(rows[USER].subscription_tier, 'gold');
  assert.strictEqual(rows[USER].subscription_expires_at, new Date(until).toISOString());
  assert.deepStrictEqual(db.state[GRANT_KEY], { purchasedAt: bought, subscriptionUntil: until });

  // Turning auto-renew back on applies as it would have before the refund.
  const uncancel = await send(revenueCatWebhookHandler, { ...purchase, type: 'UNCANCELLATION' });
  assert.strictEqual(uncancel.body.tier, 'gold');
}));

test('a reversed refund leaves the end of a later refunded purchase in place', withSecret(SECRET, async () => {
  // The first month was refunded, then the account subscribed again and that
  // was refunded too. Now Apple reverses the first refund.
  const first = Date.now() - 10 * DAY;
  const later = Date.now() - 2 * DAY;
  const rows = { [USER]: freeRow() };
  const db = fakeSupabase(rows, { state: { [GRANT_KEY]: { purchasedAt: later, endedAt: later } } });
  const { revenueCatWebhookHandler } = loadHandler(db);
  const res = await send(revenueCatWebhookHandler, { type: 'REFUND_REVERSED', app_user_id: USER, product_id: 'monthly', purchased_at_ms: first, expiration_at_ms: first + 30 * DAY });
  assert.strictEqual(res.body.tier, 'gold');
  assert.deepStrictEqual(db.state[GRANT_KEY], { purchasedAt: later, endedAt: later, subscriptionUntil: first + 30 * DAY });

  // The later purchase's grant sent again still gives nothing.
  const retried = await send(revenueCatWebhookHandler, { type: 'RENEWAL', app_user_id: USER, product_id: 'monthly', purchased_at_ms: later, expiration_at_ms: later + 30 * DAY });
  assert.strictEqual(retried.body.skipped, 'superseded');
  assert.strictEqual(rows[USER].subscription_expires_at, new Date(first + 30 * DAY).toISOString());
}));

test('a late refund of an older lifetime purchase keeps the later end on record', withSecret(SECRET, async () => {
  // The lifetime purchase was refunded, then a subscription bought after it
  // was refunded too, and now the lifetime refund comes again.
  const first = Date.now() - 10 * DAY;
  const later = Date.now() - 2 * DAY;
  const rows = { [USER]: freeRow() };
  const db = fakeSupabase(rows, { state: { [GRANT_KEY]: { purchasedAt: later, endedAt: later } } });
  const { revenueCatWebhookHandler } = loadHandler(db);
  const res = await send(revenueCatWebhookHandler, { type: 'CANCELLATION', app_user_id: USER, product_id: 'lifetime_gold', cancel_reason: 'CUSTOMER_SUPPORT', purchased_at_ms: first });
  assert.strictEqual(res.body.refunded, true);
  assert.deepStrictEqual(db.stateWrites, []);
  assert.deepStrictEqual(db.state[GRANT_KEY], { purchasedAt: later, endedAt: later });
}));

test('a lifetime refund records its end, and the lifetime purchase sent again gives nothing back', withSecret(SECRET, async () => {
  const bought = Date.now() - 2 * DAY;
  const purchase = { type: 'NON_RENEWING_PURCHASE', app_user_id: USER, product_id: 'lifetime_gold', purchased_at_ms: bought };
  const rows = { [USER]: freeRow() };
  const db = fakeSupabase(rows);
  const { revenueCatWebhookHandler } = loadHandler(db);
  await send(revenueCatWebhookHandler, purchase);
  assert.strictEqual(rows[USER].subscription_tier, 'lifetime');
  const refund = await send(revenueCatWebhookHandler, { ...purchase, type: 'CANCELLATION', cancel_reason: 'CUSTOMER_SUPPORT' });
  assert.strictEqual(refund.body.refunded, true);
  assert.strictEqual(rows[USER].subscription_tier, 'free');
  assert.deepStrictEqual(db.state[GRANT_KEY], { purchasedAt: bought, endedAt: bought });

  const profileWrites = db.writes.length;
  const res = await send(revenueCatWebhookHandler, purchase);
  assert.strictEqual(res.body.skipped, 'superseded');
  assert.strictEqual(rows[USER].subscription_tier, 'free');
  assert.strictEqual(db.writes.length, profileWrites, 'no profile write');
}));

test("a refund whose end can't be recorded answers 500 so RevenueCat sends it again", withSecret(SECRET, async () => {
  const bought = Date.now() - 2 * DAY;
  // A lifetime refund reads the record before the profile write, to see
  // whether an App Store subscription still runs, so a read that fails there
  // changes nothing yet.
  for (const [product, tier, fail] of [['monthly', 'gold', 'failStateWrite'], ['lifetime_gold', 'lifetime', 'failStateRead']]) {
    const rows = { [USER]: { ...freeRow(), subscription_tier: tier } };
    const opts = { [fail]: true, state: { [GRANT_KEY]: { purchasedAt: bought } } };
    const db = fakeSupabase(rows, opts);
    const { revenueCatWebhookHandler } = loadHandler(db);
    const refund = { type: 'CANCELLATION', app_user_id: USER, product_id: product, cancel_reason: 'CUSTOMER_SUPPORT', purchased_at_ms: bought };
    const res = await send(revenueCatWebhookHandler, refund);
    assert.strictEqual(res.code, 500, fail);
    assert.strictEqual(rows[USER].subscription_tier, fail === 'failStateRead' ? tier : 'free', fail);
    assert.deepStrictEqual(db.state[GRANT_KEY], { purchasedAt: bought }, fail);

    // The retry repeats the profile write, which does no harm, and records the end.
    opts[fail] = false;
    const retry = await send(revenueCatWebhookHandler, refund);
    assert.strictEqual(retry.code, 200, fail);
    assert.strictEqual(retry.body.refunded, true, fail);
    assert.deepStrictEqual(db.state[GRANT_KEY], { purchasedAt: bought, endedAt: bought }, fail);
  }
}));

test('an older RENEWAL sent again after a newer one changes nothing', withSecret(SECRET, async () => {
  // The newer month was bought before the older one ran out, so the older
  // RENEWAL hasn't expired when it comes again, and only its purchase time
  // shows it's been replaced.
  const olderEnd = Date.now() + 12 * 3600 * 1000;
  const older = { type: 'RENEWAL', app_user_id: USER, product_id: 'monthly', purchased_at_ms: olderEnd - 30 * DAY, expiration_at_ms: olderEnd };
  const newer = { ...older, purchased_at_ms: Date.now() - 12 * 3600 * 1000, expiration_at_ms: olderEnd + 30 * DAY };
  const rows = { [USER]: freeRow() };
  const db = fakeSupabase(rows);
  const { revenueCatWebhookHandler } = loadHandler(db);
  await send(revenueCatWebhookHandler, older);
  await send(revenueCatWebhookHandler, newer);
  const before = { ...rows[USER] };
  const profileWrites = db.writes.length;
  const recordWrites = db.stateWrites.length;

  const res = await send(revenueCatWebhookHandler, older);
  assert.strictEqual(res.code, 200);
  assert.strictEqual(res.body.skipped, 'superseded');
  assert.deepStrictEqual(rows[USER], before);
  assert.strictEqual(rows[USER].subscription_expires_at, new Date(olderEnd + 30 * DAY).toISOString(), 'the expiry stays where the newer month put it');
  assert.strictEqual(db.writes.length, profileWrites, 'no profile write');
  assert.strictEqual(db.stateWrites.length, recordWrites, 'no record write');
  assert.deepStrictEqual(db.state[GRANT_KEY], { purchasedAt: newer.purchased_at_ms, subscriptionUntil: olderEnd + 30 * DAY });
}));

test('a lifetime grant older than the purchase on record still applies', withSecret(SECRET, async () => {
  const newer = Date.now() - DAY;
  const older = Date.now() - 5 * DAY;
  // A one-time lifetime purchase, and a plan change to a lifetime product.
  for (const event of [
    { type: 'NON_RENEWING_PURCHASE', product_id: 'lifetime_gold' },
    { type: 'PRODUCT_CHANGE', product_id: 'monthly', new_product_id: 'lifetime_gold' },
  ]) {
    const rows = { [USER]: { ...freeRow(), subscription_tier: 'gold', subscription_expires_at: new Date(newer + 30 * DAY).toISOString() } };
    const db = fakeSupabase(rows, { state: { [GRANT_KEY]: { purchasedAt: newer } } });
    const { revenueCatWebhookHandler } = loadHandler(db);
    const res = await send(revenueCatWebhookHandler, { ...event, app_user_id: USER, purchased_at_ms: older });
    assert.strictEqual(res.body.tier, 'lifetime', event.type);
    assert.strictEqual(rows[USER].subscription_tier, 'lifetime', event.type);
    assert.strictEqual(rows[USER].subscription_expires_at, null, event.type);
    assert.deepStrictEqual(db.state[GRANT_KEY], { purchasedAt: newer, lifetime: true }, `${event.type}: the newer purchase stays on record`);
  }
}));

test('a grant with the same purchase time as the record still applies', withSecret(SECRET, async () => {
  const renewed = Date.now() - DAY;
  const period = { app_user_id: USER, product_id: 'monthly', purchased_at_ms: renewed, expiration_at_ms: renewed + 30 * DAY };
  const rows = { [USER]: freeRow() };
  const db = fakeSupabase(rows);
  const { revenueCatWebhookHandler } = loadHandler(db);
  await send(revenueCatWebhookHandler, { ...period, type: 'RENEWAL' });
  assert.deepStrictEqual(db.state[GRANT_KEY], { purchasedAt: renewed, subscriptionUntil: renewed + 30 * DAY });

  // Turning auto-renew back on, then Apple extending the same period.
  const uncancel = await send(revenueCatWebhookHandler, { ...period, type: 'UNCANCELLATION' });
  assert.strictEqual(uncancel.body.tier, 'gold');
  const extended = await send(revenueCatWebhookHandler, { ...period, type: 'SUBSCRIPTION_EXTENDED', expiration_at_ms: renewed + 37 * DAY });
  assert.strictEqual(extended.body.tier, 'gold');
  assert.strictEqual(rows[USER].subscription_expires_at, new Date(renewed + 37 * DAY).toISOString());
}));

test('a sandbox lifetime purchase applies only for an account listed in REVENUECAT_SANDBOX_LIFETIME_USERS', withSecret(SECRET, async () => {
  const purchase = { type: 'NON_RENEWING_PURCHASE', app_user_id: USER, product_id: 'lifetime_gold', environment: 'SANDBOX', purchased_at_ms: Date.now() - DAY };
  for (const listed of [undefined, OTHER]) {
    const rows = { [USER]: freeRow() };
    const db = fakeSupabase(rows);
    const { revenueCatWebhookHandler } = loadHandler(db);
    let res;
    const logs = await captureLogs(() => withEnv({ REVENUECAT_SANDBOX_LIFETIME_USERS: listed }, async () => {
      res = await send(revenueCatWebhookHandler, purchase);
    }));
    assert.strictEqual(res.code, 200, String(listed));
    assert.strictEqual(res.body.skipped, 'sandbox_lifetime', String(listed));
    assert.deepStrictEqual(rows[USER], freeRow(), String(listed));
    assert.deepStrictEqual(db.writes, [], String(listed));
    assert.deepStrictEqual(db.stateWrites, [], String(listed));
    assert.ok(logs.some((line) => line.includes('REVENUECAT_SANDBOX_LIFETIME_USERS')), 'the skip is logged with what would allow it');
  }

  // Listed, with others and spaces around it, the purchase applies.
  const rows = { [USER]: freeRow() };
  const { revenueCatWebhookHandler } = loadHandler(fakeSupabase(rows));
  await withEnv({ REVENUECAT_SANDBOX_LIFETIME_USERS: `${OTHER}, ${USER}` }, async () => {
    const res = await send(revenueCatWebhookHandler, purchase);
    assert.strictEqual(res.body.tier, 'lifetime');
  });
  assert.strictEqual(rows[USER].subscription_tier, 'lifetime');

  // A sandbox subscription still applies for anyone, since it runs out on its own.
  const subscriber = { [USER]: freeRow() };
  const sub = loadHandler(fakeSupabase(subscriber));
  const res = await send(sub.revenueCatWebhookHandler, { type: 'INITIAL_PURCHASE', app_user_id: USER, product_id: 'monthly', environment: 'SANDBOX', expiration_at_ms: Date.now() + 5 * 60 * 1000 });
  assert.strictEqual(res.body.tier, 'gold');
}));

test("a sandbox lifetime refund ends nothing for an account that isn't listed", withSecret(SECRET, async () => {
  const rows = { [USER]: { ...freeRow(), subscription_tier: 'lifetime' } };
  const db = fakeSupabase(rows);
  const { revenueCatWebhookHandler } = loadHandler(db);
  await withEnv({ REVENUECAT_SANDBOX_LIFETIME_USERS: undefined }, async () => {
    const res = await send(revenueCatWebhookHandler, { type: 'CANCELLATION', app_user_id: USER, product_id: 'lifetime_gold', environment: 'SANDBOX', cancel_reason: 'CUSTOMER_SUPPORT', purchased_at_ms: Date.now() - DAY });
    assert.strictEqual(res.body.skipped, 'sandbox_lifetime');
  });
  assert.strictEqual(rows[USER].subscription_tier, 'lifetime');
  assert.deepStrictEqual(db.writes, []);
}));

test('a yearly App Store subscriber who buys lifetime and refunds it keeps Gold until the yearly ends', withSecret(SECRET, async () => {
  const yearlyBought = Date.now() - 10 * DAY;
  const yearlyEnds = yearlyBought + 365 * DAY;
  const lifetimeBought = Date.now() - 2 * DAY;
  const rows = { [USER]: freeRow() };
  const db = fakeSupabase(rows);
  const { revenueCatWebhookHandler } = loadHandler(db);
  await send(revenueCatWebhookHandler, { type: 'INITIAL_PURCHASE', app_user_id: USER, product_id: 'yearly_gold', purchased_at_ms: yearlyBought, expiration_at_ms: yearlyEnds });
  await send(revenueCatWebhookHandler, { type: 'NON_RENEWING_PURCHASE', app_user_id: USER, product_id: 'lifetime_gold', purchased_at_ms: lifetimeBought });
  assert.strictEqual(rows[USER].subscription_tier, 'lifetime');

  const res = await send(revenueCatWebhookHandler, { type: 'CANCELLATION', app_user_id: USER, product_id: 'lifetime_gold', cancel_reason: 'CUSTOMER_SUPPORT', purchased_at_ms: lifetimeBought });
  assert.strictEqual(res.body.refunded, true);
  assert.strictEqual(res.body.tier, 'gold');
  assert.strictEqual(rows[USER].subscription_tier, 'gold');
  assert.strictEqual(rows[USER].subscription_expires_at, new Date(yearlyEnds).toISOString());
  assert.deepStrictEqual(db.state[GRANT_KEY], { purchasedAt: lifetimeBought, endedAt: lifetimeBought, subscriptionUntil: yearlyEnds });
}));

test('a subscription renewed while lifetime holds still counts after a lifetime refund, and one refunded or expired meanwhile does not', withSecret(SECRET, async () => {
  const lifetimeBought = Date.now() - 20 * DAY;
  const renewed = Date.now() - 2 * DAY;
  const renewalEnds = renewed + 30 * DAY;
  const lifetimeRow = () => ({ ...freeRow(), subscription_tier: 'lifetime' });
  const lifetimeRefund = { type: 'CANCELLATION', app_user_id: USER, product_id: 'lifetime_gold', cancel_reason: 'CUSTOMER_SUPPORT', purchased_at_ms: lifetimeBought };
  const renewal = { type: 'RENEWAL', app_user_id: USER, product_id: 'monthly', purchased_at_ms: renewed, expiration_at_ms: renewalEnds };

  // The renewal is kept on record while lifetime holds, and Gold runs to its end.
  let rows = { [USER]: lifetimeRow() };
  let db = fakeSupabase(rows, { state: { [GRANT_KEY]: { purchasedAt: lifetimeBought, lifetime: true } } });
  let handler = loadHandler(db).revenueCatWebhookHandler;
  assert.deepStrictEqual((await send(handler, renewal)).body.kept, 'lifetime');
  assert.strictEqual(rows[USER].subscription_tier, 'lifetime');
  await send(handler, lifetimeRefund);
  assert.strictEqual(rows[USER].subscription_tier, 'gold');
  assert.strictEqual(rows[USER].subscription_expires_at, new Date(renewalEnds).toISOString());

  // Refunded while lifetime held, the subscription leaves nothing to fall back on.
  rows = { [USER]: lifetimeRow() };
  db = fakeSupabase(rows, { state: { [GRANT_KEY]: { purchasedAt: lifetimeBought, lifetime: true } } });
  handler = loadHandler(db).revenueCatWebhookHandler;
  await send(handler, renewal);
  assert.strictEqual((await send(handler, { ...renewal, type: 'CANCELLATION', cancel_reason: 'CUSTOMER_SUPPORT', expiration_at_ms: renewed + DAY })).body.kept, 'lifetime');
  await send(handler, lifetimeRefund);
  assert.strictEqual(rows[USER].subscription_tier, 'free');

  // Expired while lifetime held, the same.
  rows = { [USER]: lifetimeRow() };
  db = fakeSupabase(rows, { state: { [GRANT_KEY]: { purchasedAt: lifetimeBought, lifetime: true, subscriptionUntil: Date.now() + DAY } } });
  handler = loadHandler(db).revenueCatWebhookHandler;
  await send(handler, { type: 'EXPIRATION', app_user_id: USER, product_id: 'monthly', expiration_at_ms: Date.now() + DAY });
  assert.strictEqual(db.state[GRANT_KEY].subscriptionUntil, undefined);
  await send(handler, lifetimeRefund);
  assert.strictEqual(rows[USER].subscription_tier, 'free');
}));

test('a guest purchase goes to the account its aliases name, and two named accounts change nothing', withSecret(SECRET, async () => {
  const guest = '$RCAnonymousID:4f1c2b';
  const rows = { [USER]: freeRow(), [OTHER]: freeRow() };
  const db = fakeSupabase(rows);
  const { revenueCatWebhookHandler } = loadHandler(db);
  const purchase = { type: 'INITIAL_PURCHASE', app_user_id: guest, product_id: 'monthly', expiration_at_ms: Date.now() + 30 * DAY };

  let res = await send(revenueCatWebhookHandler, { ...purchase, aliases: [guest, USER] });
  assert.strictEqual(res.body.tier, 'gold');
  assert.strictEqual(rows[USER].subscription_tier, 'gold');

  rows[USER] = freeRow();
  res = await send(revenueCatWebhookHandler, { ...purchase, aliases: [guest, USER, OTHER] });
  assert.strictEqual(res.body.skipped, 'ambiguous_user');
  res = await send(revenueCatWebhookHandler, { ...purchase, aliases: [guest] });
  assert.strictEqual(res.body.skipped, 'anonymous_user');
  assert.strictEqual(rows[USER].subscription_tier, 'free');
  assert.strictEqual(rows[OTHER].subscription_tier, 'free');
}));

test('a TRANSFER moves the plan: the account it left loses Gold and the one it reached gets it', withSecret(SECRET, async () => {
  const until = Date.now() + 200 * DAY;
  const rows = {
    [OTHER]: { ...freeRow(), subscription_tier: 'gold', subscription_expires_at: new Date(until).toISOString() },
    [USER]: freeRow(),
  };
  const db = fakeSupabase(rows, { state: { [`revenuecat_grant:${OTHER}`]: { purchasedAt: Date.now() - 100 * DAY, subscriptionUntil: until } } });
  const mod = loadHandler(db);
  mod.setWebPlanCheck(noWebPlan);
  const { revenueCatWebhookHandler } = mod;
  // After the restore, RevenueCat holds the yearly for USER and nothing for OTHER.
  const api = revenueCatApi({
    [USER]: { subscriptions: { yearly_gold: { expires_date: new Date(until).toISOString(), refunded_at: null, is_sandbox: false } }, non_subscriptions: {} },
  });
  await withRevenueCatApi(api, async () => {
    const res = await send(revenueCatWebhookHandler, { type: 'TRANSFER', transferred_from: [OTHER, '$RCAnonymousID:9d'], transferred_to: [USER] });
    assert.strictEqual(res.code, 200);
  });
  assert.deepStrictEqual(api.calls.map((call) => call.url).sort(), [OTHER, USER].map((id) => `https://api.revenuecat.com/v1/subscribers/${id}`).sort());
  assert.ok(api.calls.every((call) => call.authorization === `Bearer ${REST_KEY}`));
  assert.strictEqual(rows[OTHER].subscription_tier, 'free', 'the old account keeps nothing');
  assert.strictEqual(rows[USER].subscription_tier, 'gold');
  assert.strictEqual(rows[USER].subscription_expires_at, new Date(until).toISOString());
  assert.strictEqual(db.state[`revenuecat_grant:${OTHER}`].subscriptionUntil, undefined);
}));

test('without REVENUECAT_SECRET_KEY a TRANSFER is only logged and the sync route answers 503', withSecret(SECRET, async () => {
  const rows = { [USER]: freeRow() };
  const db = fakeSupabase(rows, { users: { 'good-token': USER } });
  const mod = loadHandler(db);
  await withEnv({ REVENUECAT_SECRET_KEY: undefined }, async () => {
    const transfer = await send(mod.revenueCatWebhookHandler, { type: 'TRANSFER', transferred_from: [OTHER], transferred_to: [USER] });
    assert.strictEqual(transfer.code, 200);
    assert.strictEqual(transfer.body.skipped, 'transfer');
    const sync = await syncAs(mod.revenueCatSyncHandler, 'good-token');
    assert.strictEqual(sync.code, 503);
  });
  assert.deepStrictEqual(db.writes, []);
}));

test('POST /v1/revenuecat/sync needs a signed-in account and writes the plan RevenueCat holds for it', withSecret(SECRET, async () => {
  const until = Date.now() + 30 * DAY;
  const cases = [
    ['lifetime', { entitlements: { Gold: { product_identifier: 'lifetime_gold', expires_date: null } }, subscriptions: {}, non_subscriptions: { lifetime_gold: [{ is_sandbox: false }] } }, { subscription_tier: 'lifetime', subscription_expires_at: null }],
    ['a running subscription', { subscriptions: { monthly: { expires_date: new Date(until).toISOString(), refunded_at: null } }, non_subscriptions: {} }, { subscription_tier: 'gold', subscription_expires_at: new Date(until).toISOString() }],
    ['a refunded subscription', { subscriptions: { monthly: { expires_date: new Date(until).toISOString(), refunded_at: new Date().toISOString() } }, non_subscriptions: {} }, { subscription_tier: 'free', subscription_expires_at: null }],
    ['an unlisted sandbox lifetime', { entitlements: { Gold: { product_identifier: 'lifetime_gold', expires_date: null } }, subscriptions: {}, non_subscriptions: { lifetime_gold: [{ is_sandbox: true }] } }, { subscription_tier: 'free', subscription_expires_at: null }],
    ['nothing', { subscriptions: {}, non_subscriptions: {} }, { subscription_tier: 'free', subscription_expires_at: null }],
  ];
  for (const [label, subscriber, expected] of cases) {
    const rows = { [USER]: { ...freeRow(), subscription_tier: 'gold', subscription_expires_at: inDays(3) } };
    const db = fakeSupabase(rows, { users: { 'good-token': USER } });
    const mod = loadHandler(db);
    mod.setWebPlanCheck(noWebPlan);
    await withRevenueCatApi(revenueCatApi({ [USER]: subscriber }), async () => {
      assert.strictEqual((await syncAs(mod.revenueCatSyncHandler, null)).code, 401, label);
      assert.strictEqual((await syncAs(mod.revenueCatSyncHandler, 'bad-token')).code, 401, label);
      const res = await syncAs(mod.revenueCatSyncHandler, 'good-token');
      assert.strictEqual(res.code, 200, label);
      assert.strictEqual(res.body.tier, expected.subscription_tier, label);
    });
    assert.strictEqual(rows[USER].subscription_tier, expected.subscription_tier, label);
    assert.strictEqual(rows[USER].subscription_expires_at, expected.subscription_expires_at, label);
  }

  // A plan bought on troystack.ai stays when RevenueCat holds nothing.
  const rows = { [USER]: { ...freeRow(), subscription_tier: 'gold', stripe_customer_id: 'cus_web' } };
  const mod = loadHandler(fakeSupabase(rows, { users: { 'good-token': USER } }));
  mod.setWebPlanCheck(async () => ({ tier: 'gold', status: 'active', trialEnd: null }));
  await withRevenueCatApi(revenueCatApi({}), async () => {
    assert.strictEqual((await syncAs(mod.revenueCatSyncHandler, 'good-token')).body.tier, 'gold');
  });
  assert.strictEqual(rows[USER].subscription_status, 'active');
}));

test('the sync leaves a running temporary grant alone, and a RevenueCat failure answers 500 and writes nothing', withSecret(SECRET, async () => {
  const temporary = { ...freeRow(), subscription_tier: 'gold', subscription_status: 'temporary_grant', subscription_expires_at: inDays(1) };
  let rows = { [USER]: { ...temporary } };
  let db = fakeSupabase(rows, { users: { 'good-token': USER } });
  let mod = loadHandler(db);
  mod.setWebPlanCheck(noWebPlan);
  await withRevenueCatApi(revenueCatApi({}), async () => {
    assert.strictEqual((await syncAs(mod.revenueCatSyncHandler, 'good-token')).code, 200);
  });
  assert.deepStrictEqual(rows[USER], temporary);

  rows = { [USER]: { ...freeRow(), subscription_tier: 'gold', subscription_expires_at: inDays(3) } };
  db = fakeSupabase(rows, { users: { 'good-token': USER } });
  mod = loadHandler(db);
  mod.setWebPlanCheck(noWebPlan);
  await captureLogs(() => withRevenueCatApi(revenueCatApi({}, { status: 500 }), async () => {
    assert.strictEqual((await syncAs(mod.revenueCatSyncHandler, 'good-token')).code, 500);
  }));
  assert.deepStrictEqual(db.writes, []);
  assert.deepStrictEqual(db.stateWrites, []);
}));

test('the RevenueCat secret key stays out of the logs and the answers', withSecret(SECRET, async () => {
  const rows = { [USER]: freeRow(), [OTHER]: freeRow() };
  const mod = loadHandler(fakeSupabase(rows, { users: { 'good-token': USER } }));
  mod.setWebPlanCheck(noWebPlan);
  const answers = [];
  const logs = await captureLogs(async () => {
    for (const status of [200, 401, 500]) {
      await withRevenueCatApi(revenueCatApi({}, { status }), async () => {
        answers.push((await syncAs(mod.revenueCatSyncHandler, 'good-token')).body);
        answers.push((await send(mod.revenueCatWebhookHandler, { type: 'TRANSFER', transferred_from: [OTHER], transferred_to: [USER] })).body);
      });
    }
  });
  assert.ok(logs.length > 0);
  assert.ok(!logs.some((line) => line.includes(REST_KEY)), 'no log line holds the key');
  assert.ok(!answers.some((body) => JSON.stringify(body).includes(REST_KEY)), 'no answer holds the key');
}));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(done) {
  for (let i = 0; i < 200 && !done(); i += 1) await sleep(5);
  assert.ok(done(), 'timed out waiting');
}

test('an expiry and the renewal after it, at once for one account, take turns so the renewal stays on record', withSecret(SECRET, async () => {
  const periodEnd = Date.now() - 60 * 1000;
  let answerLate;
  const late = new Promise((resolve) => { answerLate = resolve; });
  const rows = { [USER]: { ...freeRow(), subscription_tier: 'lifetime', subscription_status: 'active' } };
  const db = fakeSupabase(rows, { holdFirstRecordRead: late, state: { [GRANT_KEY]: { purchasedAt: periodEnd - 30 * DAY, subscriptionUntil: periodEnd, lifetime: true } } });
  const { revenueCatWebhookHandler } = loadHandler(db);

  // The expiry reads the record, and the answer is slow to come back.
  const expiry = send(revenueCatWebhookHandler, { type: 'EXPIRATION', app_user_id: USER, product_id: 'monthly', expiration_at_ms: periodEnd });
  await until(() => db.recordReads === 1);
  const renewal = send(revenueCatWebhookHandler, { type: 'RENEWAL', app_user_id: USER, product_id: 'monthly', purchased_at_ms: periodEnd, expiration_at_ms: periodEnd + 30 * DAY });
  await sleep(150);
  assert.strictEqual(db.recordReads, 1, 'the renewal waits for its turn rather than reading the record');
  answerLate();
  assert.deepStrictEqual((await Promise.all([expiry, renewal])).map((res) => res.code), [200, 200]);
  assert.strictEqual(db.state[GRANT_KEY].subscriptionUntil, periodEnd + 30 * DAY, "the expiry doesn't clear the renewed period");
}));

test('a lifetime refund and a renewal at once take turns, so the renewal is neither lost nor joined by lifetime again', withSecret(SECRET, async () => {
  const lifetimeBought = Date.now() - 20 * DAY;
  const renewed = Date.now() - 60 * 1000;
  let answerLate;
  const late = new Promise((resolve) => { answerLate = resolve; });
  const rows = { [USER]: { ...freeRow(), subscription_tier: 'lifetime', subscription_status: 'active' } };
  const db = fakeSupabase(rows, { holdFirstRecordRead: late, state: { [GRANT_KEY]: { purchasedAt: lifetimeBought, lifetime: true } } });
  const { revenueCatWebhookHandler } = loadHandler(db);

  // The refund looks for what else the account holds, and that answer is slow.
  const refund = send(revenueCatWebhookHandler, { type: 'CANCELLATION', app_user_id: USER, product_id: 'lifetime_gold', cancel_reason: 'CUSTOMER_SUPPORT', purchased_at_ms: lifetimeBought });
  await until(() => db.recordReads === 1);
  const renewal = send(revenueCatWebhookHandler, { type: 'RENEWAL', app_user_id: USER, product_id: 'monthly', purchased_at_ms: renewed, expiration_at_ms: renewed + 30 * DAY });
  await sleep(150);
  assert.strictEqual(db.recordReads, 1, 'the renewal waits for its turn');
  answerLate();
  assert.deepStrictEqual((await Promise.all([refund, renewal])).map((res) => res.code), [200, 200]);
  assert.strictEqual(rows[USER].subscription_tier, 'gold', 'the paid renewal keeps Gold');
  assert.strictEqual(rows[USER].subscription_expires_at, new Date(renewed + 30 * DAY).toISOString());
  assert.deepStrictEqual(db.state[GRANT_KEY], { purchasedAt: renewed, endedAt: lifetimeBought, subscriptionUntil: renewed + 30 * DAY }, 'lifetime stays refunded');
}));

test("an event for an account another instance is applying waits its turn, and answers 500 if the turn isn't given back", withSecret(SECRET, async () => {
  const turnKey = `revenuecat_turn:${USER}`;
  const purchase = { type: 'INITIAL_PURCHASE', app_user_id: USER, product_id: 'monthly', expiration_at_ms: Date.now() + 30 * DAY };
  const heldElsewhere = () => ({ until: new Date(Date.now() + 60 * 1000).toISOString(), owner: 'another-instance' });

  // Still held when the wait runs out: 500, so RevenueCat sends it again, and nothing written.
  let rows = { [USER]: freeRow() };
  let db = fakeSupabase(rows, { users: { 'good-token': USER }, state: { [turnKey]: heldElsewhere() } });
  let mod = loadHandler(db);
  mod.setWebPlanCheck(noWebPlan);
  mod.accountTurn.waitMs = 250;
  const logs = await captureLogs(async () => {
    assert.strictEqual((await send(mod.revenueCatWebhookHandler, purchase)).code, 500);
    await withRevenueCatApi(revenueCatApi({}), async () => {
      assert.strictEqual((await syncAs(mod.revenueCatSyncHandler, 'good-token')).code, 500, 'the sync waits its turn too');
    });
  });
  assert.ok(logs.length > 0);
  assert.deepStrictEqual(db.writes, []);
  assert.strictEqual(db.state[turnKey].owner, 'another-instance', "the other instance's turn stays");

  // Given back during the wait: the event applies, and gives its own turn back.
  rows = { [USER]: freeRow() };
  db = fakeSupabase(rows, { state: { [turnKey]: heldElsewhere() } });
  mod = loadHandler(db);
  const pending = send(mod.revenueCatWebhookHandler, purchase);
  await sleep(120);
  delete db.state[turnKey];
  assert.strictEqual((await pending).code, 200);
  assert.strictEqual(rows[USER].subscription_tier, 'gold');
  assert.strictEqual(db.state[turnKey], undefined);

  // Left by a request that died: cleared once it runs out.
  rows = { [USER]: freeRow() };
  db = fakeSupabase(rows, { state: { [turnKey]: { until: new Date(Date.now() - 1000).toISOString(), owner: 'a-request-that-died' } } });
  mod = loadHandler(db);
  assert.strictEqual((await send(mod.revenueCatWebhookHandler, purchase)).code, 200);
  assert.strictEqual(db.state[turnKey], undefined);
}));

test('an App Store grant marks the profile active, or trialing during a free trial, and an expiry or a refund clears it', withSecret(SECRET, async () => {
  const until = Date.now() + 7 * DAY;
  const rows = { [USER]: freeRow() };
  const db = fakeSupabase(rows);
  const { revenueCatWebhookHandler } = loadHandler(db);
  const fields = () => ({ tier: rows[USER].subscription_tier, status: rows[USER].subscription_status, trialEnd: rows[USER].trial_end });

  await send(revenueCatWebhookHandler, { type: 'INITIAL_PURCHASE', app_user_id: USER, product_id: 'monthly', period_type: 'TRIAL', purchased_at_ms: Date.now() - DAY, expiration_at_ms: until });
  assert.deepStrictEqual(fields(), { tier: 'gold', status: 'trialing', trialEnd: new Date(until).toISOString() });
  await send(revenueCatWebhookHandler, { type: 'RENEWAL', app_user_id: USER, product_id: 'monthly', period_type: 'NORMAL', purchased_at_ms: Date.now(), expiration_at_ms: until + 30 * DAY });
  assert.deepStrictEqual(fields(), { tier: 'gold', status: 'active', trialEnd: null });
  await send(revenueCatWebhookHandler, { type: 'EXPIRATION', app_user_id: USER, product_id: 'monthly', expiration_at_ms: until + 30 * DAY });
  assert.deepStrictEqual(fields(), { tier: 'free', status: null, trialEnd: null });

  const lifetimeBought = Date.now() - 2 * DAY;
  await send(revenueCatWebhookHandler, { type: 'NON_RENEWING_PURCHASE', app_user_id: USER, product_id: 'lifetime_gold', purchased_at_ms: lifetimeBought });
  assert.deepStrictEqual(fields(), { tier: 'lifetime', status: 'active', trialEnd: null });
  await send(revenueCatWebhookHandler, { type: 'CANCELLATION', app_user_id: USER, product_id: 'lifetime_gold', cancel_reason: 'CUSTOMER_SUPPORT', purchased_at_ms: lifetimeBought });
  assert.deepStrictEqual(fields(), { tier: 'free', status: null, trialEnd: null });

  // A subscription still on record after a lifetime refund counts as active.
  rows[USER] = { ...freeRow(), subscription_tier: 'lifetime', subscription_status: 'active' };
  db.state[GRANT_KEY] = { purchasedAt: lifetimeBought, lifetime: true, subscriptionUntil: until };
  await send(revenueCatWebhookHandler, { type: 'CANCELLATION', app_user_id: USER, product_id: 'lifetime_gold', cancel_reason: 'CUSTOMER_SUPPORT', purchased_at_ms: lifetimeBought });
  assert.deepStrictEqual(fields(), { tier: 'gold', status: 'active', trialEnd: null });
}));

test('a temporary grant delivered after its day is over, or after its expiry was applied, gives nothing', withSecret(SECRET, async () => {
  // Retried after the day it covered ran out.
  let rows = { [USER]: freeRow() };
  let db = fakeSupabase(rows);
  let handler = loadHandler(db).revenueCatWebhookHandler;
  let res = await send(handler, { type: 'TEMPORARY_ENTITLEMENT_GRANT', app_user_id: USER, store: 'APP_STORE', event_timestamp_ms: Date.now() - 25 * 3600 * 1000 });
  assert.strictEqual(res.code, 200);
  assert.strictEqual(res.body.skipped, 'already_expired');
  assert.deepStrictEqual(db.writes, []);

  // Delivered again after the expiry that ended it, inside its day.
  rows = { [USER]: freeRow() };
  db = fakeSupabase(rows);
  handler = loadHandler(db).revenueCatWebhookHandler;
  const grantedAt = Date.now() - 3 * 3600 * 1000;
  const grant = { type: 'TEMPORARY_ENTITLEMENT_GRANT', app_user_id: USER, store: 'APP_STORE', event_timestamp_ms: grantedAt };
  await send(handler, grant);
  assert.strictEqual(rows[USER].subscription_status, 'temporary_grant');
  await send(handler, { type: 'EXPIRATION', app_user_id: USER, product_id: 'monthly', event_timestamp_ms: grantedAt + 3600 * 1000 });
  assert.strictEqual(rows[USER].subscription_tier, 'free');
  const writes = db.writes.length;
  res = await send(handler, grant);
  assert.strictEqual(res.body.skipped, 'superseded');
  assert.strictEqual(rows[USER].subscription_tier, 'free');
  assert.strictEqual(db.writes.length, writes, 'no profile write');

  // A later outage still gets its day.
  res = await send(handler, { ...grant, event_timestamp_ms: Date.now() - 60 * 1000 });
  assert.strictEqual(res.body.temporary, true);
  assert.strictEqual(rows[USER].subscription_tier, 'gold');
}));

test("without the web plan check stripe.js hands in, the sync answers 503 and a TRANSFER changes no one", withSecret(SECRET, async () => {
  const rows = {
    [USER]: { ...freeRow(), subscription_tier: 'gold', subscription_status: 'active', stripe_customer_id: 'cus_web' },
    [OTHER]: { ...freeRow(), subscription_tier: 'lifetime', subscription_status: 'active', stripe_customer_id: 'cus_other' },
  };
  const db = fakeSupabase(rows, { users: { 'good-token': USER } });
  const mod = loadHandler(db);
  const api = revenueCatApi({});
  await captureLogs(() => withRevenueCatApi(api, async () => {
    assert.strictEqual((await syncAs(mod.revenueCatSyncHandler, 'good-token')).code, 503);
    const transfer = await send(mod.revenueCatWebhookHandler, { type: 'TRANSFER', transferred_from: [OTHER], transferred_to: [USER] });
    assert.strictEqual(transfer.code, 200);
    assert.strictEqual(transfer.body.skipped, 'transfer');
  }));
  assert.deepStrictEqual(api.calls, []);
  assert.deepStrictEqual(db.writes, []);
  assert.strictEqual(rows[USER].subscription_tier, 'gold', 'a web plan is never written over');
  assert.strictEqual(rows[OTHER].subscription_tier, 'lifetime');
}));

test('an App Store free trial stays trialing through the sync, and through a lifetime refund that falls back to it', withSecret(SECRET, async () => {
  const trialEnds = Date.now() + 5 * DAY;
  const trialSubscriber = (periodType) => ({ subscriptions: { monthly: { expires_date: new Date(trialEnds).toISOString(), period_type: periodType, refunded_at: null } }, non_subscriptions: {} });
  const rows = { [USER]: freeRow() };
  const db = fakeSupabase(rows, { users: { 'good-token': USER } });
  const mod = loadHandler(db);
  mod.setWebPlanCheck(noWebPlan);
  const profile = () => ({ tier: rows[USER].subscription_tier, status: rows[USER].subscription_status, trialEnd: rows[USER].trial_end, expires: rows[USER].subscription_expires_at });

  await withRevenueCatApi(revenueCatApi({ [USER]: trialSubscriber('trial') }), async () => {
    assert.strictEqual((await syncAs(mod.revenueCatSyncHandler, 'good-token')).code, 200);
  });
  assert.deepStrictEqual(profile(), { tier: 'gold', status: 'trialing', trialEnd: new Date(trialEnds).toISOString(), expires: new Date(trialEnds).toISOString() });
  // Once the trial has turned into a paid period, the sync says active.
  await withRevenueCatApi(revenueCatApi({ [USER]: trialSubscriber('normal') }), async () => {
    assert.strictEqual((await syncAs(mod.revenueCatSyncHandler, 'good-token')).code, 200);
  });
  assert.deepStrictEqual(profile(), { tier: 'gold', status: 'active', trialEnd: null, expires: new Date(trialEnds).toISOString() });

  // A trial from a webhook grant is kept on record too.
  rows[USER] = freeRow();
  delete db.state[GRANT_KEY];
  const lifetimeBought = Date.now() - DAY;
  await send(mod.revenueCatWebhookHandler, { type: 'INITIAL_PURCHASE', app_user_id: USER, product_id: 'monthly', period_type: 'TRIAL', purchased_at_ms: Date.now() - 2 * DAY, expiration_at_ms: trialEnds });
  await send(mod.revenueCatWebhookHandler, { type: 'NON_RENEWING_PURCHASE', app_user_id: USER, product_id: 'lifetime_gold', purchased_at_ms: lifetimeBought });
  await send(mod.revenueCatWebhookHandler, { type: 'CANCELLATION', app_user_id: USER, product_id: 'lifetime_gold', cancel_reason: 'CUSTOMER_SUPPORT', purchased_at_ms: lifetimeBought });
  assert.deepStrictEqual(profile(), { tier: 'gold', status: 'trialing', trialEnd: new Date(trialEnds).toISOString(), expires: new Date(trialEnds).toISOString() });
}));

test('App Store Gold past its expiry is settled for stripe.js only by asking RevenueCat, which knows about a billing grace period', withSecret(SECRET, async () => {
  const periodEnd = Date.now() - DAY;
  const lapsed = () => ({ ...freeRow(), subscription_tier: 'gold', subscription_status: 'active', subscription_expires_at: new Date(periodEnd).toISOString() });
  const profile = (rows) => ({ tier: rows[USER].subscription_tier, status: rows[USER].subscription_status, expires: rows[USER].subscription_expires_at });

  // Without the REST key, or without the web plan check, nothing is settled,
  // since the record can't tell a grace period from a plan that ended.
  for (const [label, key, webPlan] of [['no key', null, noWebPlan], ['no web plan check', REST_KEY, null]]) {
    const rows = { [USER]: lapsed() };
    const db = fakeSupabase(rows, { state: { [GRANT_KEY]: { purchasedAt: periodEnd - 30 * DAY, subscriptionUntil: periodEnd } } });
    const mod = loadHandler(db);
    if (webPlan) mod.setWebPlanCheck(webPlan);
    const api = revenueCatApi({});
    const before = global.fetch;
    global.fetch = api.fetch;
    try {
      await withEnv({ REVENUECAT_SECRET_KEY: key }, async () => {
        assert.strictEqual(await mod.settleExpiredStorePlan(USER), null, label);
      });
    } finally {
      global.fetch = before;
    }
    assert.deepStrictEqual(api.calls, [], label);
    assert.deepStrictEqual(db.writes, [], label);
  }

  // With both, RevenueCat answers. A grace period still running keeps Gold,
  // with the period's own end on the profile.
  const graceEnds = Date.now() + 10 * DAY;
  const inGrace = { entitlements: {}, subscriptions: { monthly: { expires_date: new Date(periodEnd).toISOString(), grace_period_expires_date: new Date(graceEnds).toISOString(), period_type: 'normal', refunded_at: null } }, non_subscriptions: {} };
  const rows = { [USER]: lapsed() };
  const db = fakeSupabase(rows);
  const mod = loadHandler(db);
  mod.setWebPlanCheck(noWebPlan);
  const api = revenueCatApi({ [USER]: inGrace });
  await withRevenueCatApi(api, async () => {
    const plan = await mod.settleExpiredStorePlan(USER);
    assert.strictEqual(plan.tier, 'gold');
    assert.strictEqual(plan.expiresAt, periodEnd);
  });
  assert.strictEqual(api.calls.length, 1);
  assert.deepStrictEqual(profile(rows), { tier: 'gold', status: 'active', expires: new Date(periodEnd).toISOString() });
  // Once RevenueCat holds nothing running for the account, it's free.
  await withRevenueCatApi(revenueCatApi({}), async () => {
    assert.strictEqual((await mod.settleExpiredStorePlan(USER)).tier, 'free');
  });
  assert.deepStrictEqual(profile(rows), { tier: 'free', status: null, expires: null });

  // An event another instance is still applying goes first.
  const held = fakeSupabase({ [USER]: lapsed() }, { state: { [`revenuecat_turn:${USER}`]: { until: new Date(Date.now() + 60 * 1000).toISOString(), owner: 'another-instance' } } });
  const heldMod = loadHandler(held);
  heldMod.setWebPlanCheck(noWebPlan);
  heldMod.accountTurn.waitMs = 200;
  await withRevenueCatApi(revenueCatApi({}), async () => {
    await assert.rejects(heldMod.settleExpiredStorePlan(USER), /still being applied/);
  });
  assert.deepStrictEqual(held.writes, []);
}));

test("the sync takes Lifetime from RevenueCat's entitlements, so a refunded or revoked lifetime purchase that's still listed doesn't come back", withSecret(SECRET, async () => {
  const bought = new Date(Date.now() - 20 * DAY).toISOString();
  const listed = { lifetime_gold: [{ id: 'p1', is_sandbox: false, purchase_date: bought, store: 'app_store' }] };
  const lifetimeEntitlement = (expires) => ({ Gold: { product_identifier: 'lifetime_gold', expires_date: expires, purchase_date: bought } });
  const cases = [
    ['a lifetime entitlement that stands', { entitlements: lifetimeEntitlement(null), subscriptions: {}, non_subscriptions: listed }, 'lifetime'],
    ['an entitlement named Lifetime', { entitlements: { Lifetime: { product_identifier: 'troystack_forever', expires_date: null, purchase_date: bought } }, subscriptions: {}, non_subscriptions: {} }, 'lifetime'],
    ['a refunded lifetime, its entitlement ended and the purchase still listed', { entitlements: lifetimeEntitlement(new Date(Date.now() - DAY).toISOString()), subscriptions: {}, non_subscriptions: listed }, 'free'],
    ['a family share that was revoked', { entitlements: {}, subscriptions: {}, non_subscriptions: listed }, 'free'],
    ['an unlisted sandbox lifetime', { entitlements: lifetimeEntitlement(null), subscriptions: {}, non_subscriptions: { lifetime_gold: [{ id: 'p2', is_sandbox: true, purchase_date: bought, store: 'app_store' }] } }, 'free'],
  ];
  for (const [label, subscriber, tier] of cases) {
    const rows = { [USER]: freeRow() };
    const db = fakeSupabase(rows, { users: { 'good-token': USER } });
    const mod = loadHandler(db);
    mod.setWebPlanCheck(noWebPlan);
    await withRevenueCatApi(revenueCatApi({ [USER]: subscriber }), async () => {
      assert.strictEqual((await syncAs(mod.revenueCatSyncHandler, 'good-token')).code, 200, label);
    });
    assert.strictEqual(rows[USER].subscription_tier, tier, label);
    assert.strictEqual(db.state[GRANT_KEY]?.lifetime, tier === 'lifetime' ? true : undefined, label);
  }
}));

test('the sync records any Gold product RevenueCat lists, expired or not, so the web knows the account had an App Store plan', withSecret(SECRET, async () => {
  const lapsedTrial = { entitlements: {}, subscriptions: { monthly: { expires_date: new Date(Date.now() - 60 * DAY).toISOString(), period_type: 'trial', purchase_date: new Date(Date.now() - 67 * DAY).toISOString(), refunded_at: null } }, non_subscriptions: {} };
  const rows = { [USER]: freeRow() };
  const db = fakeSupabase(rows, { users: { 'good-token': USER } });
  const mod = loadHandler(db);
  mod.setWebPlanCheck(noWebPlan);
  assert.strictEqual(await mod.hadAppStorePlan(USER), false);
  await withRevenueCatApi(revenueCatApi({ [USER]: lapsedTrial }), async () => {
    assert.strictEqual(await mod.revenueCatListsGold(USER), true, 'RevenueCat asked directly');
    assert.strictEqual(await mod.revenueCatListsGold(OTHER), false, 'nothing listed');
    assert.strictEqual((await syncAs(mod.revenueCatSyncHandler, 'good-token')).code, 200);
  });
  assert.strictEqual(rows[USER].subscription_tier, 'free');
  assert.strictEqual(db.state[GRANT_KEY].hadPlan, true);
  assert.strictEqual(await mod.hadAppStorePlan(USER), true, 'the record knows now');
  // Without the key there's nobody to ask.
  await withEnv({ REVENUECAT_SECRET_KEY: null }, async () => {
    assert.strictEqual(await mod.revenueCatListsGold(USER), null);
  });
}));

test("a billing grace period from the sync keeps the period's end on the profile, so the expiry when grace runs out still ends Gold", withSecret(SECRET, async () => {
  const periodEnd = Date.now() - 2 * DAY;
  const graceEnds = Date.now() + 14 * DAY;
  const purchasedAt = periodEnd - 30 * DAY;
  const inGrace = { entitlements: {}, subscriptions: { monthly: { expires_date: new Date(periodEnd).toISOString(), grace_period_expires_date: new Date(graceEnds).toISOString(), period_type: 'normal', purchase_date: new Date(purchasedAt).toISOString(), refunded_at: null } }, non_subscriptions: {} };
  const rows = { [USER]: { ...freeRow(), subscription_tier: 'gold', subscription_status: 'active', subscription_expires_at: new Date(periodEnd).toISOString() } };
  const db = fakeSupabase(rows, { users: { 'good-token': USER }, state: { [GRANT_KEY]: { purchasedAt, subscriptionUntil: periodEnd } } });
  const mod = loadHandler(db);
  mod.setWebPlanCheck(noWebPlan);
  await withRevenueCatApi(revenueCatApi({ [USER]: inGrace }), async () => {
    assert.strictEqual((await syncAs(mod.revenueCatSyncHandler, 'good-token')).body.tier, 'gold');
  });
  assert.strictEqual(rows[USER].subscription_tier, 'gold', 'Gold holds through the grace period');
  assert.strictEqual(rows[USER].subscription_expires_at, new Date(periodEnd).toISOString());
  assert.strictEqual(db.state[GRANT_KEY].subscriptionUntil, periodEnd);
  assert.strictEqual(db.state[GRANT_KEY].graceUntil, graceEnds);

  // Apple's retries fail, and the EXPIRATION when grace runs out names the period's end.
  const res = await send(mod.revenueCatWebhookHandler, { type: 'EXPIRATION', app_user_id: USER, product_id: 'monthly', purchased_at_ms: purchasedAt, expiration_at_ms: periodEnd });
  assert.strictEqual(res.code, 200);
  assert.notStrictEqual(res.body.skipped, 'superseded');
  assert.strictEqual(rows[USER].subscription_tier, 'free');
  assert.strictEqual(db.state[GRANT_KEY].subscriptionUntil, undefined);
  assert.strictEqual(db.state[GRANT_KEY].graceUntil, undefined);

  // If Apple's retry goes through instead, the renewal starts a new period with no grace period.
  const renewed = { [USER]: { ...freeRow(), subscription_tier: 'gold', subscription_status: 'active', subscription_expires_at: new Date(periodEnd).toISOString() } };
  const again = fakeSupabase(renewed, { users: { 'good-token': USER }, state: { [GRANT_KEY]: { purchasedAt, subscriptionUntil: periodEnd } } });
  const againMod = loadHandler(again);
  againMod.setWebPlanCheck(noWebPlan);
  await withRevenueCatApi(revenueCatApi({ [USER]: inGrace }), async () => {
    await syncAs(againMod.revenueCatSyncHandler, 'good-token');
  });
  await send(againMod.revenueCatWebhookHandler, { type: 'RENEWAL', app_user_id: USER, product_id: 'monthly', purchased_at_ms: Date.now() - 60 * 1000, expiration_at_ms: Date.now() + 30 * DAY });
  assert.strictEqual(again.state[GRANT_KEY].graceUntil, undefined);
  assert.strictEqual(renewed[USER].subscription_tier, 'gold');
}));
