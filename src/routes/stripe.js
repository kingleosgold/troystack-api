const crypto = require('node:crypto');
const express = require('express');
const supabase = require('../lib/supabase');
const { safeRedirect, cleanCampaign, signedInUserId, liveSubscriptions, subscriptionTier, paidLifetimeSessions, soldLifetime } = require('../lib/stripe-checks');
const { appStorePlanOnRecord, hadAppStorePlan } = require('./revenuecat-webhook');

const router = express.Router();

// Initialize Stripe (conditionally)
const stripe = process.env.STRIPE_SECRET_KEY
  ? require('stripe')(process.env.STRIPE_SECRET_KEY)
  : null;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const STRIPE_GOLD_MONTHLY_PRICE_ID = process.env.STRIPE_GOLD_MONTHLY_PRICE_ID;
const STRIPE_GOLD_YEARLY_PRICE_ID = process.env.STRIPE_GOLD_YEARLY_PRICE_ID;
const STRIPE_GOLD_LIFETIME_PRICE_ID = process.env.STRIPE_GOLD_LIFETIME_PRICE_ID;

if (!stripe) {
  console.warn('⚠️ Stripe disabled: missing STRIPE_SECRET_KEY');
}

// ============================================
// HELPERS
// ============================================

function isUUID(str) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str);
}

function mapStripePriceToTier(priceId) {
  if (!priceId) return 'free';
  if (priceId === STRIPE_GOLD_LIFETIME_PRICE_ID) return 'lifetime';
  if (priceId === STRIPE_GOLD_MONTHLY_PRICE_ID) return 'gold';
  if (priceId === STRIPE_GOLD_YEARLY_PRICE_ID) return 'gold';
  return 'free';
}

function isLifetimePrice(priceId) {
  return priceId === STRIPE_GOLD_LIFETIME_PRICE_ID;
}

// The products the Gold prices belong to, read from Stripe and kept for six
// hours. A subscriber on an older Gold price still counts, and a subscription
// to anything else in the account never does. A failed read throws rather
// than caching half the list, so nobody gets a confident answer from it.
const GOLD_PRODUCT_TTL_MS = 6 * 60 * 60 * 1000;
let goldProductCache = { at: 0, ids: new Set() };
async function goldProductIds() {
  if (goldProductCache.ids.size > 0 && Date.now() - goldProductCache.at < GOLD_PRODUCT_TTL_MS) return goldProductCache.ids;
  const configured = [STRIPE_GOLD_MONTHLY_PRICE_ID, STRIPE_GOLD_YEARLY_PRICE_ID, STRIPE_GOLD_LIFETIME_PRICE_ID].filter(Boolean);
  if (configured.length === 0) throw new Error('No Gold prices are configured');
  const ids = new Set();
  for (const priceId of configured) {
    const price = await stripe.prices.retrieve(priceId);
    const product = typeof price.product === 'string' ? price.product : price.product?.id;
    if (product) ids.add(product);
  }
  goldProductCache = { at: Date.now(), ids };
  return ids;
}

function resetGoldProductCache() {
  goldProductCache = { at: 0, ids: new Set() };
}
// For tests. Set on the router, which is what this module exports.
router.resetGoldProductCache = resetGoldProductCache;

// The plan a subscription's price gives: a configured Gold price, or another
// price on the Gold product. Anything else gives free. Throws when the Gold
// product can't be read, since that isn't an answer.
async function tierForSubscriptionPrice(price) {
  const mapped = price?.id ? mapStripePriceToTier(price.id) : 'free';
  if (mapped !== 'free') return mapped;
  return subscriptionTier(price, mapStripePriceToTier, await goldProductIds()) || 'free';
}

// The tier for a completed checkout's subscription. When the Gold product
// can't be read, the tier this API wrote on the session when it opened the
// checkout stands, since it only opens checkouts for Gold prices. A session
// without one is retried rather than recorded as free.
async function tierForCheckout(session, price) {
  try {
    return await tierForSubscriptionPrice(price);
  } catch (e) {
    const recorded = session.metadata?.tier;
    if (recorded === 'gold' || recorded === 'lifetime') {
      console.warn(`⚠️ [Stripe] Gold product unreadable, keeping the session's ${recorded}:`, e.message);
      return recorded;
    }
    throw e;
  }
}

// Every record a Stripe list holds, newest first, a page at a time. A history
// longer than this reads throws, since stopping partway isn't an answer.
async function* everyRecord(list, params, { pageSize = 100, maxPages = 10 } = {}) {
  let startingAfter;
  for (let page = 0; page < maxPages; page += 1) {
    const res = await list({ ...params, limit: pageSize, ...(startingAfter ? { starting_after: startingAfter } : {}) });
    const data = res.data || [];
    for (const record of data) yield record;
    if (!res.has_more || data.length === 0) return;
    startingAfter = data[data.length - 1].id;
  }
  throw new Error(`More than ${pageSize * maxPages} Stripe records to check`);
}

// Every completed checkout for a customer. Abandoned checkouts aren't
// complete, so they never crowd out a purchase.
function completedCheckouts(customerId) {
  return everyRecord((p) => stripe.checkout.sessions.list(p), { customer: customerId, status: 'complete' });
}

// Every subscription a customer has had, whatever its status.
function customerSubscriptions(customerId) {
  return everyRecord((p) => stripe.subscriptions.list(p), { customer: customerId, status: 'all' });
}

// A checkout this API opened records its tier. A one-time checkout without one
// counts as lifetime only when it sold the lifetime price or a one-time price
// on the Gold product, so a payment for anything else in the account never
// becomes a plan.
async function isLifetimeCheckout(session) {
  const recorded = session.metadata?.tier;
  if (recorded) return recorded === 'lifetime';
  const items = [];
  for await (const item of everyRecord((p) => stripe.checkout.sessions.listLineItems(session.id, p), {})) items.push(item);
  if (soldLifetime(items, STRIPE_GOLD_LIFETIME_PRICE_ID, null)) return true;
  if (!items.some((item) => item?.price?.type === 'one_time')) return false;
  return soldLifetime(items, STRIPE_GOLD_LIFETIME_PRICE_ID, await goldProductIds());
}

