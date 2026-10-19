// GET /v1/sync-subscription puts a web plan back when the iPhone app has
// written free over it. Supabase and Stripe are stand-ins here, so these
// tests run without credentials or network.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const USER = '7b1c6c1e-1111-4a2b-9c3d-000000000001';
const OTHER = '8c2d7d2f-2222-4b3c-8d4e-000000000002';
// The session tokens the stand-in knows, and the account each one signs in.
const TOKENS = new Map([
  ['good-token', USER],
  ['other-token', OTHER],
]);

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
  appState: {},
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
    createdCustomer: undefined,
    // The profile upsert fails with this error.
    upsertError: null,
    // A profile update matches no row, as when the row is gone.
    updateNoRow: false,
    // app_state values by key, where the RevenueCat webhook keeps its purchase record.
    appState: {},
    // Promises by account that hold that account's new checkout until they settle.
    holdCreate: {},
    // app_state inserts and deletes fail with this error, as when the
    // database can't be reached.
    turnError: null,
    // Stripe calls that fail, as during an outage: listing subscriptions,
    // listing open checkouts, and expiring one.
    subscriptionsFail: false,
    openListFails: false,
    expireFails: false,
    // The RevenueCat purchase record can't be read, and how many times it was read.
    recordReadFails: false,
    recordReads: 0,
    // Listing subscriptions fails once the purchase record has been read,
    // which in checkout is the free week's look back through Stripe.
    historyScanFails: false,
    // Invoices, each with the subscription it bills and its status, and the
    // ones voided and subscriptions cancelled, with switches that make
    // either call fail.
    invoices: [],
    voided: [],
    cancelled: [],
    voidFails: false,
    cancelFails: false,
    // Listing profiles for the daily reconcile fails with this error.
    listError: null,
  }, over);
  router.resetGoldProductCache();
  router.resetCustomerSearchCache();
}

// A JSON field of an app_state value, as PostgREST's value->>field filter reads it.
function valueField(value, column) {
  const field = /^value->>(\w+)$/.exec(column)?.[1];
  return field && value && value[field] != null ? String(value[field]) : null;
}

const appStateTable = {
  select() {
    return {
      eq: (_col, key) => ({
        maybeSingle: async () => {
          if (key.startsWith('revenuecat_grant:')) {
            state.recordReads += 1;
            if (state.recordReadFails) return { data: null, error: { message: 'connection reset' } };
          }
          return { data: Object.hasOwn(state.appState, key) ? { value: state.appState[key] } : null, error: null };
        },
      }),
    };
  },
  upsert: async (row) => {
    state.appState[row.key] = row.value;
    return { error: null };
  },
  // A key that's already there fails on the primary key, as in Postgres.
  insert: async (row) => {
    if (state.turnError) return { error: state.turnError };
    if (Object.hasOwn(state.appState, row.key)) return { error: { code: '23505', message: 'duplicate key value violates unique constraint' } };
    state.appState[row.key] = row.value;
    return { error: null };
  },
  // Deletes the rows that match every filter, on the key or on a JSON field.
  delete() {
    const filters = [];
    const query = {
      eq(column, wanted) {
        filters.push((key, value) => (column === 'key' ? key === wanted : valueField(value, column) === String(wanted)));
        return query;
      },
      lt(column, bound) {
        filters.push((_key, value) => valueField(value, column) != null && valueField(value, column) < bound);
        return query;
      },
      then(resolve, reject) {
        if (state.turnError) return Promise.resolve({ error: state.turnError }).then(resolve, reject);
        for (const key of Object.keys(state.appState)) {
          if (filters.every((match) => match(key, state.appState[key]))) delete state.appState[key];
        }
        return Promise.resolve({ error: null }).then(resolve, reject);
      },
    };
    return query;
  },
};

