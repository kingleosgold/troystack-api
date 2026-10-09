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
  function appState() {
    let key;
    const read = {
      select() { return read; },
      eq(col, v) { assert.strictEqual(col, 'key'); key = v; return read; },
      async maybeSingle() {
        if (opts.failStateRead) return { data: null, error: { message: 'connection reset' } };
        return { data: Object.hasOwn(state, key) ? { value: JSON.parse(JSON.stringify(state[key])) } : null, error: null };
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
    };
  }
  const db = {
    writes,
    state,
    stateWrites,
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
  assert.deepStrictEqual(rows[USER], { subscription_tier: 'lifetime', subscription_expires_at: null });
}));

test('a subscription purchase or renewal makes the profile gold until it expires', withSecret(SECRET, async () => {
  const rows = { [USER]: { subscription_tier: 'free', subscription_expires_at: null } };
  const { revenueCatWebhookHandler } = loadHandler(fakeSupabase(rows));
  const at = Date.now() + 30 * DAY;
  await send(revenueCatWebhookHandler, { type: 'INITIAL_PURCHASE', app_user_id: USER, product_id: 'stacktracker_gold_yearly', expiration_at_ms: at });
  assert.deepStrictEqual(rows[USER], { subscription_tier: 'gold', subscription_expires_at: new Date(at).toISOString() });
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
  assert.deepStrictEqual(rows[USER], { subscription_tier: 'gold', subscription_expires_at: new Date(at).toISOString() });

  const lifetime = await send(revenueCatWebhookHandler, { type: 'NON_RENEWING_PURCHASE', app_user_id: USER, product_id: 'lifetime_gold', environment: 'PRODUCTION' });
  assert.strictEqual(lifetime.code, 200);
  assert.deepStrictEqual(rows[USER], { subscription_tier: 'lifetime', subscription_expires_at: null });
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
  assert.deepStrictEqual(rows[USER], { subscription_tier: 'free', subscription_expires_at: null });
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
  assert.deepStrictEqual(rows[USER], { subscription_tier: 'free', subscription_expires_at: null, stripe_customer_id: null });
}));

test("a temporary grant during a store outage gives Gold for a day, then the real purchase or the expiry decides", withSecret(SECRET, async () => {
  const at = Date.UTC(2026, 9, 9, 12);
  const rows = { [USER]: { subscription_tier: 'free', subscription_status: null, subscription_expires_at: null, stripe_customer_id: null } };
  const { revenueCatWebhookHandler } = loadHandler(fakeSupabase(rows));
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
  // though it names the lifetime product.
  rows[USER] = { subscription_tier: 'free', subscription_status: null, subscription_expires_at: null, stripe_customer_id: null };
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
  assert.deepStrictEqual(db.state[GRANT_KEY], { purchasedAt: bought });

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
  assert.deepStrictEqual(db.state[GRANT_KEY], { purchasedAt: first });
  await send(revenueCatWebhookHandler, { type: 'RENEWAL', app_user_id: USER, product_id: 'monthly', purchased_at_ms: second, expiration_at_ms: second + 30 * DAY });
  assert.deepStrictEqual(db.state[GRANT_KEY], { purchasedAt: second });

  // The first purchase's event comes again on a retry.
  const res = await send(revenueCatWebhookHandler, { type: 'INITIAL_PURCHASE', app_user_id: USER, product_id: 'monthly', purchased_at_ms: first, expiration_at_ms: second });
  assert.strictEqual(res.code, 200);
  assert.deepStrictEqual(db.state[GRANT_KEY], { purchasedAt: second });

  // A grant without a purchase time leaves the record as it is.
  await send(revenueCatWebhookHandler, { type: 'UNCANCELLATION', app_user_id: USER, product_id: 'monthly', expiration_at_ms: second + 30 * DAY });
  assert.deepStrictEqual(db.stateWrites, [
    { key: GRANT_KEY, value: { purchasedAt: first } },
    { key: GRANT_KEY, value: { purchasedAt: second } },
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
    assert.deepStrictEqual(db.state[GRANT_KEY], { purchasedAt: at }, fail);
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
  assert.deepStrictEqual(db.state[GRANT_KEY], { purchasedAt: again, endedAt: bought });
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
  assert.deepStrictEqual(db.state[GRANT_KEY], { purchasedAt: bought });

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
  assert.deepStrictEqual(db.state[GRANT_KEY], { purchasedAt: later, endedAt: later });

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
  // A lifetime refund reads the record only to record its end, after the
  // profile write, so a read that fails there counts the same way.
  for (const [product, tier, fail] of [['monthly', 'gold', 'failStateWrite'], ['lifetime_gold', 'lifetime', 'failStateRead']]) {
    const rows = { [USER]: { ...freeRow(), subscription_tier: tier } };
    const opts = { [fail]: true, state: { [GRANT_KEY]: { purchasedAt: bought } } };
    const db = fakeSupabase(rows, opts);
    const { revenueCatWebhookHandler } = loadHandler(db);
    const refund = { type: 'CANCELLATION', app_user_id: USER, product_id: product, cancel_reason: 'CUSTOMER_SUPPORT', purchased_at_ms: bought };
    const res = await send(revenueCatWebhookHandler, refund);
    assert.strictEqual(res.code, 500, fail);
    assert.strictEqual(rows[USER].subscription_tier, 'free', `${fail}: the profile write came first`);
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
  assert.deepStrictEqual(db.state[GRANT_KEY], { purchasedAt: newer.purchased_at_ms });
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
    assert.deepStrictEqual(db.state[GRANT_KEY], { purchasedAt: newer }, `${event.type}: the newer purchase stays on record`);
  }
}));

test('a grant with the same purchase time as the record still applies', withSecret(SECRET, async () => {
  const renewed = Date.now() - DAY;
  const period = { app_user_id: USER, product_id: 'monthly', purchased_at_ms: renewed, expiration_at_ms: renewed + 30 * DAY };
  const rows = { [USER]: freeRow() };
  const db = fakeSupabase(rows);
  const { revenueCatWebhookHandler } = loadHandler(db);
  await send(revenueCatWebhookHandler, { ...period, type: 'RENEWAL' });
  assert.deepStrictEqual(db.state[GRANT_KEY], { purchasedAt: renewed });

  // Turning auto-renew back on, then Apple extending the same period.
  const uncancel = await send(revenueCatWebhookHandler, { ...period, type: 'UNCANCELLATION' });
  assert.strictEqual(uncancel.body.tier, 'gold');
  const extended = await send(revenueCatWebhookHandler, { ...period, type: 'SUBSCRIPTION_EXTENDED', expiration_at_ms: renewed + 37 * DAY });
  assert.strictEqual(extended.body.tier, 'gold');
  assert.strictEqual(rows[USER].subscription_expires_at, new Date(renewed + 37 * DAY).toISOString());
}));