// A chargeback that's open or lost holds the money back. An inquiry, a
// dispute status starting warning_, isn't a chargeback yet, and a won dispute
// gives the money back.
const CHARGEBACK_HOLDS = ['needs_response', 'under_review', 'lost'];

// A lifetime payment counts until it's refunded in full or a chargeback is
// opened on it, and counts again if the seller wins. Stripe leaves a charge
// marked unrefunded when a dispute is lost, so a disputed charge has its
// disputes read.
async function lifetimeStillPaid(session) {
  const intentId = typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id;
  if (!intentId) return true;
  const intent = await stripe.paymentIntents.retrieve(intentId, { expand: ['latest_charge'] });
  const charge = intent.latest_charge;
  if (!charge || typeof charge !== 'object') return true;
  if (charge.refunded) return false;
  if (charge.disputed) {
    const disputes = await stripe.disputes.list({ payment_intent: intentId, limit: 100 });
    if ((disputes.data || []).some((d) => CHARGEBACK_HOLDS.includes(d.status))) return false;
  }
  return true;
}

// What Stripe says a customer paid for, or null. Lifetime comes first, since
// it outlasts any subscription the customer also has. It's a one-time payment
// with no subscription, so it counts when any paid lifetime checkout is still
// paid. Otherwise a live subscription to a Gold price or product gives Gold,
// and a subscription to anything else gives nothing. Both histories are read
// to the end.
async function planFromStripe(customerId) {
  for await (const checkout of completedCheckouts(customerId)) {
    const [session] = paidLifetimeSessions([checkout]);
    if (!session || !(await isLifetimeCheckout(session))) continue;
    if (await lifetimeStillPaid(session)) return { tier: 'lifetime', status: 'active', trialEnd: null };
  }

  let products = null;
  for await (const sub of customerSubscriptions(customerId)) {
    const [live] = liveSubscriptions([sub]);
    if (!live) continue;
    const price = live.items?.data?.[0]?.price;
    if (!products && mapStripePriceToTier(price?.id) === 'free') products = await goldProductIds();
    const tier = subscriptionTier(price, mapStripePriceToTier, products);
    if (tier) {
      return { tier, status: live.status, trialEnd: live.trial_end ? new Date(live.trial_end * 1000).toISOString() : null };
    }
  }
  return null;
}

// Every Stripe customer made for an account. Checkout used to make a new
// customer each time, so an account can have several while the profile keeps
// only the latest. They're found by the supabase_user_id this API puts in a
// customer's metadata. Stripe's search can lag a minute behind, so the
// profile's own customer is always included. With strict, a search that fails
// throws, since an answer from one customer of several isn't an answer.
async function customersFor(userId, profileCustomerId, { strict = false } = {}) {
  const ids = profileCustomerId ? [profileCustomerId] : [];
  try {
    let page;
    for (let n = 0; n < 3; n += 1) {
      const res = await stripe.customers.search({
        query: `metadata['supabase_user_id']:'${userId}'`,
        limit: 100,
        ...(page ? { page } : {}),
      });
      for (const c of res.data || []) if (c?.id && !ids.includes(c.id)) ids.push(c.id);
      if (!res.has_more || !res.next_page) break;
      page = res.next_page;
    }
  } catch (e) {
    if (strict) throw e;
    console.warn('⚠️ [Stripe] Customer search failed:', e.message);
  }
  return ids;
}

// Accounts whose profile has no customer and whose search found none, kept
// ten minutes, so asking about a free account again doesn't search Stripe
// every time.
const NO_CUSTOMER_TTL_MS = 10 * 60 * 1000;
const noCustomerSeen = new Map();
// For tests. Set on the router, which is what this module exports.
router.resetCustomerSearchCache = () => noCustomerSeen.clear();

// What Stripe holds for an account across all its customers. Lifetime on any
// of them wins, then the first live Gold subscription. A profile with no
// customer can still have one, when an older checkout's id never reached the
// profile, so the account's customers are searched for it too.
async function planForUser(userId, profileCustomerId) {
  let customers;
  if (profileCustomerId) {
    customers = await customersFor(userId, profileCustomerId, { strict: true });
  } else {
    const seen = noCustomerSeen.get(userId);
    if (seen && Date.now() - seen < NO_CUSTOMER_TTL_MS) return null;
    customers = await customersFor(userId, null, { strict: true });
    if (customers.length === 0) {
      if (noCustomerSeen.size > 10000) noCustomerSeen.clear();
      noCustomerSeen.set(userId, Date.now());
      return null;
    }
  }
  let found = null;
  for (const customerId of customers) {
    const plan = await planFromStripe(customerId);
    if (plan?.tier === 'lifetime') return { ...plan, customerId };
    if (plan && !found) found = { ...plan, customerId };
  }
  return found;
}

// What a profile should read once a plan it had ends: the plan Stripe still
// holds for the account, or free. A failed Stripe read throws, so the caller
// tries again rather than saving free over a plan that's still paid.
async function planAfterEnding(userId, customerId) {
  return (await planForUser(userId, customerId)) || { tier: 'free', status: null, trialEnd: null };
}

// The RevenueCat webhook asks the same question when an App Store plan ends,
// since the account may hold a plan bought on the web.
if (stripe) require('./revenuecat-webhook').setWebPlanCheck(planAfterEnding);

// What an account holds when a web lifetime payment stops counting, or counts
// again: any plan Stripe still holds, lifetime first, then a plan the App
// Store still owes it from the RevenueCat record, or free. A Stripe or record
// read that fails throws.
async function planWithoutLostLifetime(userId, customerId) {
  const web = await planForUser(userId, customerId);
  if (web) return web;
  return (await appStorePlanOnRecord(userId)) || { tier: 'free', status: null, trialEnd: null };
}

// The profile fields for such a plan. An App Store subscription keeps its
// expiry, so a web subscription ending later can see it still runs.
function profileFieldsFor(plan) {
  if (plan.source === 'app_store') {
    return {
      subscription_tier: plan.tier,
      subscription_status: 'active',
      trial_end: null,
      ...(plan.expiresAt ? { subscription_expires_at: new Date(plan.expiresAt).toISOString() } : {}),
    };
  }
  return { subscription_tier: plan.tier, subscription_status: plan.status ?? null, trial_end: plan.trialEnd ?? null };
}