const fakeSupabase = {
  auth: {
    getUser: async (token) => (TOKENS.has(token) ? { data: { user: { id: TOKENS.get(token) } }, error: null } : { data: { user: null }, error: { message: 'invalid JWT' } }),
    admin: {
      getUserById: async (id) => ({ data: { user: { id, email: 'a@example.com' } }, error: null }),
    },
  },
  from(table) {
    if (table === 'app_state') return appStateTable;
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
            // The daily reconcile lists Gold profiles that have a customer:
            // the one profile, as user USER, when it's both.
            not: () => ({
              order: () => ({
                range: async () => {
                  if (state.listError) return { data: null, error: state.listError };
                  const p = state.profile;
                  return { data: p && p[col] === val && p.stripe_customer_id ? [{ id: USER }] : [], error: null };
                },
              }),
            }),
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
          // Awaited on its own it answers { error }. With .select() it also
          // answers the rows it changed: the one profile unless it holds a
          // different value, and none when updateNoRow is set.
          eq: (col, val) => {
            state.updates.push(values);
            const p = state.profile;
            const rows = !state.updateNoRow && p && (p[col] === undefined || p[col] === val) ? [{ ...p, ...values }] : [];
            return {
              then: (resolve, reject) => Promise.resolve({ error: state.updateError }).then(resolve, reject),
              select: async () => (state.updateError ? { data: null, error: state.updateError } : { data: rows, error: null }),
            };
          },
        };
      },
      upsert: async (values) => {
        state.upserts.push(values);
        if (state.upsertError) return { error: state.upsertError };
        // A missing row is made, as the database would make it.
        if (!state.profile) state.profile = { ...values };
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
      if (state.subscriptionsFail || (state.historyScanFails && state.recordReads > 0)) throw new Error('Stripe is having a moment');
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
        if (state.openListFails && params.status === 'open') throw new Error('Stripe is having a moment');
        let rows = state.sessions.filter(
          (x) =>
            (!params.status || x.status === params.status) &&
            (!x.customer || !params.customer || x.customer === params.customer) &&
            (!params.payment_intent || x.payment_intent === params.payment_intent),
        );
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
fakeStripe.invoices = {
  // Filtered by subscription and status, and paged by starting_after, like Stripe.
  list: async (params = {}) => {
    state.stripeCalls.push('invoices.list');
    let rows = state.invoices.filter((x) => (!params.subscription || x.subscription === params.subscription) && (!params.status || x.status === params.status));
    if (params.starting_after) rows = rows.slice(rows.findIndex((x) => x.id === params.starting_after) + 1);
    const page = rows.slice(0, params.limit || 10);
    return { data: page, has_more: rows.length > page.length };
  },
  voidInvoice: async (id) => {
    state.stripeCalls.push('invoices.voidInvoice');
    if (state.voidFails) throw new Error('Stripe is having a moment');
    state.voided.push(id);
    const invoice = state.invoices.find((x) => x.id === id);
    if (invoice) invoice.status = 'void';
    return { id, status: 'void' };
  },
};
fakeStripe.subscriptions.cancel = async (id, params) => {
  state.stripeCalls.push('subscriptions.cancel');
  if (state.cancelFails) throw new Error('Stripe is having a moment');
  state.cancelled.push({ id, params });
  const sub = state.subscriptions.find((x) => x.id === id);
  if (sub) sub.status = 'canceled';
  return { id, status: 'canceled' };
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
  if (state.expireFails) throw new Error('Stripe is having a moment');
  state.expired.push(id);
  // An expired checkout isn't open to the next list.
  const session = state.sessions.find((x) => x.id === id);
  if (session) session.status = 'expired';
  return { id, status: 'expired' };
};
fakeStripe.checkout.sessions.create = async (params) => {
  state.stripeCalls.push('checkout.sessions.create');
  state.created = params;
  const hold = state.holdCreate[params.client_reference_id];
  if (hold) await hold;
  // The new checkout is open, and the next list sees it first, like Stripe.
  const id = `cs_opened_${state.sessions.length + 1}`;
  state.sessions.unshift({ id, customer: params.customer, status: 'open', mode: params.mode });
  return { id, url: 'https://checkout.stripe.com/c/pay/test' };
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

async function checkout(priceId, campaign, { user = USER, token = 'good-token' } = {}) {
  const res = fakeRes();
  await createCheckout(
    { headers: { authorization: `Bearer ${token}` }, body: { user_id: user, price_id: priceId, success_url: 'https://troystack.ai/settings?session_id={CHECKOUT_SESSION_ID}', ...(campaign ? { campaign } : {}) } },
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

test("checkout doesn't open, and makes nothing in Stripe, when a missing profile row can't be made", async () => {
  reset({ profile: null, upsertError: { message: 'connection reset' } });
  const res = await checkout('price_gold_monthly');
  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.body, { error: "Checkout didn't open. Try again in a moment." });
  assert.deepEqual(state.upserts, [{ id: USER }]);
  assert.deepEqual(state.stripeCalls, [], 'no search, no customer and no session');
  assert.equal(state.createdCustomer, undefined);
  assert.equal(state.created, undefined);
});

test("checkout doesn't open when the customer id saves to no row", async () => {
  reset({ profile: { stripe_customer_id: null }, updateNoRow: true });
  const res = await checkout('price_gold_monthly');
  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.body, { error: "Checkout didn't open. Try again in a moment." });
  assert.deepEqual(state.updates, [{ stripe_customer_id: 'cus_new' }]);
  assert.ok(!state.stripeCalls.includes('checkout.sessions.create'));
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

test('an App Store expiry for a profile with no customer id finds a web plan by search and keeps Gold', async () => {
  const before = process.env.REVENUECAT_WEBHOOK_SECRET;
  process.env.REVENUECAT_WEBHOOK_SECRET = 'rc-test-secret';
  try {
    reset({
      profile: { id: USER, subscription_tier: 'gold', subscription_status: 'active', stripe_customer_id: null },
      customers: [{ id: 'cus_old', metadata: { supabase_user_id: USER } }],
      subscriptions: [{ id: 'sub_web', customer: 'cus_old', status: 'active', items: { data: [{ price: { id: 'price_gold_monthly', product: 'prod_gold' } }] } }],
    });
    const res = fakeRes();
    await router.revenueCatWebhookHandler({ headers: { authorization: 'Bearer rc-test-secret' }, body: { event: { type: 'EXPIRATION', app_user_id: USER, product_id: 'monthly' } } }, res);
    assert.equal(res.statusCode, 200);
    assert.ok(state.stripeCalls.includes('customers.search'));
    assert.equal(state.updates.length, 1);
    assert.equal(state.updates[0].subscription_tier, 'gold');
    assert.equal(state.updates[0].subscription_status, 'active');
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

test('a web subscription that ends leaves an App Store plan that still runs', async () => {
  const running = new Date(Date.now() + 20 * 86400000).toISOString();
  for (const type of ['customer.subscription.deleted', 'customer.subscription.updated']) {
    reset({
      profile: { id: USER, subscription_tier: 'gold', subscription_status: null, stripe_customer_id: 'cus_1', subscription_expires_at: running },
      subscriptionById: { sub_old: { id: 'sub_old', customer: 'cus_1', status: 'canceled', items: { data: [{ price: { id: 'price_gold_monthly', product: 'prod_gold' } }] } } },
    });
    const res = webhookRes();
    await router.stripeWebhookHandler({ headers: { 'stripe-signature': 'sig' }, body: Buffer.from(JSON.stringify(subscriptionEvent(type, 'canceled'))) }, res);
    assert.equal(res.statusCode, 200, type);
    assert.equal(state.updates.length, 0, `${type} leaves the Apple plan`);
  }
  // Once the App Store plan has run out, the web subscription's end does count.
  reset({ profile: { id: USER, subscription_tier: 'gold', subscription_status: null, stripe_customer_id: 'cus_1', subscription_expires_at: new Date(Date.now() - 86400000).toISOString() } });
  await router.stripeWebhookHandler({ headers: { 'stripe-signature': 'sig' }, body: Buffer.from(JSON.stringify(subscriptionEvent('customer.subscription.deleted', 'canceled'))) }, webhookRes());
  assert.equal(state.updates[0].subscription_tier, 'free');
});

async function openPortal() {
  const res = fakeRes();
  await portalHandler({ headers: { authorization: 'Bearer good-token' }, body: { user_id: USER, return_url: 'https://troystack.ai/settings' } }, res);
  return res;
}

test('the billing page opens for a profile with no customer id when the search finds its customer', async () => {
  reset({
    profile: { stripe_customer_id: null },
    customers: [{ id: 'cus_old', metadata: { supabase_user_id: USER } }],
    subscriptions: [{ id: 'sub_old', customer: 'cus_old', status: 'active', items: { data: [{ price: { id: 'price_gold_monthly', product: 'prod_gold' } }] } }],
  });
  const res = await openPortal();
  assert.equal(res.statusCode, 200);
  assert.ok(state.stripeCalls.includes('customers.search'));
  assert.equal(state.portal.customer, 'cus_old');
});

test('the billing page still answers 404 when the profile has no customer id and the search finds none', async () => {
  // A profile with no customer id, and no profile row at all.
  for (const profile of [{ stripe_customer_id: null }, null]) {
    reset({ profile });
    const res = await openPortal();
    assert.equal(res.statusCode, 404, JSON.stringify(profile));
    assert.deepEqual(res.body, { error: 'No Stripe customer found for this user' });
    assert.ok(state.stripeCalls.includes('customers.search'));
    assert.ok(!state.stripeCalls.includes('billingPortal.sessions.create'));
  }

  // A search that fails isn't an answer that there's none.
  reset({ profile: { stripe_customer_id: null }, searchFails: true });
  const res = await openPortal();
  assert.equal(res.statusCode, 500);
  assert.ok(!state.stripeCalls.includes('billingPortal.sessions.create'));
});

test('two checkouts at once for one account open one after the other, and the first is closed before the second opens', async () => {
  reset({ profile: { stripe_customer_id: 'cus_1' } });
  const [first, second] = await Promise.all([checkout('price_gold_monthly'), checkout('price_gold_yearly')]);
  assert.equal(first.statusCode, 200);
  assert.equal(second.statusCode, 200);
  const creates = state.stripeCalls.flatMap((call, i) => (call === 'checkout.sessions.create' ? [i] : []));
  const expire = state.stripeCalls.indexOf('checkout.sessions.expire');
  assert.equal(creates.length, 2);
  assert.deepEqual(state.expired, ['cs_opened_1'], "the second request closed the first one's checkout");
  assert.ok(creates[0] < expire && expire < creates[1], 'closed after the first opened and before the second opened');
});

test("checkouts for two different accounts don't wait on each other", async () => {
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  // The stand-in's one profile row answers for both accounts.
  reset({ profile: { stripe_customer_id: 'cus_1' }, holdCreate: { [USER]: held } });
  const first = checkout('price_gold_monthly');
  let timer;
  try {
    // The first account's checkout gets as far as Stripe and is held there.
    // The stand-ins answer at once, so waiting a step at a time is enough.
    for (let i = 0; i < 1000 && !state.stripeCalls.includes('checkout.sessions.create'); i += 1) {
      await null;
    }
    assert.ok(state.stripeCalls.includes('checkout.sessions.create'));
    const second = checkout('price_gold_monthly', null, { user: OTHER, token: 'other-token' });
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve('timed out'), 1000);
    });
    assert.equal(await Promise.race([second.then(() => 'finished'), timeout]), 'finished');
    assert.equal((await second).statusCode, 200);
  } finally {
    clearTimeout(timer);
    release();
  }
  assert.equal((await first).statusCode, 200);
});

const goldItems = { data: [{ price: { id: 'price_gold_monthly', product: 'prod_gold' } }] };

async function stripeEvent(event) {
  const res = webhookRes();
  await router.stripeWebhookHandler({ headers: { 'stripe-signature': 'sig' }, body: Buffer.from(JSON.stringify(event)) }, res);
  return res;
}

test("a Gold subscription whose renewal failed keeps Gold while Stripe retries, and an unpaid one doesn't", async () => {
  const sub = (status) => ({ id: 'sub_old', customer: 'cus_1', status, items: goldItems });
  reset({ profile: { id: USER, subscription_tier: 'gold', subscription_status: 'active', stripe_customer_id: 'cus_1' }, subscriptionById: { sub_old: sub('past_due') } });
  let res = await stripeEvent(subscriptionEvent('customer.subscription.updated', 'past_due'));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(state.updates, [{ subscription_tier: 'gold', subscription_status: 'past_due', trial_end: null }]);

  // Retries ran out. Nothing else is held, so the plan ends.
  reset({ profile: { id: USER, subscription_tier: 'gold', subscription_status: 'past_due', stripe_customer_id: 'cus_1' }, subscriptionById: { sub_old: sub('unpaid') }, subscriptions: [sub('unpaid')] });
  res = await stripeEvent(subscriptionEvent('customer.subscription.updated', 'unpaid'));
  assert.equal(res.statusCode, 200);
  assert.equal(state.updates[0].subscription_tier, 'free');

  // The app's plan checks see a past due subscription as Gold too.
  reset({ profile: { subscription_tier: 'free', subscription_status: null, stripe_customer_id: 'cus_1' }, subscriptions: [sub('past_due')] });
  assert.deepEqual((await askMyPlan('good-token')).body, { plan: 'gold', status: 'past_due', trial_end: null });
});

test('checkout turns away an account whose Gold payment failed and points it to the billing page', async () => {
  const sub = (status) => ({ id: 'sub_1', customer: 'cus_1', status, items: goldItems });
  const cases = [
    ['the profile kept Gold through the retries', { profile: { stripe_customer_id: 'cus_1', subscription_tier: 'gold', subscription_status: 'past_due' } }],
    ['Stripe holds a past due subscription', { profile: { stripe_customer_id: 'cus_1' }, subscriptions: [sub('past_due')] }],
  ];
  for (const [label, over] of cases) {
    reset(over);
    const res = await checkout('price_gold_yearly');
    assert.equal(res.statusCode, 409, label);
    assert.equal(res.body.reason, 'payment_issue', label);
    assert.match(res.body.error, /card/, label);
    assert.equal(state.created, undefined, label);
  }
});

test('a checkout turn held on another instance answers 409, and one left by a request that died is cleared', async () => {
  const turnKey = `checkout_turn:${USER}`;
  const held = { until: new Date(Date.now() + 60 * 1000).toISOString(), owner: 'another-instance' };
  reset({ profile: { stripe_customer_id: 'cus_1' }, appState: { [turnKey]: held } });
  const busy = await checkout('price_gold_monthly');
  assert.equal(busy.statusCode, 409);
  assert.equal(busy.body.reason, 'checkout_in_progress');
  assert.ok(!state.stripeCalls.includes('checkout.sessions.create'));
  assert.deepEqual(state.appState[turnKey], held, "the other instance's turn stays");

  reset({ profile: { stripe_customer_id: 'cus_1' }, appState: { [turnKey]: { until: new Date(Date.now() - 1000).toISOString(), owner: 'a-request-that-died' } } });
  const res = await checkout('price_gold_monthly');
  assert.equal(res.statusCode, 200);
  assert.equal(state.appState[turnKey], undefined, 'the turn is given back once the checkout is open');

  // An early answer gives the turn back too.
  reset({ profile: { stripe_customer_id: 'cus_1', subscription_tier: 'gold' } });
  assert.equal((await checkout('price_gold_monthly')).statusCode, 409);
  assert.equal(state.appState[turnKey], undefined);
});

test("checkout doesn't open when its turn can't be taken", async () => {
  reset({ profile: { stripe_customer_id: 'cus_1' }, turnError: { message: 'connection reset' } });
  const res = await checkout('price_gold_monthly');
  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.body, { error: "Checkout didn't open. Try again in a moment." });
  assert.deepEqual(state.stripeCalls, [], 'nothing is read or made in Stripe');
});

test('an account that had an App Store trial or plan gets no web free week', async () => {
  for (const customer of ['cus_1', null]) {
    reset({ profile: { stripe_customer_id: customer }, appState: { [`revenuecat_grant:${USER}`]: { subscriptionPurchasedAt: Date.now() - 100 * 86400000 } } });
    const res = await checkout('price_gold_monthly');
    assert.equal(res.statusCode, 200, String(customer));
    assert.equal(res.body.trial, false, String(customer));
    assert.equal(state.created.subscription_data, undefined, String(customer));
  }
});

const lifetimeProfile = () => ({ id: USER, subscription_tier: 'lifetime', subscription_status: 'active', stripe_customer_id: 'cus_1' });
const paidLifetime = () => ({ ...lifetimeSession('pi_life'), customer: 'cus_1', client_reference_id: USER });
const charge = (type, object) => ({ type, data: { object } });

test('a web lifetime refunded in full drops to what the account still holds', async () => {
  const refunded = charge('charge.refunded', { id: 'ch_life', payment_intent: 'pi_life', refunded: true });
  const until = Date.now() + 40 * 86400000;
  const cases = [
    ['nothing else', {}, { subscription_tier: 'free', subscription_status: null, trial_end: null }],
    ['a Gold subscription still running', { subscriptions: [{ id: 'sub_1', customer: 'cus_1', status: 'active', items: goldItems }] }, { subscription_tier: 'gold', subscription_status: 'active', trial_end: null }],
    ['an App Store subscription on record', { appState: { [`revenuecat_grant:${USER}`]: { subscriptionUntil: until } } }, { subscription_tier: 'gold', subscription_status: 'active', trial_end: null, subscription_expires_at: new Date(until).toISOString() }],
    ['an App Store free trial on record', { appState: { [`revenuecat_grant:${USER}`]: { subscriptionUntil: until, subscriptionTrial: true } } }, { subscription_tier: 'gold', subscription_status: 'trialing', trial_end: new Date(until).toISOString(), subscription_expires_at: new Date(until).toISOString() }],
  ];
  for (const [label, over, written] of cases) {
    reset({ profile: lifetimeProfile(), sessions: [paidLifetime()], charges: { pi_life: { refunded: true } }, ...over });
    const res = await stripeEvent(refunded);
    assert.equal(res.statusCode, 200, label);
    assert.deepEqual(state.updates, [written], label);
  }

  // An older checkout that doesn't name its account is found through its customer.
  reset({ profile: lifetimeProfile(), sessions: [{ ...lifetimeSession('pi_life'), customer: 'cus_1' }], charges: { pi_life: { refunded: true } } });
  await stripeEvent(refunded);
  assert.deepEqual(state.updates, [{ subscription_tier: 'free', subscription_status: null, trial_end: null }]);

  // An App Store lifetime on record, a partial refund, and a refund of
  // anything but a lifetime checkout all leave lifetime.
  reset({ profile: lifetimeProfile(), sessions: [paidLifetime()], charges: { pi_life: { refunded: true } }, appState: { [`revenuecat_grant:${USER}`]: { lifetime: true } } });
  await stripeEvent(refunded);
  reset({ profile: lifetimeProfile(), sessions: [paidLifetime()], charges: { pi_life: { refunded: false } } });
  await stripeEvent(charge('charge.refunded', { id: 'ch_life', payment_intent: 'pi_life', refunded: false }));
  reset({ profile: lifetimeProfile(), sessions: [paidLifetime()], charges: { pi_life: { refunded: false } } });
  await stripeEvent(charge('charge.refunded', { id: 'ch_sub', payment_intent: 'pi_invoice', refunded: true }));
  assert.deepEqual(state.updates, []);
});

test('a chargeback on a web lifetime drops it, an inquiry leaves it, and winning gives it back', async () => {
  const disputed = (status) => ({ profile: lifetimeProfile(), sessions: [paidLifetime()], charges: { pi_life: { refunded: false, disputed: true } }, disputes: { pi_life: [{ status }] } });
  reset(disputed('needs_response'));
  let res = await stripeEvent(charge('charge.dispute.created', { id: 'dp_1', payment_intent: 'pi_life', status: 'needs_response' }));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(state.updates, [{ subscription_tier: 'free', subscription_status: null, trial_end: null }]);
  // The sign-in repair doesn't bring it back while the chargeback is open.
  reset({ ...disputed('under_review'), profile: { subscription_tier: 'free', subscription_status: null, stripe_customer_id: 'cus_1' } });
  assert.equal((await sync()).body.subscription_tier, 'free');

  reset(disputed('warning_needs_response'));
  await stripeEvent(charge('charge.dispute.created', { id: 'dp_2', payment_intent: 'pi_life', status: 'warning_needs_response' }));
  assert.deepEqual(state.updates, [], 'an inquiry is not a chargeback yet');

  reset({ ...disputed('won'), profile: { ...lifetimeProfile(), subscription_tier: 'free', subscription_status: null } });
  res = await stripeEvent(charge('charge.dispute.closed', { id: 'dp_1', payment_intent: 'pi_life', status: 'won' }));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(state.updates, [{ subscription_tier: 'lifetime', subscription_status: 'active', trial_end: null }]);
});

test("checkout stops when it can't tell whether the account already has a plan", async () => {
  const cases = [
    ['the customer search fails', { profile: { stripe_customer_id: 'cus_1' }, searchFails: true }],
    ['the subscriptions list fails', { profile: { stripe_customer_id: 'cus_1' }, subscriptionsFail: true }],
    ['the search for an older customer fails', { profile: { stripe_customer_id: null }, searchFails: true }],
  ];
  for (const [label, over] of cases) {
    reset(over);
    const res = await checkout('price_gold_monthly');
    assert.equal(res.statusCode, 503, label);
    assert.match(res.body.error, /Try again/, label);
    assert.ok(!state.stripeCalls.includes('customers.create'), `${label}: no customer made`);
    assert.ok(!state.stripeCalls.includes('checkout.sessions.create'), `${label}: no checkout opened`);
  }
});

test("checkout stops when a checkout it opened before can't be closed", async () => {
  const open = { id: 'cs_open', customer: 'cus_1', status: 'open', mode: 'subscription' };
  for (const [label, over] of [['the open checkout fails to expire', { expireFails: true }], ['open checkouts fail to list', { openListFails: true }]]) {
    reset({ profile: { stripe_customer_id: 'cus_1' }, sessions: [{ ...open }], ...over });
    const res = await checkout('price_gold_monthly');
    assert.equal(res.statusCode, 503, label);
    assert.match(res.body.error, /Try again/, label);
    assert.ok(!state.stripeCalls.includes('checkout.sessions.create'), `${label}: no second checkout while the first can still be paid`);
  }
});

test('the billing page opens on the customer whose subscription is Gold, not one billing for something else', async () => {
  reset({
    profile: { stripe_customer_id: 'cus_1' },
    customers: [{ id: 'cus_gold', metadata: { supabase_user_id: USER } }],
    subscriptions: [
      { id: 'sub_api', customer: 'cus_1', status: 'active', items: { data: [{ price: { id: 'price_other_api', product: 'prod_other' } }] } },
      { id: 'sub_gold', customer: 'cus_gold', status: 'active', items: goldItems },
    ],
  });
  const res = await openPortal();
  assert.equal(res.statusCode, 200);
  assert.equal(state.portal.customer, 'cus_gold');
});

test("checkout stops when it can't tell whether the account had Gold before, rather than give a free week", async () => {
  const cases = [
    ["the App Store record can't be read", { profile: { stripe_customer_id: 'cus_1' }, recordReadFails: true }],
    ["the App Store record can't be read, with no customer yet", { profile: { stripe_customer_id: null }, recordReadFails: true }],
    ['the look back through Stripe fails', { profile: { stripe_customer_id: 'cus_1' }, historyScanFails: true }],
  ];
  for (const [label, over] of cases) {
    reset(over);
    const res = await checkout('price_gold_monthly');
    assert.equal(res.statusCode, 503, label);
    assert.match(res.body.error, /Try again/, label);
    assert.ok(!state.stripeCalls.includes('customers.create'), `${label}: no customer made`);
    assert.ok(!state.stripeCalls.includes('checkout.sessions.create'), `${label}: no checkout opened`);
  }
  // Lifetime has no free week, so it doesn't look.
  reset({ profile: { stripe_customer_id: 'cus_1' }, recordReadFails: true });
  assert.equal((await checkout('price_gold_lifetime')).statusCode, 200);
});

// Runs fn with REVENUECAT_SECRET_KEY set to key, or unset for null, and with
// RevenueCat's REST API answered by api in place of fetch when it's given.
async function withRevenueCat(key, api, fn) {
  const before = { key: process.env.REVENUECAT_SECRET_KEY, fetch: global.fetch };
  if (key == null) delete process.env.REVENUECAT_SECRET_KEY;
  else process.env.REVENUECAT_SECRET_KEY = key;
  if (api) global.fetch = api;
  try {
    return await fn();
  } finally {
    if (before.key == null) delete process.env.REVENUECAT_SECRET_KEY;
    else process.env.REVENUECAT_SECRET_KEY = before.key;
    global.fetch = before.fetch;
  }
}

const lapsedStoreGold = () => ({ stripe_customer_id: 'cus_1', subscription_tier: 'gold', subscription_status: 'active', subscription_expires_at: new Date(Date.now() - 86400000).toISOString() });

// RevenueCat's REST API as a stand-in: each call answers the next of answers,
// a subscriber's subscriptions, or a whole one as { subscriber }, or 'fail'
// for a call that fails, and nothing once they run out. status fails every
// call, and hang leaves every call unanswered until it's given up on. calls
// collects the addresses asked.
function revenueCatApi(answers = [], { status = 200, hang = false } = {}) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push(String(url));
    if (hang) {
      return new Promise((_resolve, reject) => {
        // AbortSignal.timeout's timer doesn't hold the process open, so this
        // one does until the read is given up on.
        const alive = setInterval(() => {}, 10);
        init.signal?.addEventListener('abort', () => {
          clearInterval(alive);
          reject(init.signal.reason);
        });
      });
    }
    const answer = answers.shift() ?? {};
    if (answer === 'fail') return { ok: false, status: 500, json: async () => ({}) };
    const subscriber = { entitlements: {}, subscriptions: {}, non_subscriptions: {}, ...(answer.subscriber || { subscriptions: answer }) };
    return { ok: status === 200, status, json: async () => ({ subscriber }) };
  };
  return { calls, answers, fetch };
}

test('App Store Gold past its expiry is settled before checkout only by asking RevenueCat, and turns the account away while Apple may still renew it', async () => {
  const periodEnd = Date.now() - 86400000;

  // Without the key nothing is settled, since Apple may still be retrying the
  // payment in a grace period, and the answer points to the App Store.
  await withRevenueCat(null, null, async () => {
    reset({ profile: lapsedStoreGold(), appState: { [`revenuecat_grant:${USER}`]: { subscriptionPurchasedAt: Date.now() - 40 * 86400000, subscriptionUntil: periodEnd } } });
    const res = await checkout('price_gold_monthly');
    assert.equal(res.statusCode, 409);
    assert.equal(res.body.reason, 'app_store_renewing');
    assert.match(res.body.error, /App Store/);
    assert.deepEqual(state.updates, []);
    assert.equal(state.created, undefined);
  });

  const api = revenueCatApi();
  await withRevenueCat('rc-rest-test-key', api.fetch, async () => {
    // In Apple's billing grace period: Gold stays, with the period's own end on the profile.
    api.answers.push({ monthly: { expires_date: new Date(periodEnd).toISOString(), grace_period_expires_date: new Date(Date.now() + 10 * 86400000).toISOString(), period_type: 'normal' } });
    reset({ profile: lapsedStoreGold() });
    let res = await checkout('price_gold_monthly');
    assert.equal(res.statusCode, 409);
    assert.equal(res.body.reason, 'app_store_renewing');
    assert.equal(state.updates[0].subscription_expires_at, new Date(periodEnd).toISOString());
    assert.equal(state.created, undefined);

    // A renewal the webhook never got still runs.
    const renewed = Date.now() + 25 * 86400000;
    api.answers.push({ monthly: { expires_date: new Date(renewed).toISOString(), period_type: 'normal' } });
    reset({ profile: lapsedStoreGold() });
    res = await checkout('price_gold_monthly');
    assert.equal(res.statusCode, 409);
    assert.equal(res.body.reason, 'has_plan');
    assert.equal(state.updates[0].subscription_expires_at, new Date(renewed).toISOString());

    // A web subscription whose renewal is past due answers with the payment issue.
    reset({ profile: lapsedStoreGold(), subscriptions: [{ id: 'sub_1', customer: 'cus_1', status: 'past_due', items: goldItems }] });
    res = await checkout('price_gold_monthly');
    assert.equal(res.statusCode, 409);
    assert.equal(res.body.reason, 'payment_issue');
    assert.deepEqual(state.updates[0], { subscription_tier: 'gold', subscription_status: 'past_due', trial_end: null, subscription_expires_at: null });

    // Nothing running: the profile goes to free and checkout opens, with no
    // free week after the App Store plan RevenueCat still lists.
    api.answers.push({ monthly: { expires_date: new Date(periodEnd).toISOString(), period_type: 'normal' } });
    reset({ profile: lapsedStoreGold() });
    res = await checkout('price_gold_monthly');
    assert.equal(res.statusCode, 200);
    assert.deepEqual(state.updates[0], { subscription_tier: 'free', subscription_status: null, trial_end: null, subscription_expires_at: null });
    assert.equal(res.body.trial, false);

    // Gold whose expiry is still ahead is turned away without asking.
    const asked = api.calls.length;
    reset({ profile: { ...lapsedStoreGold(), subscription_expires_at: new Date(Date.now() + 86400000).toISOString() } });
    res = await checkout('price_gold_monthly');
    assert.equal(res.statusCode, 409);
    assert.equal(res.body.reason, 'has_plan');
    assert.equal(api.calls.length, asked);
  });

  // RevenueCat can't be read: a try-again answer, a lifetime checkout too,
  // though that never looks back for a free week.
  await withRevenueCat('rc-rest-test-key', revenueCatApi([], { status: 500 }).fetch, async () => {
    reset({ profile: lapsedStoreGold() });
    const res = await checkout('price_gold_lifetime');
    assert.equal(res.statusCode, 503);
    assert.match(res.body.error, /Try again/);
    assert.deepEqual(state.updates, []);
    assert.equal(state.created, undefined);
  });
});

test('with the RevenueCat key set, an App Store trial the record never saw still rules out the web free week', async () => {
  const lapsedTrial = () => ({ monthly: { expires_date: new Date(Date.now() - 60 * 86400000).toISOString(), period_type: 'trial' } });
  const api = revenueCatApi();
  await withRevenueCat('rc-rest-test-key', api.fetch, async () => {
    for (const customer of ['cus_1', null]) {
      api.answers.push(lapsedTrial());
      reset({ profile: { stripe_customer_id: customer } });
      const res = await checkout('price_gold_monthly');
      assert.equal(res.statusCode, 200, String(customer));
      assert.equal(res.body.trial, false, String(customer));
    }
    assert.deepEqual(api.calls, [1, 2].map(() => `https://api.revenuecat.com/v1/subscribers/${USER}`));

    // Nothing listed: the free week stands.
    reset({ profile: { stripe_customer_id: 'cus_1' } });
    assert.equal((await checkout('price_gold_monthly')).body.trial, true);

    // An earlier web subscription rules out the week, whatever RevenueCat lists.
    reset({ profile: { stripe_customer_id: 'cus_1' }, subscriptions: [{ id: 'sub_old', customer: 'cus_1', status: 'canceled', items: goldItems }] });
    assert.equal((await checkout('price_gold_monthly')).body.trial, false);
  });
});

test('an unpaid Gold subscription has its open invoices voided and is cancelled before a new checkout opens', async () => {
  const unpaid = () => ({ id: 'sub_unpaid', customer: 'cus_1', status: 'unpaid', items: goldItems });
  const invoices = () => [
    { id: 'in_retried', subscription: 'sub_unpaid', status: 'open' },
    { id: 'in_since', subscription: 'sub_unpaid', status: 'open' },
    { id: 'in_paid', subscription: 'sub_unpaid', status: 'paid' },
    { id: 'in_other', subscription: 'sub_other', status: 'open' },
  ];
  reset({ profile: { stripe_customer_id: 'cus_1', subscription_tier: 'free', subscription_status: 'unpaid' }, subscriptions: [unpaid()], invoices: invoices() });
  const res = await checkout('price_gold_monthly');
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.trial, false, 'no second free week');
  assert.deepEqual(state.voided, ['in_retried', 'in_since']);
  assert.deepEqual(state.cancelled.map((x) => x.id), ['sub_unpaid']);
  const calls = state.stripeCalls;
  assert.ok(calls.lastIndexOf('invoices.voidInvoice') < calls.indexOf('subscriptions.cancel'), 'voided before it is cancelled');
  assert.ok(calls.indexOf('subscriptions.cancel') < calls.indexOf('checkout.sessions.create'), 'cancelled before the new checkout opens');

  // A void or a cancel that fails stops checkout with a try-again answer.
  for (const [label, over] of [['a void fails', { voidFails: true }], ['the cancel fails', { cancelFails: true }]]) {
    reset({ profile: { stripe_customer_id: 'cus_1' }, subscriptions: [unpaid()], invoices: invoices(), ...over });
    const failed = await checkout('price_gold_monthly');
    assert.equal(failed.statusCode, 503, label);
    assert.match(failed.body.error, /Try again/, label);
    assert.equal(state.created, undefined, label);
    if (over.voidFails) assert.deepEqual(state.cancelled, [], 'nothing is cancelled while an invoice could still be paid');
  }
});

