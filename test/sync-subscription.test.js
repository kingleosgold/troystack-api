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
    lineItems: {},
    disputes: {},
    customers: [],
    customerById: {},
    searchFails: false,
    upserts: [],
    expired: [],
  }, over);
  router.resetGoldProductCache();
  router.resetCustomerSearchCache();
}

const fakeSupabase = {
  auth: {
    getUser: async (token) => (token === 'good-token' ? { data: { user: { id: USER } }, error: null } : { data: { user: null }, error: { message: 'invalid JWT' } }),
    admin: {
      getUserById: async (id) => ({ data: { user: { id, email: 'a@example.com' } }, error: null }),
    },
  },
  from() {
    return {
      select() {
        return {
          // The one profile matches a filter unless it holds a different value.
          eq: (col, val) => ({
            single: async () => {
              if (state.profileError) return { data: null, error: state.profileError };
              const p = state.profile;
              const matches = p && (p[col] === undefined || p[col] === val);
              return matches ? { data: p, error: null } : { data: null, error: { code: 'PGRST116', message: 'no rows' } };
            },
            // The RevenueCat webhook reads with maybeSingle: no row is null data.
            maybeSingle: async () => {
              if (state.profileError) return { data: null, error: state.profileError };
              const p = state.profile;
              const matches = p && (p[col] === undefined || p[col] === val);
              return { data: matches ? p : null, error: null };
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
      upsert: async (values) => {
        state.upserts.push(values);
        return { error: null };
      },
    };
  },
};

const fakeStripe = {
  subscriptions: {
    // Newest first and paged by starting_after, like Stripe.
    list: async (params = {}) => {
      state.stripeCalls.push('subscriptions.list');
      let rows = state.subscriptions.filter((x) => !x.customer || !params.customer || x.customer === params.customer);
      if (params.starting_after) rows = rows.slice(rows.findIndex((x) => x.id === params.starting_after) + 1);
      const page = rows.slice(0, params.limit || 10);
      return { data: page, has_more: rows.length > page.length };
    },
  },
  checkout: {
    sessions: {
      // Newest first, filtered by status and paged by starting_after, like Stripe.
      list: async (params = {}) => {
        state.stripeCalls.push('checkout.sessions.list');
        let rows = state.sessions.filter((x) => (!params.status || x.status === params.status) && (!x.customer || !params.customer || x.customer === params.customer));
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
  disputes: {
    list: async (params = {}) => {
      state.stripeCalls.push('disputes.list');
      return { data: state.disputes[params.payment_intent] || [], has_more: false };
    },
  },
  customers: {
    create: async (params) => {
      state.stripeCalls.push('customers.create');
      state.createdCustomer = params;
      return { id: 'cus_new' };
    },
    // Customers made for an account, found by the user id in their metadata.
    search: async (params = {}) => {
      state.stripeCalls.push('customers.search');
      if (state.searchFails) throw new Error('search is unavailable');
      const m = /supabase_user_id'\]:'([^']+)'/.exec(params.query || '');
      const data = state.customers.filter((c) => c.metadata?.supabase_user_id === (m && m[1]));
      return { data, has_more: false, next_page: null };
    },
    retrieve: async (id) => {
      state.stripeCalls.push('customers.retrieve');
      return state.customerById[id] || { id, metadata: {} };
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
fakeStripe.checkout.sessions.listLineItems = async (id) => {
  state.stripeCalls.push('checkout.sessions.listLineItems');
  return { data: state.lineItems[id] || [], has_more: false };
};
fakeStripe.billingPortal = {
  sessions: {
    create: async (params) => {
      state.stripeCalls.push('billingPortal.sessions.create');
      state.portal = params;
      return { url: 'https://billing.stripe.com/p/session/test' };
    },
  },
};
fakeStripe.checkout.sessions.expire = async (id) => {
  state.stripeCalls.push('checkout.sessions.expire');
  state.expired.push(id);
  return { id, status: 'expired' };
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

test('an account that never went to web checkout has no web plan, and Stripe is searched once in ten minutes', async () => {
  reset({ profile: { subscription_tier: 'free', subscription_status: null, stripe_customer_id: null } });
  let res = await askMyPlan('good-token');
  assert.deepEqual(res.body, { plan: null, status: null, trial_end: null });
  assert.deepEqual(state.stripeCalls, ['customers.search']);
  res = await askMyPlan('good-token');
  assert.deepEqual(res.body, { plan: null, status: null, trial_end: null });
  assert.deepEqual(state.stripeCalls, ['customers.search'], 'the empty search is kept');
});

test("a paid web plan is found even when its customer id never reached the profile", async () => {
  const lost = {
    profile: { subscription_tier: 'free', subscription_status: null, stripe_customer_id: null },
    customers: [{ id: 'cus_lost', metadata: { supabase_user_id: USER } }],
    subscriptions: [{ id: 'sub_lost', customer: 'cus_lost', status: 'active', items: { data: [{ price: { id: 'price_gold_monthly', product: 'prod_gold' } }] } }],
  };
  reset(lost);
  const res = await askMyPlan('good-token');
  assert.equal(res.body.plan, 'gold');
  assert.equal(state.updates.length, 0, 'asking never writes');

  reset(lost);
  const synced = await sync();
  assert.equal(synced.body.subscription_tier, 'gold');
  assert.equal(state.updates[0].stripe_customer_id, 'cus_lost', 'the profile gets its customer back');
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

async function checkout(priceId, campaign) {
  const res = fakeRes();
  await createCheckout(
    { headers: { authorization: 'Bearer good-token' }, body: { user_id: USER, price_id: priceId, success_url: 'https://troystack.ai/settings?session_id={CHECKOUT_SESSION_ID}', ...(campaign ? { campaign } : {}) } },
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

test('checkout sells another recurring Gold-product price as Gold, and lifetime only at its own price', async () => {
  reset({ profile: { email: 'a@example.com', stripe_customer_id: 'cus_1' } });
  const promo = await checkout('price_gold_promo');
  assert.equal(promo.statusCode, 200);
  assert.equal(state.created.mode, 'subscription');
  assert.equal(state.created.metadata.tier, 'gold');

  reset({ profile: { email: 'a@example.com', stripe_customer_id: 'cus_1' } });
  const once = await checkout('price_gold_once_promo');
  assert.equal(once.statusCode, 400, 'a one-time Gold price that is not the lifetime price');
  assert.equal(state.created, undefined);

  reset({ profile: { email: 'a@example.com', stripe_customer_id: 'cus_1' } });
  const life = await checkout('price_gold_lifetime');
  assert.equal(life.statusCode, 200);
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
  assert.equal(res.body.status, 'trialing', 'the page reads this to say whether a free week started');
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

const oneTime = (id, product) => [{ price: { id, product, type: 'one_time' } }];
const untracked = (id) => ({ id, mode: 'payment', status: 'complete', payment_status: 'paid', metadata: {}, payment_intent: `pi_${id}` });

test('a one-time payment for something else in the account is never read as lifetime', async () => {
  reset({ sessions: [untracked('cs_mug')], lineItems: { cs_mug: oneTime('price_mug', 'prod_other') }, charge: { refunded: false } });
  const res = await sync();
  assert.equal(res.body.subscription_tier, 'free');
  assert.equal(state.updates.length, 0);
  assert.deepEqual((await askMyPlan('good-token')).body, { plan: null, status: null, trial_end: null });
});

test('an older checkout with no recorded tier counts when it sold a lifetime Gold price', async () => {
  reset({ sessions: [untracked('cs_old')], lineItems: { cs_old: oneTime('price_gold_lifetime', 'prod_gold') }, charge: { refunded: false } });
  assert.equal((await sync()).body.subscription_tier, 'lifetime');
  assert.ok(!state.stripeCalls.includes('prices.retrieve'), 'the configured lifetime price needs no product read');

  reset({ sessions: [untracked('cs_old')], lineItems: { cs_old: oneTime('price_gold_once_2025', 'prod_gold') }, charge: { refunded: false } });
  assert.equal((await sync()).body.subscription_tier, 'lifetime');
});

test('a live Gold subscription behind a hundred and more ended ones is still found', async () => {
  const ended = Array.from({ length: 150 }, (_, i) => ({ id: `sub_old_${i}`, status: 'canceled' }));
  reset({ subscriptions: [...ended, { id: 'sub_live', status: 'active', items: { data: [{ price: { id: 'price_gold_monthly', product: 'prod_gold' } }] } }] });
  const res = await askMyPlan('good-token');
  assert.equal(res.body.plan, 'gold');
  assert.equal(state.stripeCalls.filter((c) => c === 'subscriptions.list').length, 2, 'two pages of a hundred');
});

test('a history longer than the check reads is not taken as no plan', async () => {
  const ended = Array.from({ length: 1001 }, (_, i) => ({ id: `sub_old_${i}`, status: 'canceled' }));
  reset({ subscriptions: ended });
  const res = await askMyPlan('good-token');
  assert.equal(res.statusCode, 500);
  const synced = await sync();
  assert.equal(synced.body.subscription_tier, 'free');
  assert.equal(state.updates.length, 0);
});

test('the webhook leaves the profile alone for a one-time checkout that sold no Gold plan', async () => {
  reset({ lineItems: { cs_mug: oneTime('price_mug', 'prod_other') } });
  const event = { type: 'checkout.session.completed', data: { object: { id: 'cs_mug', client_reference_id: USER, customer: 'cus_1', mode: 'payment', payment_status: 'paid', metadata: { user_id: USER } } } };
  let res = webhookRes();
  await router.stripeWebhookHandler({ headers: { 'stripe-signature': 'sig' }, body: Buffer.from(JSON.stringify(event)) }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(state.updates.length, 0);

  reset({ lineItems: { cs_life: oneTime('price_gold_lifetime', 'prod_gold') } });
  event.data.object.id = 'cs_life';
  res = webhookRes();
  await router.stripeWebhookHandler({ headers: { 'stripe-signature': 'sig' }, body: Buffer.from(JSON.stringify(event)) }, res);
  assert.equal(state.updates[0].subscription_tier, 'lifetime');
});

const lifetimeSession = (pi) => ({ id: `cs_${pi}`, mode: 'payment', status: 'complete', payment_status: 'paid', metadata: { tier: 'lifetime' }, payment_intent: pi });

test('a lifetime purchase lost in a dispute is not restored, one the seller won still is', async () => {
  reset({ sessions: [lifetimeSession('pi_1')], charges: { pi_1: { refunded: false, disputed: true } }, disputes: { pi_1: [{ status: 'lost' }] } });
  assert.equal((await sync()).body.subscription_tier, 'free');
  assert.equal(state.updates.length, 0);
  assert.deepEqual((await askMyPlan('good-token')).body, { plan: null, status: null, trial_end: null });

  reset({ sessions: [lifetimeSession('pi_1')], charges: { pi_1: { refunded: false, disputed: true } }, disputes: { pi_1: [{ status: 'won' }] } });
  assert.equal((await sync()).body.subscription_tier, 'lifetime');
});

test('verify-session never brings back a refunded lifetime or an ended subscription', async () => {
  reset({
    charges: { pi_r: { refunded: true } },
    sessionToVerify: { client_reference_id: USER, customer: 'cus_1', mode: 'payment', payment_status: 'paid', metadata: { user_id: USER, tier: 'lifetime' }, payment_intent: 'pi_r' },
  });
  let res = fakeRes();
  await verifySession({ body: { session_id: 'cs_old' } }, res);
  assert.equal(res.body.success, false);
  assert.equal(state.updates.length, 0);

  reset({
    sessionToVerify: {
      client_reference_id: USER,
      customer: 'cus_1',
      payment_status: 'paid',
      metadata: { user_id: USER, tier: 'gold' },
      subscription: { status: 'canceled', items: { data: [{ price: { id: 'price_gold_monthly', product: 'prod_gold' } }] } },
    },
  });
  res = fakeRes();
  await verifySession({ body: { session_id: 'cs_old' } }, res);
  assert.equal(res.body.success, false);
  assert.equal(state.updates.length, 0);
});

test('a late checkout event for a subscription that already ended records only the customer', async () => {
  reset({ subscriptionById: { sub_1: { status: 'canceled', items: { data: [{ price: { id: 'price_gold_monthly', product: 'prod_gold' } }] } } } });
  const res = webhookRes();
  await router.stripeWebhookHandler({ headers: { 'stripe-signature': 'sig' }, body: Buffer.from(JSON.stringify(checkoutEvent({ user_id: USER, tier: 'gold' }))) }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(state.updates, [{ stripe_customer_id: 'cus_1' }]);
});

test('a profile write that fails makes the webhook answer 500, so Stripe sends it again', async () => {
  reset({
    updateError: { message: 'connection reset' },
    subscriptionById: { sub_1: { status: 'trialing', trial_end: 1760000000, items: { data: [{ price: { id: 'price_gold_monthly', product: 'prod_gold' } }] } } },
  });
  const res = webhookRes();
  await router.stripeWebhookHandler({ headers: { 'stripe-signature': 'sig' }, body: Buffer.from(JSON.stringify(checkoutEvent({ user_id: USER, tier: 'gold' }))) }, res);
  assert.equal(res.statusCode, 500);
});

test('a lifetime profile stays lifetime when a later checkout adds Gold', async () => {
  reset({
    profile: { id: USER, subscription_tier: 'lifetime', subscription_status: 'active', stripe_customer_id: 'cus_1' },
    subscriptionById: { sub_1: { status: 'trialing', trial_end: 1760000000, items: { data: [{ price: { id: 'price_gold_monthly', product: 'prod_gold' } }] } } },
  });
  const res = webhookRes();
  await router.stripeWebhookHandler({ headers: { 'stripe-signature': 'sig' }, body: Buffer.from(JSON.stringify(checkoutEvent({ user_id: USER, tier: 'gold' }))) }, res);
  assert.equal(state.updates[0].subscription_tier, 'lifetime');
  assert.equal(state.updates[0].trial_end, null);
});

function subscriptionEvent(type, status) {
  return { type, data: { object: { id: 'sub_old', customer: 'cus_1', status, items: { data: [{ price: { id: 'price_gold_monthly', product: 'prod_gold' } }] } } } };
}

test('when a subscription ends, the profile gets the plan Stripe still holds, or free', async () => {
  reset({
    profile: { id: USER, subscription_tier: 'gold', subscription_status: 'active', stripe_customer_id: 'cus_1' },
    sessions: [lifetimeSession('pi_life')],
    charges: { pi_life: { refunded: false } },
  });
  let res = webhookRes();
  await router.stripeWebhookHandler({ headers: { 'stripe-signature': 'sig' }, body: Buffer.from(JSON.stringify(subscriptionEvent('customer.subscription.deleted', 'canceled'))) }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(state.updates[0].subscription_tier, 'lifetime');

  reset({
    profile: { id: USER, subscription_tier: 'gold', subscription_status: 'active', stripe_customer_id: 'cus_1' },
    subscriptions: [{ id: 'sub_second', status: 'active', items: { data: [{ price: { id: 'price_gold_yearly', product: 'prod_gold' } }] } }],
    subscriptionById: { sub_old: { id: 'sub_old', customer: 'cus_1', status: 'canceled', items: { data: [{ price: { id: 'price_gold_monthly', product: 'prod_gold' } }] } } },
  });
  res = webhookRes();
  await router.stripeWebhookHandler({ headers: { 'stripe-signature': 'sig' }, body: Buffer.from(JSON.stringify(subscriptionEvent('customer.subscription.updated', 'canceled'))) }, res);
  assert.equal(state.updates[0].subscription_tier, 'gold', 'a second Gold subscription is still live');

  reset({ profile: { id: USER, subscription_tier: 'gold', subscription_status: 'active', stripe_customer_id: 'cus_1' } });
  res = webhookRes();
  await router.stripeWebhookHandler({ headers: { 'stripe-signature': 'sig' }, body: Buffer.from(JSON.stringify(subscriptionEvent('customer.subscription.deleted', 'canceled'))) }, res);
  assert.equal(state.updates[0].subscription_tier, 'free');
});

test("checkout doesn't open when the new customer id can't be saved", async () => {
  reset({ profile: { email: 'a@example.com', stripe_customer_id: null }, updateError: { message: 'permission denied' } });
  const res = await checkout('price_gold_monthly');
  assert.equal(res.statusCode, 500);
  assert.equal(state.created, undefined);
});

test('an App Store expiry keeps a web plan Stripe still holds', async () => {
  const before = process.env.REVENUECAT_WEBHOOK_SECRET;
  process.env.REVENUECAT_WEBHOOK_SECRET = 'rc-test-secret';
  const expiry = { headers: { authorization: 'Bearer rc-test-secret' }, body: { event: { type: 'EXPIRATION', app_user_id: USER, product_id: 'stacktracker_gold_monthly' } } };
  try {
    reset({
      profile: { id: USER, subscription_tier: 'gold', subscription_status: 'active', stripe_customer_id: 'cus_1' },
      subscriptions: [{ id: 'sub_web', status: 'active', items: { data: [{ price: { id: 'price_gold_monthly', product: 'prod_gold' } }] } }],
    });
    const res = fakeRes();
    await router.revenueCatWebhookHandler(expiry, res);
    assert.equal(res.statusCode, 200);
    assert.equal(state.updates[0].subscription_tier, 'gold');

    reset({ profile: { id: USER, subscription_tier: 'gold', subscription_status: 'active', stripe_customer_id: 'cus_1' } });
    await router.revenueCatWebhookHandler(expiry, fakeRes());
    assert.equal(state.updates[0].subscription_tier, 'free');

    // Stripe can't be read, so RevenueCat is asked to send it again.
    reset({ profile: { id: USER, subscription_tier: 'gold', subscription_status: 'active', stripe_customer_id: 'cus_1' }, searchFails: true });
    const failed = fakeRes();
    await router.revenueCatWebhookHandler(expiry, failed);
    assert.equal(failed.statusCode, 500);
    assert.equal(state.updates.length, 0);
  } finally {
    if (before == null) delete process.env.REVENUECAT_WEBHOOK_SECRET;
    else process.env.REVENUECAT_WEBHOOK_SECRET = before;
  }
});

const portalHandler = routeHandler('/customer-portal');

test('checkout uses a customer an earlier checkout made instead of making another', async () => {
  reset({ profile: { stripe_customer_id: null }, customers: [{ id: 'cus_old', metadata: { supabase_user_id: USER } }] });
  const res = await checkout('price_gold_monthly');
  assert.equal(res.statusCode, 200);
  assert.equal(state.created.customer, 'cus_old');
  assert.ok(!state.stripeCalls.includes('customers.create'));
  assert.deepEqual(state.updates, [{ stripe_customer_id: 'cus_old' }]);
});

test('checkout makes a customer with the account email when there is none, and a bare profile row', async () => {
  reset({ profile: null });
  const res = await checkout('price_gold_monthly');
  assert.equal(res.statusCode, 200);
  assert.deepEqual(state.upserts, [{ id: USER }], 'a missing row gets a bare one that never touches a plan');
  assert.equal(state.createdCustomer.email, 'a@example.com');
  assert.equal(state.createdCustomer.metadata.supabase_user_id, USER);
  assert.equal(state.created.customer, 'cus_new');
});

test('checkout turns away an account that already holds a live web plan', async () => {
  reset({
    profile: { stripe_customer_id: 'cus_1' },
    subscriptions: [{ id: 'sub_live', status: 'trialing', items: { data: [{ price: { id: 'price_gold_yearly', product: 'prod_gold' } }] } }],
  });
  const res = await checkout('price_gold_monthly');
  assert.equal(res.statusCode, 409);
  assert.equal(state.created, undefined);
});

test('my-plan finds a plan on an older customer the profile no longer holds', async () => {
  reset({
    profile: { subscription_tier: 'free', subscription_status: null, stripe_customer_id: 'cus_new' },
    customers: [{ id: 'cus_old', metadata: { supabase_user_id: USER } }],
    subscriptions: [{ id: 'sub_old', customer: 'cus_old', status: 'active', items: { data: [{ price: { id: 'price_gold_monthly', product: 'prod_gold' } }] } }],
  });
  const res = await askMyPlan('good-token');
  assert.equal(res.body.plan, 'gold');
});

test("a customer search that fails means my-plan couldn't check", async () => {
  reset({ profile: { subscription_tier: 'free', subscription_status: null, stripe_customer_id: 'cus_1' }, searchFails: true });
  const res = await askMyPlan('good-token');
  assert.equal(res.statusCode, 500);
  const synced = await sync();
  assert.equal(synced.body.subscription_tier, 'free');
  assert.equal(state.updates.length, 0);
});

test('a subscription event for a customer the profile no longer holds still finds the account', async () => {
  reset({
    profile: { id: USER, subscription_tier: 'gold', subscription_status: 'active', stripe_customer_id: 'cus_new' },
    customerById: { cus_old: { id: 'cus_old', metadata: { supabase_user_id: USER } } },
  });
  const event = { type: 'customer.subscription.deleted', data: { object: { id: 'sub_old', customer: 'cus_old', status: 'canceled' } } };
  const res = webhookRes();
  await router.stripeWebhookHandler({ headers: { 'stripe-signature': 'sig' }, body: Buffer.from(JSON.stringify(event)) }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(state.updates[0].subscription_tier, 'free');
});

test('a live subscription to something other than Gold gives no Gold', async () => {
  const sub = { id: 'sub_api', customer: 'cus_1', status: 'active', items: { data: [{ price: { id: 'price_other_api', product: 'prod_other' } }] } };
  reset({ profile: { id: USER, subscription_tier: 'free', subscription_status: null, stripe_customer_id: 'cus_1' }, subscriptionById: { sub_api: sub } });
  const event = { type: 'customer.subscription.updated', data: { object: sub } };
  const res = webhookRes();
  await router.stripeWebhookHandler({ headers: { 'stripe-signature': 'sig' }, body: Buffer.from(JSON.stringify(event)) }, res);
  assert.equal(state.updates[0].subscription_tier, 'free');
});

test('the billing page opens on the customer that holds the plan', async () => {
  reset({
    profile: { stripe_customer_id: 'cus_new' },
    customers: [{ id: 'cus_old', metadata: { supabase_user_id: USER } }],
    subscriptions: [{ id: 'sub_old', customer: 'cus_old', status: 'active', items: { data: [{ price: { id: 'price_gold_monthly', product: 'prod_gold' } }] } }],
  });
  const res = fakeRes();
  await portalHandler({ headers: { authorization: 'Bearer good-token' }, body: { user_id: USER, return_url: 'https://troystack.ai/settings' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(state.portal.customer, 'cus_old');
});

test('a late subscription update is checked against where the subscription stands now', async () => {
  reset({
    profile: { id: USER, subscription_tier: 'free', subscription_status: 'canceled', stripe_customer_id: 'cus_1' },
    subscriptionById: { sub_old: { id: 'sub_old', customer: 'cus_1', status: 'canceled', items: { data: [{ price: { id: 'price_gold_monthly', product: 'prod_gold' } }] } } },
  });
  // A retried event from before the cancellation still says active.
  const res = webhookRes();
  await router.stripeWebhookHandler({ headers: { 'stripe-signature': 'sig' }, body: Buffer.from(JSON.stringify(subscriptionEvent('customer.subscription.updated', 'active'))) }, res);
  assert.equal(res.statusCode, 200);
  assert.ok(state.stripeCalls.includes('subscriptions.retrieve'));
  assert.equal(state.updates[0].subscription_tier, 'free');
});

test("a profile read that fails isn't taken as no profile, so Stripe sends the event again", async () => {
  reset({ profile: { id: USER, subscription_tier: 'gold', subscription_status: 'active', stripe_customer_id: 'cus_1' }, profileError: { code: '08006', message: 'connection reset' } });
  const res = webhookRes();
  await router.stripeWebhookHandler({ headers: { 'stripe-signature': 'sig' }, body: Buffer.from(JSON.stringify(subscriptionEvent('customer.subscription.deleted', 'canceled'))) }, res);
  assert.equal(res.statusCode, 500);
  assert.equal(state.updates.length, 0);
});

test('the free week is for the first Gold subscription only', async () => {
  reset({ profile: { stripe_customer_id: 'cus_1' } });
  let res = await checkout('price_gold_monthly');
  assert.equal(res.statusCode, 200);
  assert.equal(state.created.subscription_data.trial_period_days, 7);
  assert.equal(res.body.trial, true);

  reset({
    profile: { stripe_customer_id: 'cus_1' },
    subscriptions: [{ id: 'sub_was', status: 'canceled', items: { data: [{ price: { id: 'price_gold_monthly', product: 'prod_gold' } }] } }],
  });
  res = await checkout('price_gold_yearly');
  assert.equal(res.statusCode, 200);
  assert.equal(state.created.subscription_data, undefined, 'no trial and no campaign');
  assert.equal(res.body.trial, false);

  // A subscription whose first payment never went through, or one to
  // something else, doesn't use up the week.
  reset({
    profile: { stripe_customer_id: 'cus_1' },
    subscriptions: [
      { id: 'sub_failed', status: 'incomplete_expired', items: { data: [{ price: { id: 'price_gold_monthly', product: 'prod_gold' } }] } },
      { id: 'sub_api', status: 'canceled', items: { data: [{ price: { id: 'price_other_api', product: 'prod_other' } }] } },
    ],
  });
  res = await checkout('price_gold_monthly');
  assert.equal(state.created.subscription_data.trial_period_days, 7);
});

test('an earlier Gold subscription on an older customer counts too', async () => {
  reset({
    profile: { stripe_customer_id: 'cus_new' },
    customers: [{ id: 'cus_old', metadata: { supabase_user_id: USER } }],
    subscriptions: [{ id: 'sub_old', customer: 'cus_old', status: 'canceled', items: { data: [{ price: { id: 'price_gold_monthly', product: 'prod_gold' } }] } }],
  });
  const res = await checkout('price_gold_monthly', 'pricing');
  assert.equal(res.statusCode, 200);
  assert.equal(state.created.subscription_data.trial_period_days, undefined);
  assert.deepEqual(state.created.subscription_data.metadata, { campaign: 'pricing' });
});

test('a checkout left open in another tab is closed before a new one opens', async () => {
  reset({
    profile: { stripe_customer_id: 'cus_1' },
    sessions: [
      { id: 'cs_open', customer: 'cus_1', status: 'open', mode: 'subscription' },
      { id: 'cs_done', customer: 'cus_1', status: 'complete', mode: 'subscription' },
    ],
  });
  const res = await checkout('price_gold_monthly');
  assert.equal(res.statusCode, 200);
  assert.deepEqual(state.expired, ['cs_open']);
  assert.ok(state.stripeCalls.indexOf('checkout.sessions.expire') < state.stripeCalls.indexOf('checkout.sessions.create'));
});

test('a plan on a customer the profile never recorded still stops a second checkout', async () => {
  reset({
    profile: { stripe_customer_id: null },
    customers: [{ id: 'cus_old', metadata: { supabase_user_id: USER } }],
    subscriptions: [{ id: 'sub_live', customer: 'cus_old', status: 'active', items: { data: [{ price: { id: 'price_gold_monthly', product: 'prod_gold' } }] } }],
  });
  const res = await checkout('price_gold_yearly');
  assert.equal(res.statusCode, 409);
  assert.equal(state.created, undefined);
});

test('the billing page opens where a subscription is still billing, even with lifetime elsewhere', async () => {
  reset({
    profile: { stripe_customer_id: 'cus_life' },
    customers: [{ id: 'cus_sub', metadata: { supabase_user_id: USER } }],
    sessions: [{ ...lifetimeSession('pi_life'), customer: 'cus_life' }],
    charges: { pi_life: { refunded: false } },
    subscriptions: [{ id: 'sub_monthly', customer: 'cus_sub', status: 'active', items: { data: [{ price: { id: 'price_gold_monthly', product: 'prod_gold' } }] } }],
  });
  const res = fakeRes();
  await portalHandler({ headers: { authorization: 'Bearer good-token' }, body: { user_id: USER, return_url: 'https://troystack.ai/settings' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(state.portal.customer, 'cus_sub');
});

test('a one-time checkout gives nothing until its payment has gone through', async () => {
  const pending = {
    type: 'checkout.session.completed',
    data: { object: { id: 'cs_ach', mode: 'payment', status: 'complete', payment_status: 'unpaid', customer: 'cus_1', client_reference_id: USER, metadata: { user_id: USER, tier: 'lifetime' }, payment_intent: 'pi_ach' } },
  };
  reset({ profile: { id: USER, subscription_tier: 'free', subscription_status: null, stripe_customer_id: 'cus_1' }, charges: { pi_ach: { refunded: false } } });
  let res = webhookRes();
  await router.stripeWebhookHandler({ headers: { 'stripe-signature': 'sig' }, body: Buffer.from(JSON.stringify(pending)) }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(state.updates.length, 0);

  const failed = { type: 'checkout.session.async_payment_failed', data: { object: { ...pending.data.object } } };
  res = webhookRes();
  await router.stripeWebhookHandler({ headers: { 'stripe-signature': 'sig' }, body: Buffer.from(JSON.stringify(failed)) }, res);
  assert.equal(state.updates.length, 0);

  const paid = { type: 'checkout.session.async_payment_succeeded', data: { object: { ...pending.data.object, payment_status: 'paid' } } };
  res = webhookRes();
  await router.stripeWebhookHandler({ headers: { 'stripe-signature': 'sig' }, body: Buffer.from(JSON.stringify(paid)) }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(state.updates[0].subscription_tier, 'lifetime');
});

test('an account whose profile already shows Gold from the App Store is not sold another plan', async () => {
  for (const tier of ['gold', 'lifetime']) {
    reset({ profile: { stripe_customer_id: null, subscription_tier: tier } });
    const res = await checkout('price_gold_monthly');
    assert.equal(res.statusCode, 409, tier);
    assert.equal(state.created, undefined);
  }
});