// The completed lifetime checkout a payment was for, or null when it was for
// anything else, such as a subscription invoice.
async function lifetimeCheckoutFor(paymentIntentId) {
  const res = await stripe.checkout.sessions.list({ payment_intent: paymentIntentId, limit: 1 });
  const session = res.data?.[0];
  if (!session || session.mode !== 'payment' || !(await isLifetimeCheckout(session))) return null;
  return session;
}

// The account behind a Stripe customer: the profile that holds the customer,
// or, for a customer an earlier checkout made and the profile no longer
// holds, the account named in the customer's metadata.
// A profile read that failed throws, so the webhook answers 500 and Stripe
// sends the event again. No matching row (PGRST116) is an answer, not a failure.
function profileRead({ data, error }) {
  if (error && error.code !== 'PGRST116') throw new Error(`Profile read failed: ${error.message}`);
  return data || null;
}

async function profileForCustomer(customerId) {
  const byCustomer = profileRead(await supabase
    .from('profiles')
    .select('id, subscription_tier, stripe_customer_id, subscription_expires_at')
    .eq('stripe_customer_id', customerId)
    .single());
  if (byCustomer) return byCustomer;
  const customer = await stripe.customers.retrieve(customerId);
  const userId = customer?.metadata?.supabase_user_id;
  if (!userId || !isUUID(userId)) return null;
  return profileRead(await supabase
    .from('profiles')
    .select('id, subscription_tier, stripe_customer_id, subscription_expires_at')
    .eq('id', userId)
    .single());
}

// An App Store plan RevenueCat says still runs. Only the RevenueCat webhook
// writes subscription_expires_at, so a future one means Apple is still
// billing, and a web subscription that ends doesn't end that.
function appStorePlanRunning(profile) {
  const until = Date.parse(profile?.subscription_expires_at || '');
  return Number.isFinite(until) && until > Date.now() && profile.subscription_tier === 'gold';
}

// Lifetime outlasts anything a later checkout adds, so a profile that reads
// lifetime keeps it.
async function keepLifetime(userId, tier) {
  if (tier === 'lifetime') return tier;
  const data = profileRead(await supabase.from('profiles').select('subscription_tier').eq('id', userId).single());
  return data?.subscription_tier === 'lifetime' ? 'lifetime' : tier;
}

// Whether the account has had Gold before: an App Store trial or plan on the
// RevenueCat record, or a Gold subscription on any of its Stripe customers.
// The free week is for the first one only, so subscribing and cancelling
// inside the week can't be repeated, and an App Store trial isn't followed by
// a web one. A subscription whose first payment never went through doesn't
// count. With no customer yet, only the App Store record is read.
async function hadGoldBefore(userId, customerId) {
  if (await hadAppStorePlan(userId)) return true;
  if (!customerId) return false;
  let products = null;
  for (const id of await customersFor(userId, customerId, { strict: true })) {
    for await (const sub of customerSubscriptions(id)) {
      if (sub.status === 'incomplete' || sub.status === 'incomplete_expired') continue;
      const price = sub.items?.data?.[0]?.price;
      if (!products && mapStripePriceToTier(price?.id) === 'free') products = await goldProductIds();
      if (subscriptionTier(price, mapStripePriceToTier, products)) return true;
    }
  }
  return false;
}

// The answer for an account whose Gold renewal payment failed. Its
// subscription bills again once the card works, so a second checkout could
// leave it paying twice. The web shows this with a way to the billing page.
const PAYMENT_ISSUE = {
  error: "Your last Gold payment didn't go through. Update your card on the billing page in Settings to keep Gold.",
  reason: 'payment_issue',
};

// Whether a Gold subscription on any of the account's customers has a failed
// renewal: past_due while Stripe retries, or unpaid once the retries ran out
// and the invoice waits for a working card.
async function goldPaymentIssue(userId, customerId) {
  let products = null;
  for (const id of await customersFor(userId, customerId, { strict: true })) {
    for await (const sub of customerSubscriptions(id)) {
      if (sub.status !== 'past_due' && sub.status !== 'unpaid') continue;
      const price = sub.items?.data?.[0]?.price;
      if (!products && mapStripePriceToTier(price?.id) === 'free') products = await goldProductIds();
      if (subscriptionTier(price, mapStripePriceToTier, products)) return true;
    }
  }
  return false;
}

// The answer when checkout can't be sure it won't sell a second plan: a plan
// check or closing an earlier checkout didn't finish.
const CHECK_FAILED = { error: "Checkout couldn't check this account's plan. Try again in a moment." };

// A checkout left open in another tab could still be paid and start a second
// plan, so every open checkout on the account's customers is closed before a
// new one opens. A search, list or expiry that fails throws, and checkout
// stops rather than leave an earlier checkout that can still be paid.
async function closeOpenCheckouts(userId, customerId) {
  for (const id of await customersFor(userId, customerId, { strict: true })) {
    const open = [];
    for await (const session of everyRecord((p) => stripe.checkout.sessions.list(p), { customer: id, status: 'open' })) open.push(session);
    for (const session of open) await stripe.checkout.sessions.expire(session.id);
  }
}

// Two checkout requests for one account at once could both find no plan and
// no open checkout before either opens one, and paying both would start two
// subscriptions. So an account's requests take turns, in two layers. In this
// process they queue, each waiting for the one before it, and requests for
// different accounts don't wait on each other. Across instances, which
// Railway runs side by side during a deploy and could run for good, the turn
// is a row in app_state that only one request can insert. A request that
// finds another instance holding it is turned away rather than kept waiting.
const checkoutsRunning = new Map();
const CHECKOUT_TURN_TTL_MS = 2 * 60 * 1000;