test('every 409 from checkout says why, so the web can act on it', async () => {
  const cases = [
    ['a Gold profile', { profile: { stripe_customer_id: 'cus_1', subscription_tier: 'gold' } }, 'has_plan'],
    ['a Lifetime profile', { profile: { stripe_customer_id: 'cus_1', subscription_tier: 'lifetime' } }, 'has_plan'],
    ['a live web plan', { profile: { stripe_customer_id: 'cus_1' }, subscriptions: [{ id: 'sub_1', customer: 'cus_1', status: 'active', items: goldItems }] }, 'has_plan'],
    ['a Gold profile past due', { profile: { stripe_customer_id: 'cus_1', subscription_tier: 'gold', subscription_status: 'past_due' } }, 'payment_issue'],
  ];
  for (const [label, over, reason] of cases) {
    reset(over);
    const res = await checkout('price_gold_monthly');
    assert.equal(res.statusCode, 409, label);
    assert.equal(res.body.reason, reason, label);
  }
});

const goldSub = (id, customer, status) => ({ id, customer, status, items: goldItems });

test('a paid-up Gold subscription counts over one past due, across customers and within one', async () => {
  // The profile's customer has a past due subscription, and an older customer an active one.
  const twoCustomers = () => ({
    profile: { stripe_customer_id: 'cus_1' },
    customers: [{ id: 'cus_gold', metadata: { supabase_user_id: USER } }],
    subscriptions: [goldSub('sub_due', 'cus_1', 'past_due'), goldSub('sub_live', 'cus_gold', 'active')],
  });
  reset(twoCustomers());
  assert.deepEqual((await askMyPlan('good-token')).body, { plan: 'gold', status: 'active', trial_end: null });
  reset(twoCustomers());
  const res = await checkout('price_gold_monthly');
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.reason, 'has_plan');
  reset(twoCustomers());
  assert.equal((await openPortal()).statusCode, 200);
  assert.equal(state.portal.customer, 'cus_gold');

  // One customer, its newer subscription past due and the older one active.
  reset({ profile: { stripe_customer_id: 'cus_1' }, subscriptions: [goldSub('sub_new', 'cus_1', 'past_due'), goldSub('sub_old', 'cus_1', 'active')] });
  assert.equal((await askMyPlan('good-token')).body.status, 'active');
});

