// GET /v1/sync-subscription puts a web plan back when the iPhone app has
// written free over it. Supabase and Stripe are stand-ins here, so these
// tests run without credentials or network.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const USER = '7b1c6c1e-1111-4a2b-9c3d-000000000001';

// What the stand-ins answer, changed per test.
const state = {
  profile: null,
  updateError: null,
  updates: [],
  subscriptions: [],
  sessions: [],
  charge: null,
  charges: {},
  profileError: null,
  stripeCalls: [],
};

function reset(over = {}) {
  Object.assign(state, {
    profile: { subscription_tier: 'free', subscription_status: null, stripe_customer_id: 'cus_1' },
    updateError: null,
    updates: [],
    subscriptions: [],
    sessions: [],
    charge: null,
    charges: {},
    profileError: null,
    stripeCalls: [],
    created: undefined,
    priceFails: false,
    subscriptionById: {},
    sessionToVerify: null,
  }, over);
  router.resetGoldProductCache();
}

const fakeSupabase = {
  auth: {
    getUser: async (token) => (token === 'good-token' ? { data: { user: { id: USER } }, error: null } : { data: { user: null }, error: { message: 'invalid JWT' } }),
  },
  from() {
    return {
      select() {
        return {
          eq: () => ({
            single: async () => {
              if (state.profileError) return { data: null, error: state.profileError };
              return state.profile ? { data: state.profile, error: null } : { data: null, error: { code: 'PGRST116', message: 'no rows' } };
            },
          }),
        };
      },
      update(values) {
        return {
          eq: async () => {
            state.updates.push(values);
            return { error: state.updateError };
          },
        };
      },
    };
  },
};

const fakeStripe = {
  subscriptions: {
    list: async () => {
      state.stripeCalls.push('subscriptions.list');
      return { data: state.subscriptions };
    },
  },
  checkout: {
    sessions: {
      // Newest first, filtered by status and paged by starting_after, like Stripe.
      list: async (params = {}) => {
        state.stripeCalls.push('checkout.sessions.list');
        let rows = state.sessions.filter((x) => !params.status || x.status === params.status);
        if (params.starting_after) rows = rows.slice(rows.findIndex((x) => x.id === params.starting_after) + 1);
        const page = rows.slice(0, params.limit || 10);
        return { data: page, has_more: rows.length > page.length };
      },
    },
  },
  paymentIntents: {
    retrieve: async (id) => {
      state.stripeCalls.push('paymentIntents.retrieve');
      return { latest_charge: id in state.charges ? state.charges[id] : state.charge };
    },
  },
  prices: {
    // The Gold prices sit on one product. Anything named other is elsewhere,
    // and anything named once is a one-time price.
    retrieve: async (id) => {
      state.stripeCalls.push('prices.retrieve');
      if (id === 'price_missing') throw new Error('No such price');
      if (state.priceFails) throw new Error('Stripe is having a moment');
      return { id, product: id.includes('other') ? 'prod_other' : 'prod_gold', type: id.includes('once') ? 'one_time' : 'recurring' };
    },
  },
  webhooks: {
    constructEvent: (body) => JSON.parse(Buffer.isBuffer(body) ? body.toString('utf8') : body),
  },
};
fakeStripe.subscriptions.retrieve = async (id) => {
  state.stripeCalls.push('subscriptions.retrieve');
  return state.subscriptionById[id];
};
fakeStripe.checkout.sessions.retrieve = async () => {
  state.stripeCalls.push('checkout.sessions.retrieve');
  return state.sessionToVerify;
};
fakeStripe.checkout.sessions.create = async (params) => {
  state.stripeCalls.push('checkout.sessions.create');
  state.created = params;
  return { url: 'https://checkout.stripe.com/c/pay/test' };
};

// Load the router with the stand-ins in place of the real clients.
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'test-placeholder';
process.env.STRIPE_GOLD_MONTHLY_PRICE_ID = 'price_gold_monthly';
process.env.STRIPE_GOLD_YEARLY_PRICE_ID = 'price_gold_yearly';
process.env.STRIPE_GOLD_LIFETIME_PRICE_ID = 'price_gold_lifetime';
require.cache[require.resolve(path.join(__dirname, '../src/lib/supabase'))] = { exports: fakeSupabase };
require.cache[require.resolve('stripe')] = { exports: () => fakeStripe };
const router = require('../src/routes/stripe');
const routeHandler = (p) => router.stack.find((l) => l.route && l.route.path === p).route.stack[0].handle;
const handler = routeHandler('/sync-subscription');
const myPlan = routeHandler('/my-plan');
const createCheckout = routeHandler('/create-checkout-session');
const verifySession = routeHandler('/verify-session');

function fakeRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

async function sync() {
  const res = fakeRes();
  await handler({ query: { user_id: USER } }, res);
  return res;
}