// Takes the account's turn across instances, or answers null when another
// instance holds it. A turn left by a request that died, say in a deploy, runs
// out after two minutes and is cleared here. The answer is a function that
// gives the turn back, and a turn this request no longer owns is left alone.
// A database read or write that fails throws.
async function takeSharedCheckoutTurn(userId) {
  const key = `checkout_turn:${userId}`;
  const now = Date.now();
  const { error: clearError } = await supabase.from('app_state').delete().eq('key', key).lt('value->>until', new Date(now).toISOString());
  if (clearError) throw new Error(`checkout turn clear failed: ${clearError.message}`);
  const owner = crypto.randomUUID();
  const { error } = await supabase.from('app_state').insert({ key, value: { until: new Date(now + CHECKOUT_TURN_TTL_MS).toISOString(), owner } });
  if (error?.code === '23505') return null;
  if (error) throw new Error(`checkout turn failed: ${error.message}`);
  return async () => {
    const { error: releaseError } = await supabase.from('app_state').delete().eq('key', key).eq('value->>owner', owner);
    if (releaseError) console.warn('⚠️ [Stripe] Could not give back the checkout turn, it runs out on its own:', releaseError.message);
  };
}

// Waits for the account's turn in this process, then takes it across
// instances. Answers a function that ends the turn, or null when another
// instance holds it. Throws when the database can't take it.
async function checkoutTurn(userId) {
  const before = checkoutsRunning.get(userId);
  let finish;
  const running = new Promise((resolve) => {
    finish = resolve;
  });
  checkoutsRunning.set(userId, running);
  if (before) await before;
  const endHere = () => {
    finish();
    if (checkoutsRunning.get(userId) === running) checkoutsRunning.delete(userId);
  };
  let endShared;
  try {
    endShared = await takeSharedCheckoutTurn(userId);
  } catch (e) {
    endHere();
    throw e;
  }
  if (!endShared) {
    endHere();
    return null;
  }
  return async () => {
    try {
      await endShared();
    } finally {
      endHere();
    }
  };
}

// The customer the billing page opens on: one with a Gold subscription that's
// still billing, so it can be cancelled, then the one holding the plan, then
// the profile's own. A subscription to anything else in the account doesn't
// count, since its customer's billing page can't manage Gold. Gold means a
// configured Gold price or another price on the Gold product, as in
// planFromStripe. With no customer on the profile, the account's customers
// are found by search, and the answer is null when none of them is billing
// Gold or holds a plan.
async function portalCustomerFor(userId, profileCustomerId) {
  let products = null;
  for (const id of await customersFor(userId, profileCustomerId, { strict: true })) {
    for await (const sub of customerSubscriptions(id)) {
      if (!['active', 'trialing', 'past_due', 'unpaid'].includes(sub.status)) continue;
      const price = sub.items?.data?.[0]?.price;
      if (!products && mapStripePriceToTier(price?.id) === 'free') products = await goldProductIds();
      if (subscriptionTier(price, mapStripePriceToTier, products)) return id;
    }
  }
  const plan = await planForUser(userId, profileCustomerId);
  return plan?.customerId || profileCustomerId;
}

// ============================================
// WEBHOOK — MUST use express.raw() (handled in index.js)
// ============================================