test('the billing page opens on a paid-up Gold subscription first, then one past due, then the plan, and an unpaid one only as a last resort', async () => {
  const unpaid = goldSub('sub_unpaid', 'cus_1', 'unpaid');
  const cases = [
    ['a subscription in its free week elsewhere', { subscriptions: [unpaid, goldSub('sub_live', 'cus_other', 'trialing')] }, 'cus_other'],
    ['one past due elsewhere', { subscriptions: [unpaid, goldSub('sub_due', 'cus_other', 'past_due')] }, 'cus_other'],
    ['lifetime elsewhere', { subscriptions: [unpaid], sessions: [{ ...lifetimeSession('pi_life'), customer: 'cus_other' }], charges: { pi_life: { refunded: false } } }, 'cus_other'],
    ['past due here and lifetime elsewhere, so the card can be fixed', { subscriptions: [goldSub('sub_due', 'cus_1', 'past_due')], sessions: [{ ...lifetimeSession('pi_life'), customer: 'cus_other' }], charges: { pi_life: { refunded: false } } }, 'cus_1'],
    ['nothing else', { subscriptions: [unpaid] }, 'cus_1'],
  ];
  for (const [label, over, customer] of cases) {
    reset({ profile: { stripe_customer_id: 'cus_1' }, customers: [{ id: 'cus_other', metadata: { supabase_user_id: USER } }], ...over });
    assert.equal((await openPortal()).statusCode, 200, label);
    assert.equal(state.portal.customer, customer, label);
  }
});