async function askMyPlan(token) {
  const res = fakeRes();
  await myPlan({ headers: token ? { authorization: `Bearer ${token}` } : {} }, res);
  return res;
}

test('a free profile with a live Stripe trial gets Gold back', async () => {
  reset({ subscriptions: [{ status: 'canceled' }, { status: 'trialing', trial_end: 1760000000, items: { data: [{ price: { id: 'price_gold_yearly', product: 'prod_gold' } }] } }] });
  const res = await sync();
  assert.equal(res.body.subscription_tier, 'gold');
  assert.equal(res.body.subscription_status, 'trialing');
  assert.equal(state.updates.length, 1);
  assert.equal(state.updates[0].subscription_tier, 'gold');
  assert.equal(state.updates[0].trial_end, new Date(1760000000 * 1000).toISOString());
});

test('a paid lifetime purchase is restored, since it has no subscription', async () => {
  reset({
    sessions: [{ mode: 'payment', status: 'complete', payment_status: 'paid', metadata: { tier: 'lifetime' }, payment_intent: 'pi_1' }],
    charge: { refunded: false },
  });
  const res = await sync();
  assert.equal(res.body.subscription_tier, 'lifetime');
  assert.deepEqual(state.updates, [{ subscription_tier: 'lifetime', subscription_status: 'active', trial_end: null }]);
});

test('a lifetime purchase refunded in full stays free', async () => {
  reset({
    sessions: [{ mode: 'payment', status: 'complete', payment_status: 'paid', metadata: { tier: 'lifetime' }, payment_intent: 'pi_1' }],
    charge: { refunded: true },
  });
  const res = await sync();
  assert.equal(res.body.subscription_tier, 'free');
  assert.equal(state.updates.length, 0);
});

test('when the profile update fails, the answer stays what the profile says', async () => {
  reset({ subscriptions: [{ status: 'active', items: { data: [{ price: { id: 'price_gold_monthly', product: 'prod_gold' } }] } }], updateError: { message: 'permission denied' } });
  const res = await sync();
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.subscription_tier, 'free');
  assert.equal(res.body.subscription_status, null);
});

test('a profile that already has a plan never asks Stripe', async () => {
  reset({ profile: { subscription_tier: 'gold', subscription_status: 'active', stripe_customer_id: 'cus_1' } });
  const res = await sync();
  assert.equal(res.body.subscription_tier, 'gold');
  assert.deepEqual(state.stripeCalls, []);
});

test('nothing paid in Stripe leaves a free profile alone', async () => {
  reset({ subscriptions: [{ status: 'canceled' }], sessions: [{ mode: 'payment', status: 'expired', payment_status: 'unpaid' }] });
  const res = await sync();
  assert.equal(res.body.subscription_tier, 'free');
  assert.equal(state.updates.length, 0);
});

test('the app learns a web trial from Stripe, whatever the profile says', async () => {
  reset({
    profile: { subscription_tier: 'gold', subscription_status: 'active', stripe_customer_id: 'cus_1' },
    subscriptions: [{ status: 'trialing', trial_end: 1760000000, items: { data: [{ price: { id: 'price_gold_monthly', product: 'prod_gold' } }] } }],
  });
  const res = await askMyPlan('good-token');
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { plan: 'gold', status: 'trialing', trial_end: new Date(1760000000 * 1000).toISOString() });
  assert.equal(state.updates.length, 0, 'asking never writes');
});

test('a gold profile with nothing in Stripe has no web plan', async () => {
  reset({ profile: { subscription_tier: 'gold', subscription_status: 'active', stripe_customer_id: 'cus_1' } });
  const res = await askMyPlan('good-token');
  assert.deepEqual(res.body, { plan: null, status: null, trial_end: null });
});

test('an account that never went to web checkout has no web plan and Stripe is not asked', async () => {
  reset({ profile: { subscription_tier: 'free', subscription_status: null, stripe_customer_id: null } });
  const res = await askMyPlan('good-token');
  assert.deepEqual(res.body, { plan: null, status: null, trial_end: null });
  assert.deepEqual(state.stripeCalls, []);
});

test('my-plan needs the account to be signed in', async () => {
  reset();
  assert.equal((await askMyPlan(null)).statusCode, 401);
  assert.equal((await askMyPlan('bad-token')).statusCode, 401);
  assert.deepEqual(state.stripeCalls, []);
});

test('lifetime wins over a live subscription the customer also has', async () => {
  reset({
    subscriptions: [{ status: 'active', items: { data: [{ price: { id: 'price_gold_monthly', product: 'prod_gold' } }] } }],
    sessions: [{ mode: 'payment', status: 'complete', payment_status: 'paid', metadata: { tier: 'lifetime' }, payment_intent: 'pi_1' }],
    charges: { pi_1: { refunded: false } },
  });
  const res = await sync();
  assert.equal(res.body.subscription_tier, 'lifetime');
});