// Standalone webhook handler — mounted directly in index.js before express.json()
async function stripeWebhookHandler(req, res) {
  try {
    if (!stripe) {
      return res.status(503).send('Stripe not configured');
    }

    const sig = req.headers['stripe-signature'];
    let event;

    try {
      event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
    } catch (err) {
      console.warn('⚠️ [Stripe Webhook] Signature verification failed:', err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    console.log(`💳 [Stripe Webhook] Event: ${event.type}`);

    switch (event.type) {
      // A delayed payment method completes the checkout first and is paid
      // later, so async_payment_succeeded is handled the same way.
      case 'checkout.session.completed':
      case 'checkout.session.async_payment_succeeded': {
        const session = event.data.object;
        const userId = session.client_reference_id || session.metadata?.user_id;
        if (!userId || !isUUID(userId)) {
          console.warn('⚠️ [Stripe Webhook] No valid user_id in checkout session');
          break;
        }

        let tier = session.metadata?.tier || 'gold';
        let subscriptionStatus = 'active';
        let trialEnd = null;

        // Anything that can't be read throws, the handler answers 500 and
        // Stripe sends the event again, rather than a wrong plan being saved.
        if (session.subscription) {
          const subscription = await stripe.subscriptions.retrieve(session.subscription);
          if (subscription.status !== 'active' && subscription.status !== 'trialing') {
            // A late event for a subscription that has already ended gives no
            // plan. Only the customer is recorded.
            const { error: idError } = await supabase.from('profiles').update({ stripe_customer_id: session.customer }).eq('id', userId);
            if (idError) {
              console.error('❌ [Stripe Webhook] Failed to record the customer:', idError.message);
              return res.status(500).send('Profile update failed');
            }
            console.log(`💳 [Stripe Webhook] Checkout ${session.id} completed for a subscription that is ${subscription.status}, plan left alone`);
            break;
          }
          const price = subscription.items?.data?.[0]?.price;
          if (price?.id) {
            tier = await tierForCheckout(session, price);
          }
          subscriptionStatus = subscription.status;
          if (subscription.trial_end) {
            trialEnd = new Date(subscription.trial_end * 1000).toISOString();
          }
        } else if (session.mode === 'payment') {
          // Nothing is given until the payment has gone through.
          if (session.payment_status !== 'paid') {
            console.log(`💳 [Stripe Webhook] Checkout ${session.id} isn't paid yet (${session.payment_status}), waiting for the payment`);
            break;
          }
          // A one-time checkout without a recorded tier is lifetime only when
          // it sold a lifetime Gold price. Anything else changes no plan, and
          // neither does a lifetime payment that has since been refunded.
          if (session.metadata?.tier) {
            tier = session.metadata.tier;
          } else if (await isLifetimeCheckout(session)) {
            tier = 'lifetime';
          } else {
            console.log(`💳 [Stripe Webhook] One-time checkout ${session.id} sold no Gold plan, profile left alone`);
            break;
          }
          if (tier === 'lifetime' && !(await lifetimeStillPaid(session))) {
            console.log(`💳 [Stripe Webhook] Lifetime checkout ${session.id} is no longer paid, profile left alone`);
            break;
          }
        }
        tier = await keepLifetime(userId, tier);
        if (tier === 'lifetime') {
          subscriptionStatus = 'active';
          trialEnd = null;
        }

        const { error } = await supabase
          .from('profiles')
          .update({
            subscription_tier: tier,
            stripe_customer_id: session.customer,
            subscription_status: subscriptionStatus,
            trial_end: trialEnd,
          })
          .eq('id', userId);

        // A failed write is answered 500 so Stripe sends the event again.
        if (error) {
          console.error('❌ [Stripe Webhook] Failed to update profile:', error.message);
          return res.status(500).send('Profile update failed');
        } else {
          console.log(`✅ [Stripe Webhook] checkout.session.completed: user=${userId}, tier=${tier}`);
        }
        break;
      }

      case 'customer.subscription.updated': {
        // Events can arrive late, and a retry repeats an older one, so the
        // subscription is read again and the plan follows where it stands now.
        const subscription = await stripe.subscriptions.retrieve(event.data.object.id);
        const customerId = typeof subscription.customer === 'string' ? subscription.customer : subscription.customer?.id;
        const profile = await profileForCustomer(customerId);

        if (profile) {
          // Don't downgrade lifetime users via subscription events
          if (profile.subscription_tier === 'lifetime') break;

          // A live subscription gives Gold only when it's to a Gold price or
          // product. A Gold product Stripe can't read throws, and the event
          // comes again. A past_due one is live: Gold stays, with status
          // past_due, while Stripe retries the failed renewal, so the account
          // isn't sent back to checkout to buy a second subscription. Unpaid,
          // after the retries run out, ends it.
          const live = liveSubscriptions([subscription]).length > 0;
          const price = subscription.items?.data?.[0]?.price;
          const goldNow = live && price?.id ? (await tierForSubscriptionPrice(price)) !== 'free' : false;
          let updateData;
          if (goldNow) {
            updateData = {
              subscription_tier: 'gold',
              subscription_status: subscription.status,
              trial_end: subscription.trial_end ? new Date(subscription.trial_end * 1000).toISOString() : null,
            };
          } else {
            // This subscription isn't Gold now, but the account may hold
            // another plan in Stripe, so the profile gets what Stripe still holds.
            const after = await planAfterEnding(profile.id, profile.stripe_customer_id || customerId);
            if (after.tier === 'free' && appStorePlanRunning(profile)) {
              console.log(`💳 [Stripe Webhook] subscription.updated: user=${profile.id} keeps the App Store plan running to ${profile.subscription_expires_at}`);
              break;
            }
            updateData = { subscription_tier: after.tier, subscription_status: after.status || subscription.status, trial_end: after.trialEnd };
          }
          const { error: updateError } = await supabase
            .from('profiles')
            .update(updateData)
            .eq('id', profile.id);
          if (updateError) {
            console.error('❌ [Stripe Webhook] Failed to update profile:', updateError.message);
            return res.status(500).send('Profile update failed');
          }
          console.log(`✅ [Stripe Webhook] subscription.updated: user=${profile.id}, tier=${updateData.subscription_tier}, status=${subscription.status}`);
        }
        break;
      }

      case 'customer.subscription.deleted': {
        const subscription = event.data.object;
        const customerId = subscription.customer;
        const profile = await profileForCustomer(customerId);

        if (profile) {
          if (profile.subscription_tier === 'lifetime') break;

          // The account may hold another plan in Stripe, a second Gold
          // subscription or lifetime, so the profile gets what Stripe still holds.
          const after = await planAfterEnding(profile.id, profile.stripe_customer_id || customerId);
          if (after.tier === 'free' && appStorePlanRunning(profile)) {
            console.log(`💳 [Stripe Webhook] subscription.deleted: user=${profile.id} keeps the App Store plan running to ${profile.subscription_expires_at}`);
            break;
          }
          const { error: updateError } = await supabase
            .from('profiles')
            .update({ subscription_tier: after.tier, subscription_status: after.status, trial_end: after.trialEnd })
            .eq('id', profile.id);
          if (updateError) {
            console.error('❌ [Stripe Webhook] Failed to update profile:', updateError.message);
            return res.status(500).send('Profile update failed');
          }
          console.log(`✅ [Stripe Webhook] subscription.deleted: user=${profile.id}, now ${after.tier}`);
        }
        break;
      }

      // A lifetime payment refunded in full, or under a chargeback, no longer
      // gives lifetime, and one whose chargeback the seller won gives it
      // back. The account's plan is worked out again from everything it
      // holds: another plan in Stripe, then what the App Store still owes it,
      // or free. A partial refund, an inquiry that isn't a chargeback yet, and
      // a payment for anything but a lifetime checkout change nothing.
      case 'charge.refunded':
      case 'charge.dispute.created':
      case 'charge.dispute.closed': {
        const object = event.data.object;
        const intentId = typeof object.payment_intent === 'string' ? object.payment_intent : object.payment_intent?.id;
        const session = intentId ? await lifetimeCheckoutFor(intentId) : null;
        if (!session) break;
        // The checkout names its account. An older one that doesn't is found
        // through its customer.
        const named = session.client_reference_id || session.metadata?.user_id;
        const sessionCustomer = typeof session.customer === 'string' ? session.customer : session.customer?.id;
        let profile = null;
        if (named && isUUID(named)) {
          profile = profileRead(await supabase.from('profiles').select('id, subscription_tier, stripe_customer_id').eq('id', named).single());
        } else if (sessionCustomer) {
          profile = await profileForCustomer(sessionCustomer);
        }
        if (!profile) break;
        const userId = profile.id || named;
        const plan = await planWithoutLostLifetime(userId, profile.stripe_customer_id || sessionCustomer);
        if ((profile.subscription_tier === 'lifetime') === (plan.tier === 'lifetime')) break;
        const { error: updateError } = await supabase.from('profiles').update(profileFieldsFor(plan)).eq('id', userId);
        if (updateError) {
          console.error('❌ [Stripe Webhook] Failed to update profile:', updateError.message);
          return res.status(500).send('Profile update failed');
        }
        console.log(`✅ [Stripe Webhook] ${event.type}: user=${userId}, lifetime payment ${plan.tier === 'lifetime' ? 'counts again' : 'no longer counts'}, now ${plan.tier}`);
        break;
      }

      case 'checkout.session.async_payment_failed': {
        const session = event.data.object;
        console.warn(`⚠️ [Stripe Webhook] The delayed payment for checkout ${session.id} failed, no plan given`);
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        console.warn(`⚠️ [Stripe Webhook] invoice.payment_failed: customer=${invoice.customer}, amount=${invoice.amount_due}`);
        break;
      }

      default:
        console.log(`💳 [Stripe Webhook] Unhandled event: ${event.type}`);
    }

    return res.json({ received: true });

  } catch (error) {
    console.error('❌ [Stripe Webhook] Error:', error.message);
    return res.status(500).send('Webhook handler error');
  }
}

// ============================================
// CHECKOUT + VERIFY + PORTAL
// ============================================

// POST /v1/stripe/create-checkout-session
router.post('/create-checkout-session', async (req, res) => {
  let endTurn = null;
  try {
    if (!stripe) {
      return res.status(503).json({ error: 'Stripe is not configured' });
    }

    const { user_id, price_id, success_url, cancel_url } = req.body;

    if (!user_id || !isUUID(user_id)) {
      return res.status(400).json({ error: 'Valid user_id is required' });
    }
    if (!price_id) {
      return res.status(400).json({ error: 'price_id is required' });
    }

    // Checkout opens only for the account that's signed in.
    const auth = await signedInUserId(req, supabase);
    if (auth.error) return res.status(auth.status).json({ error: auth.error });
    if (auth.userId !== user_id) {
      return res.status(403).json({ error: 'That account is not the one signed in' });
    }
    const campaign = cleanCampaign(req.body.campaign);

    // Checkout only sells Gold: a configured Gold price, or another recurring
    // price on the Gold product, sold as Gold. Lifetime sells only at its
    // configured price. Anything else is turned away, since a subscription to
    // it could later be mistaken for Gold.
    let tier = mapStripePriceToTier(price_id);
    const isLifetime = isLifetimePrice(price_id);
    if (tier === 'free') {
      let price = null;
      try {
        price = await stripe.prices.retrieve(price_id);
      } catch {
        // an unknown price id
      }
      const product = typeof price?.product === 'string' ? price.product : price?.product?.id;
      const products = await goldProductIds();
      if (!product || !products.has(product) || price.type !== 'recurring') {
        return res.status(400).json({ error: 'That price is not a TroyStack Gold plan' });
      }
      tier = 'gold';
    }

    // From the profile read to the new session, an account's requests run one
    // at a time, so a second request sees the first one's open checkout and
    // closes it, or sees its plan and answers 409. One that finds another
    // instance opening a checkout for the account is turned away.
    try {
      endTurn = await checkoutTurn(user_id);
    } catch (e) {
      console.error('❌ [Stripe] Could not take the checkout turn:', e.message);
      return res.status(500).json({ error: "Checkout didn't open. Try again in a moment." });
    }
    if (!endTurn) {
      return res.status(409).json({ error: 'A checkout for this account is already opening. Try again in a moment.', reason: 'checkout_in_progress' });
    }

    // The profile has no email column, so asking for one failed every time
    // and each checkout made a new Stripe customer. The profile is read for
    // its customer only. A missing row gets a bare one that never touches a
    // plan, and the email comes from the account. When that row can't be
    // made, checkout stops before anything is made in Stripe, since the
    // customer id would have nowhere to be saved.
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('stripe_customer_id, subscription_tier, subscription_status')
      .eq('id', user_id)
      .single();
    if (profileError && profileError.code !== 'PGRST116') {
      console.error('❌ [Stripe] Profile lookup failed:', profileError.message);
      return res.status(500).json({ error: "Checkout didn't open. Try again in a moment." });
    }
    if (!profile) {
      const { error: createError } = await supabase.from('profiles').upsert({ id: user_id }, { onConflict: 'id', ignoreDuplicates: true });
      if (createError) {
        console.error('❌ [Stripe] Could not make the profile row:', createError.message);
        return res.status(500).json({ error: "Checkout didn't open. Try again in a moment." });
      }
    }
    // An account the profile already shows on Gold or Lifetime, from the App
    // Store as much as the web, isn't sold a second plan. Gold kept while
    // Stripe retries a failed renewal answers with the payment issue.
    if (profile?.subscription_tier === 'gold' || profile?.subscription_tier === 'lifetime') {
      if (profile.subscription_tier === 'gold' && profile.subscription_status === 'past_due') return res.status(409).json(PAYMENT_ISSUE);
      return res.status(409).json({ error: 'This account already has Gold. You can manage it from Settings.' });
    }

    // A customer an earlier checkout made for this account is used again, so
    // purchases stay together. A new one is made only when there's none.
    // An account that already holds a live web plan isn't sold a second one,
    // and neither is one whose Gold renewal failed, since that subscription
    // bills again once the card works. The check covers the customer checkout
    // is about to use and every other one made for the account. A check that
    // can't finish stops checkout, since a plan it missed would be billed
    // twice.
    let customerId;
    let paymentIssue = false;
    let existing = null;
    try {
      customerId = profile?.stripe_customer_id || (await customersFor(user_id, null, { strict: true }))[0] || null;
      if (customerId) {
        paymentIssue = await goldPaymentIssue(user_id, customerId);
        if (!paymentIssue) existing = await planForUser(user_id, customerId);
      }
    } catch (e) {
      console.error('❌ [Stripe] Could not check for an existing plan:', e.message);
      return res.status(503).json(CHECK_FAILED);
    }
    if (paymentIssue) {
      return res.status(409).json(PAYMENT_ISSUE);
    }
    if (existing) {
      return res.status(409).json({ error: 'This account already has Gold. You can manage it from Settings.' });
    }

    const hadCustomer = Boolean(customerId);
    if (!customerId) {
      const { data: authUser, error: authError } = await supabase.auth.admin.getUserById(user_id);
      if (authError || !authUser?.user) {
        return res.status(404).json({ error: 'User not found' });
      }
      const customer = await stripe.customers.create({
        ...(authUser.user.email ? { email: authUser.user.email } : {}),
        metadata: { supabase_user_id: user_id },
      });
      customerId = customer.id;
    }
    if (customerId !== profile?.stripe_customer_id) {
      // The customer id is how a purchase is found again later, so checkout
      // doesn't open without it saved. An update that finds no row isn't an
      // error to the database, so the saved row is asked for back. A customer
      // made just now and not saved carries the user id in its metadata, so
      // later searches still find it.
      const { data: saved, error: saveError } = await supabase
        .from('profiles')
        .update({ stripe_customer_id: customerId })
        .eq('id', user_id)
        .select('id');
      if (saveError || !saved?.length) {
        console.error('❌ [Stripe] Could not save the customer id:', saveError ? saveError.message : 'no profile row');
        return res.status(500).json({ error: "Checkout didn't open. Try again in a moment." });
      }
    }

    // The free week is for an account's first Gold, on the web or the App
    // Store. A check that fails gives the week, as checkout always did. A
    // customer made just now has no Stripe history and no open checkouts, so
    // only the App Store record is read for it.
    let firstGold = true;
    if (!isLifetime) {
      try {
        firstGold = !(await hadGoldBefore(user_id, hadCustomer ? customerId : null));
      } catch (e) {
        console.warn('⚠️ [Stripe] Could not check for an earlier subscription:', e.message);
      }
    }
    if (hadCustomer) {
      try {
        await closeOpenCheckouts(user_id, customerId);
      } catch (e) {
        console.error('❌ [Stripe] Could not close an open checkout:', e.message);
        return res.status(503).json(CHECK_FAILED);
      }
    }

    const sessionParams = {
      mode: isLifetime ? 'payment' : 'subscription',
      customer: customerId,
      line_items: [{ price: price_id, quantity: 1 }],
      success_url: safeRedirect(success_url, 'https://troystack.ai/settings?session_id={CHECKOUT_SESSION_ID}'),
      cancel_url: safeRedirect(cancel_url, 'https://troystack.ai/settings'),
      client_reference_id: user_id,
      metadata: campaign ? { user_id, tier, campaign } : { user_id, tier },
    };

    if (isLifetime) {
      sessionParams.invoice_creation = { enabled: true };
    }

    if (!isLifetime && (firstGold || campaign)) {
      sessionParams.subscription_data = {
        ...(firstGold
          ? {
              trial_period_days: 7,
              trial_settings: {
                end_behavior: { missing_payment_method: 'cancel' },
              },
            }
          : {}),
        ...(campaign ? { metadata: { campaign } } : {}),
      };
    }

    const session = await stripe.checkout.sessions.create(sessionParams);

    console.log(`💳 [Stripe] Checkout session created for user ${user_id}, tier=${tier}${!isLifetime && !firstGold ? ', no trial (had Gold before)' : ''}`);
    return res.json({ url: session.url, trial: !isLifetime && firstGold });

  } catch (error) {
    console.error('❌ [Stripe] Create checkout error:', error.message);
    return res.status(500).json({ error: error.message });
  } finally {
    if (endTurn) await endTurn();
  }
});

// POST /v1/stripe/verify-session
router.post('/verify-session', async (req, res) => {
  try {
    if (!stripe) {
      return res.status(503).json({ error: 'Stripe is not configured' });
    }

    const { session_id } = req.body;
    if (!session_id || typeof session_id !== 'string') {
      return res.status(400).json({ error: 'session_id is required' });
    }

    const session = await stripe.checkout.sessions.retrieve(session_id, {
      expand: ['subscription'],
    });

    const userId = session.client_reference_id || session.metadata?.user_id;
    if (!userId || !isUUID(userId)) {
      return res.status(400).json({ error: 'No valid user_id in session' });
    }

    const subscription = session.subscription;
    const subStatus = subscription?.status;
    const isPaid = session.payment_status === 'paid';
    const isTrialing = subStatus === 'trialing';
    const isActive = subStatus === 'active';

    if (!isPaid && !isTrialing && !isActive) {
      return res.json({ success: false, reason: 'Session not yet paid or trialing' });
    }

    let tier = session.metadata?.tier || 'gold';
    let subscriptionStatus = 'active';
    let trialEnd = null;

    // This route needs no sign-in, so an old session id opened again must not
    // bring back a plan that has since ended or been refunded.
    if (subscription) {
      if (!isTrialing && !isActive) {
        return res.json({ success: false, reason: 'That subscription has ended' });
      }
      const price = subscription.items?.data?.[0]?.price;
      if (price?.id) {
        tier = await tierForCheckout(session, price);
      }
      subscriptionStatus = subscription.status;
      if (subscription.trial_end) {
        trialEnd = new Date(subscription.trial_end * 1000).toISOString();
      }
    } else if (session.mode === 'payment') {
      if (session.metadata?.tier) {
        tier = session.metadata.tier;
      } else if (await isLifetimeCheckout(session)) {
        tier = 'lifetime';
      } else {
        return res.json({ success: false, reason: 'That checkout sold no TroyStack plan' });
      }
      if (tier === 'lifetime' && !(await lifetimeStillPaid(session))) {
        return res.json({ success: false, reason: 'That purchase was refunded' });
      }
    }
    tier = await keepLifetime(userId, tier);
    if (tier === 'lifetime') {
      subscriptionStatus = 'active';
      trialEnd = null;
    }

    const { error } = await supabase
      .from('profiles')
      .update({
        subscription_tier: tier,
        stripe_customer_id: session.customer,
        subscription_status: subscriptionStatus,
        trial_end: trialEnd,
      })
      .eq('id', userId);

    if (error) {
      console.error('❌ [Stripe Verify] Failed to update profile:', error.message);
      return res.status(500).json({ error: 'Failed to update subscription' });
    }

    console.log(`✅ [Stripe Verify] Session verified: user=${userId}, tier=${tier}, status=${subscriptionStatus}`);
    // The status tells the page whether a free week started, since only an
    // account's first Gold subscription gets one.
    return res.json({ success: true, tier, status: subscriptionStatus });

  } catch (error) {
    console.error('❌ [Stripe Verify] Error:', error.message);
    return res.status(500).json({ error: error.message });
  }
});

// POST /v1/stripe/customer-portal
router.post('/customer-portal', async (req, res) => {
  try {
    if (!stripe) {
      return res.status(503).json({ error: 'Stripe is not configured' });
    }

    const { user_id, return_url } = req.body;

    if (!user_id || !isUUID(user_id)) {
      return res.status(400).json({ error: 'Valid user_id is required' });
    }

    // The billing page shows payment details and can cancel a plan, so it
    // opens only for the account that's signed in.
    const auth = await signedInUserId(req, supabase);
    if (auth.error) return res.status(auth.status).json({ error: auth.error });
    if (auth.userId !== user_id) {
      return res.status(403).json({ error: 'That account is not the one signed in' });
    }

    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('stripe_customer_id')
      .eq('id', user_id)
      .single();

    // No profile row (PGRST116) means no customer on the profile, which the
    // search below can still make up for. Any other failure keeps this answer.
    if (profileError && profileError.code !== 'PGRST116') {
      return res.status(404).json({ error: 'No Stripe customer found for this user' });
    }

    // After older checkouts an account can have several customers, and the
    // profile may hold none of them when an older checkout's id never reached
    // it. The billing page opens on one with a subscription still billing, so
    // it can be cancelled even when lifetime sits on another, then on the one
    // that holds the plan. A profile with no customer has the account's
    // customers searched by the user id in their metadata.
    const profileCustomer = profile?.stripe_customer_id || null;
    let portalCustomer = profileCustomer;
    try {
      portalCustomer = await portalCustomerFor(user_id, profileCustomer);
    } catch (e) {
      // With no customer on the profile there's nothing to fall back on, and
      // a search that failed isn't an answer that there's none.
      if (!profileCustomer) throw e;
      console.warn('⚠️ [Stripe] Could not find the customer holding the plan:', e.message);
    }
    if (!portalCustomer) {
      return res.status(404).json({ error: 'No Stripe customer found for this user' });
    }

    const session = await stripe.billingPortal.sessions.create({
      customer: portalCustomer,
      return_url: safeRedirect(return_url, 'https://troystack.ai/settings'),
    });

    console.log(`💳 [Stripe] Customer portal session created for user ${user_id}`);
    return res.json({ url: session.url });

  } catch (error) {
    console.error('❌ [Stripe] Customer portal error:', error.message);
    return res.status(500).json({ error: error.message });
  }
});

// GET /v1/stripe/my-plan
// The web plan Stripe holds for the signed-in account. A plan bought on
// troystack.ai lives in Stripe, not RevenueCat, so the iPhone app asks here
// before it treats an account with no App Store plan as free. Answers
// { plan: 'gold' | 'lifetime' | null, status, trial_end }.
router.get('/my-plan', async (req, res) => {
  try {
    const auth = await signedInUserId(req, supabase);
    if (auth.error) return res.status(auth.status).json({ error: auth.error });
    // Without Stripe the plan can't be checked, which is not the same as none.
    if (!stripe) return res.status(503).json({ error: 'Could not check the web plan' });

    const { data: profile, error } = await supabase
      .from('profiles')
      .select('stripe_customer_id')
      .eq('id', auth.userId)
      .single();
    // No profile row is a confirmed answer of no web plan. Any other failure
    // isn't, so the app hears that it couldn't be checked and leaves the
    // account alone.
    if (error && error.code !== 'PGRST116') {
      console.error('❌ [Stripe] my-plan profile lookup failed:', error.message);
      return res.status(503).json({ error: 'Could not check the web plan' });
    }
    const found = await planForUser(auth.userId, profile?.stripe_customer_id || null);
    if (!found) return res.json({ plan: null, status: null, trial_end: null });
    return res.json({ plan: found.tier, status: found.status, trial_end: found.trialEnd });
  } catch (error) {
    console.error('❌ [Stripe] my-plan error:', error.message);
    return res.status(500).json({ error: 'Could not check the web plan' });
  }
});

// GET /sync-subscription?user_id=xxx — mounted at /v1 in index.js
router.get('/sync-subscription', async (req, res) => {
  try {
    const { user_id } = req.query;

    if (!user_id || !isUUID(user_id)) {
      return res.status(400).json({ error: 'Valid user_id is required' });
    }

    const { data: profile, error } = await supabase
      .from('profiles')
      .select('subscription_tier, subscription_status, stripe_customer_id')
      .eq('id', user_id)
      .single();

    if (error || !profile) {
      return res.status(404).json({ error: 'User not found' });
    }

    let tier = profile.subscription_tier || 'free';
    let status = profile.subscription_status || null;

    // The iPhone app writes its own tier to the profile, and when RevenueCat
    // has nothing for someone it writes free, even over Gold or Lifetime they
    // paid for on the web. Stripe is the record for web plans, so a free
    // profile with a live subscription or a paid lifetime purchase gets it
    // back here. The answer only changes once the profile update succeeds.
    if (tier === 'free' && stripe) {
      try {
        const restored = await planForUser(user_id, profile.stripe_customer_id || null);
        if (restored) {
          // A profile that lost its customer id gets back the one holding the plan.
          const { error: updateError } = await supabase
            .from('profiles')
            .update({
              subscription_tier: restored.tier,
              subscription_status: restored.status,
              trial_end: restored.trialEnd,
              ...(profile.stripe_customer_id ? {} : { stripe_customer_id: restored.customerId }),
            })
            .eq('id', user_id);
          if (updateError) {
            console.error(`[Sync Subscription] Could not restore ${restored.tier} for ${user_id}:`, updateError.message);
          } else {
            tier = restored.tier;
            status = restored.status;
            console.log(`🔁 [Sync Subscription] Restored ${tier} from Stripe for ${user_id}`);
          }
        }
      } catch (healErr) {
        console.error('[Sync Subscription] Stripe check failed:', healErr.message);
      }
    }

    return res.json({
      user_id,
      subscription_tier: tier,
      subscription_status: status,
    });

  } catch (error) {
    console.error('❌ [Sync Subscription] Error:', error.message);
    return res.status(500).json({ error: 'Failed to fetch subscription status' });
  }
});

module.exports = router;
module.exports.stripeWebhookHandler = stripeWebhookHandler;
// The RevenueCat webhook lives in its own module. index.js still imports it from here.
module.exports.revenueCatWebhookHandler = require('./revenuecat-webhook').revenueCatWebhookHandler;