test('a past due update for one Gold subscription leaves the profile on a paid-up one the account also holds', async () => {
  reset({
    profile: { id: USER, subscription_tier: 'gold', subscription_status: 'active', stripe_customer_id: 'cus_1' },
    customers: [{ id: 'cus_gold', metadata: { supabase_user_id: USER } }],
    subscriptions: [goldSub('sub_old', 'cus_1', 'past_due'), goldSub('sub_live', 'cus_gold', 'active')],
    subscriptionById: { sub_old: goldSub('sub_old', 'cus_1', 'past_due') },
  });
  const res = await stripeEvent(subscriptionEvent('customer.subscription.updated', 'past_due'));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(state.updates, [{ subscription_tier: 'gold', subscription_status: 'active', trial_end: null }]);

  // With nothing else, past due is what the profile shows.
  reset({
    profile: { id: USER, subscription_tier: 'gold', subscription_status: 'active', stripe_customer_id: 'cus_1' },
    subscriptions: [goldSub('sub_old', 'cus_1', 'past_due')],
    subscriptionById: { sub_old: goldSub('sub_old', 'cus_1', 'past_due') },
  });
  await stripeEvent(subscriptionEvent('customer.subscription.updated', 'past_due'));
  assert.deepEqual(state.updates, [{ subscription_tier: 'gold', subscription_status: 'past_due', trial_end: null }]);
});