test('a refunded duplicate lifetime purchase does not hide the one still paid', async () => {
  reset({
    sessions: [
      { mode: 'payment', status: 'complete', payment_status: 'paid', metadata: { tier: 'lifetime' }, payment_intent: 'pi_dup' },
      { mode: 'payment', status: 'complete', payment_status: 'paid', metadata: { tier: 'lifetime' }, payment_intent: 'pi_first' },
    ],
    charges: { pi_dup: { refunded: true }, pi_first: { refunded: false } },
  });
  const res = await sync();
  assert.equal(res.body.subscription_tier, 'lifetime');
});

test('a subscriber on an older Gold price is restored, one on another product is not', async () => {
  reset({ subscriptions: [{ status: 'active', items: { data: [{ price: { id: 'price_2025_monthly', product: 'prod_gold' } }] } }] });
  assert.equal((await sync()).body.subscription_tier, 'gold');
  reset({ subscriptions: [{ status: 'active', items: { data: [{ price: { id: 'price_other', product: 'prod_other' } }] } }] });
  const res = await sync();
  assert.equal(res.body.subscription_tier, 'free');
  assert.equal(state.updates.length, 0);
});

test('my-plan says it could not check when the profile lookup fails', async () => {
  reset({ profileError: { code: '08006', message: 'connection failure' } });
  const res = await askMyPlan('good-token');
  assert.equal(res.statusCode, 503);
  assert.deepEqual(state.stripeCalls, []);
});

test('my-plan answers no web plan when there is no profile row', async () => {
  reset({ profile: null });
  const res = await askMyPlan('good-token');
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { plan: null, status: null, trial_end: null });
});

async function checkout(priceId) {
  const res = fakeRes();
  await createCheckout(
    { headers: { authorization: 'Bearer good-token' }, body: { user_id: USER, price_id: priceId, success_url: 'https://troystack.ai/settings?session_id={CHECKOUT_SESSION_ID}' } },
    res,
  );
  return res;
}

test('checkout sells Gold prices and turns away anything else', async () => {
  reset({ profile: { email: 'a@example.com', stripe_customer_id: 'cus_1' } });
  const ok = await checkout('price_gold_yearly');
  assert.equal(ok.statusCode, 200);
  assert.equal(state.created.mode, 'subscription');
  assert.equal(state.created.subscription_data.trial_period_days, 7);

  reset({ profile: { email: 'a@example.com', stripe_customer_id: 'cus_1' } });
  const other = await checkout('price_other_monthly');
  assert.equal(other.statusCode, 400);
  assert.equal(state.created, undefined);

  reset({ profile: { email: 'a@example.com', stripe_customer_id: 'cus_1' } });
  assert.equal((await checkout('price_missing')).statusCode, 400);
});

test('when a Gold price cannot be read, my-plan says it could not check', async () => {
  reset({
    profile: { subscription_tier: 'free', subscription_status: null, stripe_customer_id: 'cus_1' },
    subscriptions: [{ status: 'active', items: { data: [{ price: { id: 'price_2025_monthly', product: 'prod_gold' } }] } }],
    priceFails: true,
  });
  const res = await askMyPlan('good-token');
  assert.equal(res.statusCode, 500);
  // and the repair leaves the profile alone rather than answering from half a list
  const synced = await sync();
  assert.equal(synced.body.subscription_tier, 'free');
  assert.equal(state.updates.length, 0);
});

test('checkout sells another Gold-product price as Gold, or as lifetime when it is one-time', async () => {
  reset({ profile: { email: 'a@example.com', stripe_customer_id: 'cus_1' } });
  const promo = await checkout('price_gold_promo');
  assert.equal(promo.statusCode, 200);
  assert.equal(state.created.mode, 'subscription');
  assert.equal(state.created.metadata.tier, 'gold');

  reset({ profile: { email: 'a@example.com', stripe_customer_id: 'cus_1' } });
  const once = await checkout('price_gold_once_promo');
  assert.equal(once.statusCode, 200);
  assert.equal(state.created.mode, 'payment');
  assert.equal(state.created.metadata.tier, 'lifetime');
  assert.equal(state.created.subscription_data, undefined);
});

test('the checkout webhook records a Gold-product price as Gold', async () => {
  reset({
    subscriptionById: { sub_1: { status: 'trialing', trial_end: 1760000000, items: { data: [{ price: { id: 'price_gold_promo', product: 'prod_gold' } }] } } },
  });
  const event = {
    type: 'checkout.session.completed',
    data: { object: { client_reference_id: USER, subscription: 'sub_1', customer: 'cus_1', metadata: { user_id: USER, tier: 'gold' } } },
  };
  const res = fakeRes();
  res.send = function send(body) {
    this.body = body;
    return this;
  };
  await router.stripeWebhookHandler({ headers: { 'stripe-signature': 'sig' }, body: Buffer.from(JSON.stringify(event)) }, res);
  assert.equal(state.updates.length, 1);
  assert.equal(state.updates[0].subscription_tier, 'gold');
  assert.equal(state.updates[0].subscription_status, 'trialing');
});

