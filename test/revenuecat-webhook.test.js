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

/** Profiles keyed by id, with switches that make reads or writes fail. */
function fakeSupabase(rows, opts = {}) {
  const writes = [];
  const db = {
    writes,
    from(table) {
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
  const at = Date.UTC(2026, 10, 9);
  await send(revenueCatWebhookHandler, { type: 'INITIAL_PURCHASE', app_user_id: USER, product_id: 'stacktracker_gold_yearly', expiration_at_ms: at });
  assert.deepStrictEqual(rows[USER], { subscription_tier: 'gold', subscription_expires_at: new Date(at).toISOString() });
  const later = at + 365 * 864e5;
  await send(revenueCatWebhookHandler, { type: 'RENEWAL', app_user_id: USER, product_id: 'stacktracker_gold_yearly', expiration_at_ms: later });
  assert.strictEqual(rows[USER].subscription_expires_at, new Date(later).toISOString());
}));

test('a sandbox purchase counts, since App Review buys in the sandbox', withSecret(SECRET, async () => {
  const rows = { [USER]: { subscription_tier: 'free', subscription_expires_at: null } };
  const { revenueCatWebhookHandler } = loadHandler(fakeSupabase(rows));
  await send(revenueCatWebhookHandler, { type: 'INITIAL_PURCHASE', app_user_id: USER, product_id: 'stacktracker_gold_monthly', environment: 'SANDBOX', expiration_at_ms: Date.UTC(2026, 10, 9) });
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
  await send(revenueCatWebhookHandler, { type: 'RENEWAL', app_user_id: USER, product_id: 'stacktracker_gold_monthly', expiration_at_ms: Date.UTC(2026, 10, 9) });
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

test('an event for an account with no profile is skipped', withSecret(SECRET, async () => {
  const db = fakeSupabase({});
  const { revenueCatWebhookHandler } = loadHandler(db);
  const res = await send(revenueCatWebhookHandler, { type: 'NON_RENEWING_PURCHASE', app_user_id: USER, product_id: 'stacktracker_lifetime' });
  assert.strictEqual(res.code, 200);
  assert.strictEqual(res.body.skipped, 'no_profile');
  assert.deepStrictEqual(db.writes, []);
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

test('an account that never reached web checkout goes free without asking Stripe', withSecret(SECRET, async () => {
  const rows = { [USER]: { subscription_tier: 'gold', subscription_expires_at: null, stripe_customer_id: null } };
  const mod = loadHandler(fakeSupabase(rows));
  let asked = 0;
  mod.setWebPlanCheck(async () => { asked += 1; return { tier: 'gold' }; });
  await send(mod.revenueCatWebhookHandler, { type: 'EXPIRATION', app_user_id: USER, product_id: 'stacktracker_gold_monthly' });
  assert.strictEqual(asked, 0);
  assert.strictEqual(rows[USER].subscription_tier, 'free');
  mod.setWebPlanCheck(async () => ({ tier: 'free', status: null, trialEnd: null }));
  rows[USER] = { subscription_tier: 'gold', subscription_expires_at: null, stripe_customer_id: 'cus_web' };
  await send(mod.revenueCatWebhookHandler, { type: 'EXPIRATION', app_user_id: USER, product_id: 'stacktracker_gold_monthly' });
  assert.strictEqual(rows[USER].subscription_tier, 'free', 'nothing in Stripe either');
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