test('with the RevenueCat key set, checkout turns away an account RevenueCat shows holding an App Store plan, and puts the plan on the profile', async () => {
  const runsTo = Date.now() + 20 * 86400000;
  const monthly = { subscriber: { entitlements: { Gold: { product_identifier: 'stacktracker_gold_monthly', expires_date: new Date(runsTo).toISOString() } }, subscriptions: { stacktracker_gold_monthly: { expires_date: new Date(runsTo).toISOString(), period_type: 'normal' } } } };
  const lifetime = { subscriber: { entitlements: { Gold: { product_identifier: 'stacktracker_lifetime', expires_date: null } }, non_subscriptions: { stacktracker_lifetime: [{ id: 'p1', is_sandbox: false }] } } };
  const inGrace = { subscriber: { subscriptions: { stacktracker_gold_monthly: { expires_date: new Date(Date.now() - 86400000).toISOString(), grace_period_expires_date: new Date(Date.now() + 5 * 86400000).toISOString(), period_type: 'normal' } } } };
  const cases = [
    ['a running subscription', [monthly, monthly], 'price_gold_monthly', 'has_plan', { subscription_tier: 'gold', subscription_expires_at: new Date(runsTo).toISOString() }],
    ['lifetime, buying lifetime', [lifetime, lifetime], 'price_gold_lifetime', 'has_plan', { subscription_tier: 'lifetime' }],
    ['a subscription in its grace period', [inGrace, inGrace], 'price_gold_yearly', 'app_store_renewing', { subscription_tier: 'gold' }],
    ['a running subscription whose sync then fails', [monthly, 'fail'], 'price_gold_monthly', 'has_plan', {}],
  ];
  for (const [label, answers, price, reason, written] of cases) {
    // Checkout reads RevenueCat once, and the sync reads it again.
    await withRevenueCat('rc-rest-test-key', revenueCatApi(answers).fetch, async () => {
      reset({ profile: { stripe_customer_id: 'cus_1' } });
      const res = await checkout(price);
      assert.equal(res.statusCode, 409, label);
      assert.equal(res.body.reason, reason, label);
      assert.equal(state.created, undefined, label);
      assert.ok(!state.stripeCalls.includes('customers.create'), label);
      for (const [field, value] of Object.entries(written)) assert.equal(state.updates.at(-1)?.[field], value, `${label}: ${field}`);
    });
  }
});