test('verify-session records a Gold-product price as Gold and anything else as free', async () => {
  reset({
    sessionToVerify: {
      client_reference_id: USER,
      customer: 'cus_1',
      payment_status: 'no_payment_required',
      metadata: { user_id: USER, tier: 'gold' },
      subscription: { status: 'trialing', trial_end: 1760000000, items: { data: [{ price: { id: 'price_gold_promo', product: 'prod_gold' } }] } },
    },
  });
  let res = fakeRes();
  await verifySession({ body: { session_id: 'cs_1' } }, res);
  assert.equal(res.body.tier, 'gold');
  assert.equal(state.updates[0].subscription_tier, 'gold');

  reset({
    sessionToVerify: {
      client_reference_id: USER,
      customer: 'cus_1',
      payment_status: 'no_payment_required',
      metadata: { user_id: USER, tier: 'gold' },
      subscription: { status: 'active', items: { data: [{ price: { id: 'price_other', product: 'prod_other' } }] } },
    },
  });
  res = fakeRes();
  await verifySession({ body: { session_id: 'cs_2' } }, res);
  assert.equal(res.body.tier, 'free');
});

test('a lifetime purchase behind a hundred newer checkouts is still found', async () => {
  const newer = Array.from({ length: 150 }, (_, i) => ({ id: `cs_sub_${i}`, mode: 'subscription', status: 'complete', payment_status: 'paid' }));
  reset({
    sessions: [
      ...newer,
      { id: 'cs_abandoned', mode: 'payment', status: 'expired', payment_status: 'unpaid' },
      { id: 'cs_life', mode: 'payment', status: 'complete', payment_status: 'paid', metadata: { tier: 'lifetime' }, payment_intent: 'pi_life' },
    ],
    charges: { pi_life: { refunded: false } },
  });
  const res = await sync();
  assert.equal(res.body.subscription_tier, 'lifetime');
  assert.equal(state.stripeCalls.filter((c) => c === 'checkout.sessions.list').length, 2, 'two pages of a hundred');
});

function webhookRes() {
  const res = fakeRes();
  res.send = function send(body) {
    this.body = body;
    return this;
  };
  return res;
}

function checkoutEvent(metadata) {
  return {
    type: 'checkout.session.completed',
    data: { object: { client_reference_id: USER, subscription: 'sub_1', customer: 'cus_1', metadata } },
  };
}

test("when the Gold product can't be read, a completed checkout keeps the tier this API gave it", async () => {
  reset({
    priceFails: true,
    subscriptionById: { sub_1: { status: 'trialing', trial_end: 1760000000, items: { data: [{ price: { id: 'price_gold_promo', product: 'prod_gold' } }] } } },
  });
  const res = webhookRes();
  await router.stripeWebhookHandler({ headers: { 'stripe-signature': 'sig' }, body: Buffer.from(JSON.stringify(checkoutEvent({ user_id: USER, tier: 'gold' }))) }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(state.updates[0].subscription_tier, 'gold');
  assert.equal(state.updates[0].subscription_status, 'trialing');
});

test("without a recorded tier, an unreadable Gold product fails the webhook so Stripe sends it again", async () => {
  reset({
    priceFails: true,
    subscriptionById: { sub_1: { status: 'active', items: { data: [{ price: { id: 'price_gold_promo', product: 'prod_gold' } }] } } },
  });
  const res = webhookRes();
  await router.stripeWebhookHandler({ headers: { 'stripe-signature': 'sig' }, body: Buffer.from(JSON.stringify(checkoutEvent({ user_id: USER }))) }, res);
  assert.equal(res.statusCode, 500);
  assert.equal(state.updates.length, 0, 'free is never saved for it');
});

test("verify-session keeps the session's tier when the Gold product can't be read", async () => {
  reset({
    priceFails: true,
    sessionToVerify: {
      client_reference_id: USER,
      customer: 'cus_1',
      payment_status: 'no_payment_required',
      metadata: { user_id: USER, tier: 'gold' },
      subscription: { status: 'trialing', trial_end: 1760000000, items: { data: [{ price: { id: 'price_gold_promo', product: 'prod_gold' } }] } },
    },
  });
  const res = fakeRes();
  await verifySession({ body: { session_id: 'cs_1' } }, res);
  assert.equal(res.body.tier, 'gold');
  assert.equal(state.updates[0].subscription_tier, 'gold');
});