// Runs fn with the console quiet. Node's test runner can fail to read a log
// line written just after a timer fires, as a timed-out read's warning is.
async function quietly(fn) {
  const before = { log: console.log, warn: console.warn, error: console.error };
  for (const name of Object.keys(before)) console[name] = () => {};
  try {
    return await fn();
  } finally {
    Object.assign(console, before);
  }
}

test("a RevenueCat read that fails or runs slow stops checkout before anything is made in Stripe", async () => {
  const before = router.revenueCatRead.timeoutMs;
  router.revenueCatRead.timeoutMs = 50;
  try {
    for (const [label, options] of [['RevenueCat answers 500', { status: 500 }], ['RevenueCat is slow', { hang: true }]]) {
      await withRevenueCat('rc-rest-test-key', revenueCatApi([], options).fetch, async () => {
        for (const price of ['price_gold_monthly', 'price_gold_lifetime']) {
          reset({ profile: { stripe_customer_id: 'cus_1' } });
          const res = await quietly(() => checkout(price));
          assert.equal(res.statusCode, 503, `${label}, ${price}`);
          assert.match(res.body.error, /Try again/, `${label}, ${price}`);
          assert.ok(!state.stripeCalls.includes('customers.create'), `${label}, ${price}: no customer made`);
          assert.ok(!state.stripeCalls.includes('checkout.sessions.create'), `${label}, ${price}: no checkout opened`);
        }
      });
    }
  } finally {
    router.revenueCatRead.timeoutMs = before;
  }
});

test("with no RevenueCat key set, checkout goes on without the App Store read", async () => {
  reset({ profile: { stripe_customer_id: 'cus_1' } });
  const res = await checkout('price_gold_monthly');
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.trial, true);
});

test("a Stripe deletion waits for the account's turn, so an App Store renewal that lands first keeps Gold", async () => {
  const webhook = require('../src/routes/revenuecat-webhook');
  const before = { ...webhook.accountTurn };
  webhook.accountTurn.pollMs = 5;
  try {
    reset({ profile: { id: USER, subscription_tier: 'gold', subscription_status: 'active', stripe_customer_id: 'cus_1', subscription_expires_at: null } });
    const turnKey = `revenuecat_turn:${USER}`;
    state.appState[turnKey] = { until: new Date(Date.now() + 60 * 1000).toISOString(), owner: 'renewal' };
    const res = webhookRes();
    const done = router.stripeWebhookHandler({ headers: { 'stripe-signature': 'sig' }, body: Buffer.from(JSON.stringify(subscriptionEvent('customer.subscription.deleted', 'canceled'))) }, res);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(state.updates.length, 0, 'nothing is written while RevenueCat holds the turn');
    // The renewal lands and gives the turn back.
    state.profile.subscription_expires_at = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    delete state.appState[turnKey];
    await done;
    assert.equal(res.statusCode, 200);
    assert.equal(state.updates.length, 0, 'the App Store plan keeps Gold');
    assert.equal(state.appState[turnKey], undefined, 'the turn is given back');
  } finally {
    Object.assign(webhook.accountTurn, before);
  }
});

test('web Gold whose Stripe plan is gone is checked again when the RevenueCat key is set', async () => {
  const stale = { stripe_customer_id: 'cus_1', subscription_tier: 'gold', subscription_status: 'active', subscription_expires_at: null };
  reset({ profile: { ...stale } });
  let res = await checkout('price_gold_monthly');
  assert.equal(res.statusCode, 409, 'without the key it could be an older App Store plan');
  assert.equal(res.body.reason, 'has_plan');
  await withRevenueCat('rc-rest-test-key', revenueCatApi([]).fetch, async () => {
    reset({ profile: { ...stale } });
    res = await quietly(() => checkout('price_gold_monthly'));
    assert.equal(res.statusCode, 200, 'nothing in Stripe or the App Store, so checkout opens');

    reset({ profile: { ...stale }, subscriptions: [{ status: 'active', items: { data: [{ price: { id: 'price_gold_monthly', product: 'prod_gold' } }] } }] });
    res = await quietly(() => checkout('price_gold_monthly'));
    assert.equal(res.statusCode, 409, 'a live web plan still turns it away');
    assert.equal(res.body.reason, 'has_plan');
  });
});

// The daily reconcile: web Gold whose Stripe deletion never arrived.
const reconcileSub = (status, extra = {}) => ({ status, items: { data: [{ price: { id: 'price_gold_monthly', product: 'prod_gold' } }] }, ...extra });
// RevenueCat answers with nothing for the account unless answers are given.
const reconcile = (opts, answers = []) => withRevenueCat('rc-rest-test-key', revenueCatApi(answers).fetch, () => router.reconcileWebGold(opts));
const webGold = (over = {}) => ({ subscription_tier: 'gold', subscription_status: 'active', trial_end: null, stripe_customer_id: 'cus_1', subscription_expires_at: null, ...over });

test('reconcile ends web Gold when Stripe holds no live subscription', async () => {
  reset({ profile: webGold(), subscriptions: [reconcileSub('canceled')] });
  const result = await reconcile();
  assert.deepEqual(state.updates, [{ subscription_tier: 'free', subscription_status: null, trial_end: null }]);
  assert.equal(result.ended, 1);
  assert.equal(result.checked, 1);
});

test('reconcile leaves web Gold alone while Stripe still bills it', async () => {
  reset({ profile: webGold(), subscriptions: [reconcileSub('active')] });
  const result = await reconcile();
  assert.equal(state.updates.length, 0);
  assert.equal(result.skipped, 1);
});

test('reconcile moves a finished free week to active', async () => {
  reset({ profile: webGold({ subscription_status: 'trialing', trial_end: '2026-10-10T00:00:00.000Z' }), subscriptions: [reconcileSub('active')] });
  const result = await reconcile();
  assert.deepEqual(state.updates, [{ subscription_tier: 'gold', subscription_status: 'active', trial_end: null }]);
  assert.equal(result.updated, 1);
});

test('reconcile gives lifetime when a paid lifetime checkout outlasts the subscription', async () => {
  reset({
    profile: webGold(),
    subscriptions: [reconcileSub('canceled')],
    sessions: [{ mode: 'payment', status: 'complete', payment_status: 'paid', metadata: { tier: 'lifetime' }, payment_intent: 'pi_1' }],
    charge: { refunded: false },
  });
  await reconcile();
  assert.deepEqual(state.updates, [{ subscription_tier: 'lifetime', subscription_status: 'active', trial_end: null }]);
});

test('reconcile never reads Stripe for Gold with an App Store expiry', async () => {
  reset({ profile: webGold({ subscription_expires_at: '2026-01-01T00:00:00.000Z' }), subscriptions: [] });
  const result = await reconcile();
  assert.equal(state.updates.length, 0);
  assert.equal(state.stripeCalls.length, 0);
  assert.equal(result.skipped, 1);
});

test('reconcile keeps Gold the App Store record still holds', async () => {
  reset({ profile: webGold(), subscriptions: [], appState: { [`revenuecat_grant:${USER}`]: { subscriptionUntil: Date.now() + 86400000 } } });
  const result = await reconcile();
  assert.equal(state.updates.length, 0);
  assert.equal(result.skipped, 1);
});

test('reconcile changes nothing when Stripe can\'t be read', async () => {
  reset({ profile: webGold(), subscriptionsFail: true });
  const result = await reconcile();
  assert.equal(state.updates.length, 0);
  assert.equal(result.failed, 1);
});

test('reconcile stops ending plans past its limit for one run', async () => {
  reset({ profile: webGold(), subscriptions: [] });
  const result = await reconcile({ maxEndings: 0 });
  assert.equal(state.updates.length, 0);
  assert.equal(result.stopped, true);
});

test('reconcile runs once a UTC day, whichever instance claims it first', async () => {
  reset({ profile: webGold(), subscriptions: [] });
  const now = new Date('2026-10-19T09:40:00.000Z');
  const first = await reconcile({ now });
  assert.equal(first.ended, 1);
  state.profile = webGold();
  state.updates = [];
  const second = await quietly(() => reconcile({ now: new Date('2026-10-19T09:40:05.000Z') }));
  assert.equal(second.alreadyRan, true, 'a second instance on the same schedule stands down');
  assert.equal(second.checked, 0);
  assert.equal(state.updates.length, 0);
  const nextDay = await reconcile({ now: new Date('2026-10-20T09:40:00.000Z') });
  assert.equal(nextDay.ended, 1, 'the next day runs');
});

test('reconcile doesn\'t run when the day can\'t be claimed', async () => {
  reset({ profile: webGold(), subscriptions: [], turnError: { message: 'connection reset' } });
  await assert.rejects(reconcile(), /Run claim failed/);
  assert.equal(state.updates.length, 0);
});

test('reconcile never lists lifetime or free profiles', async () => {
  reset({ profile: webGold({ subscription_tier: 'lifetime' }), subscriptions: [] });
  const result = await reconcile();
  assert.equal(result.checked, 0);
  assert.equal(state.updates.length, 0);
});

test('reconcile throws when the profile list fails', async () => {
  reset({ profile: webGold(), listError: { message: 'connection reset' } });
  await assert.rejects(reconcile(), /Profile list failed/);
  assert.equal(state.updates.length, 0);
});

test('reconcile keeps Gold RevenueCat lists as running', async () => {
  reset({ profile: webGold(), subscriptions: [] });
  const result = await reconcile({}, [{ monthly: { expires_date: new Date(Date.now() + 86400000).toISOString(), period_type: 'normal' } }]);
  assert.equal(state.updates.length, 0);
  assert.equal(result.skipped, 1);
});

test('reconcile keeps Gold when RevenueCat can\'t be asked', async () => {
  reset({ profile: webGold(), subscriptions: [] });
  const result = await withRevenueCat(null, null, () => router.reconcileWebGold());
  assert.equal(state.updates.length, 0);
  assert.equal(result.skipped, 1);
});

test('reconcile changes nothing when RevenueCat fails', async () => {
  reset({ profile: webGold(), subscriptions: [] });
  const result = await reconcile({}, ['fail']);
  assert.equal(state.updates.length, 0);
  assert.equal(result.failed, 1);
});

test('a checkout landing while the reconcile holds the account waits its turn', async () => {
  reset({ profile: webGold(), subscriptions: [], appState: { [`revenuecat_turn:${USER}`]: { until: new Date(Date.now() + 60000).toISOString(), owner: 'reconcile' } } });
  const res = webhookRes();
  const { accountTurn } = require('../src/routes/revenuecat-webhook');
  const waitMs = accountTurn.waitMs;
  accountTurn.waitMs = 200;
  try {
    const event = { type: 'checkout.session.completed', data: { object: { id: 'cs_1', client_reference_id: USER, customer: 'cus_1', mode: 'payment', payment_status: 'paid', metadata: { tier: 'lifetime' }, payment_intent: 'pi_1' } } };
    state.charge = { refunded: false };
    await router.stripeWebhookHandler({ headers: { 'stripe-signature': 'sig' }, body: Buffer.from(JSON.stringify(event)) }, res);
  } finally {
    accountTurn.waitMs = waitMs;
  }
  assert.equal(res.statusCode, 500);
  assert.equal(state.updates.length, 0);
});
