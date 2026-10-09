// RevenueCat webhook: App Store purchases and their changes land on profiles.
//
// POST /v1/webhooks/revenuecat, mounted in index.js, and POST
// /v1/revenuecat/sync, which brings the signed-in account's App Store plan
// over from RevenueCat's REST API.
//
// Once migration 006 guards the plan columns, the iPhone app can no longer
// write its own plan, so this is the only way an App Store plan reaches
// profiles. That puts these duties on it:
//   - cover every event that changes what someone owns, including the
//     one-time lifetime purchase RevenueCat reports as NON_RENEWING_PURCHASE
//   - refuse calls that don't carry the shared secret, and refuse everything
//     when the secret isn't set, since a plan write here can't be undone by
//     the guard
//   - answer 500 when a profile read or write fails, so RevenueCat retries
//     instead of the purchase being lost
//   - reach purchases that don't arrive under the account's id: a guest's
//     purchase, through the event's aliases or the sync the app calls after
//     signing in, and purchases a restore moved to another account (TRANSFER)
//
// Sandbox subscriptions are applied too. App Review buys in the sandbox, a
// reviewer who pays has to get the server side of Gold, and a sandbox
// subscription runs out on its own. A sandbox lifetime purchase costs a
// TestFlight tester nothing and would never run out, so it's applied only for
// the accounts listed in REVENUECAT_SANDBOX_LIFETIME_USERS.
//
// TRANSFER doesn't say what moved, so every account on both sides is read from
// RevenueCat's REST API with REVENUECAT_SECRET_KEY and gets the plan RevenueCat
// now holds for it. Without the key it's logged so it can be settled by hand.
//
// When an App Store plan ends, by expiry or refund, the account may still hold
// another plan: one bought on troystack.ai, which stripe.js hands this module a
// check for, or another App Store plan on record. The profile gets that plan
// before it gets free.
//
// RevenueCat retries a delivery that failed, and events can arrive out of
// order. For each account, app_state keeps the purchase time of the newest
// App Store purchase on record, so a refund or a subscription grant that
// arrives late can't end or replace a newer period, and of the latest
// purchase a refund ended, so a grant for it that arrives late can't give it
// back. It also keeps what the App Store still owes the account, the latest
// subscription expiry and whether a lifetime purchase stands, so one plan
// ending doesn't take another away.

const crypto = require('node:crypto');
const supabase = require('../lib/supabase');

function isUUID(str) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str);
}

function mapProductToTier(productId) {
  if (!productId) return 'free';
  const pid = String(productId).toLowerCase();
  if (pid.includes('lifetime')) return 'lifetime';
  if (pid.includes('gold') || pid.includes('premium') || pid.includes('yearly') || pid.includes('monthly')) return 'gold';
  return 'free';
}

/** Events that mean the subscriber owns the product from now on. */
const GRANTS = new Set([
  'INITIAL_PURCHASE',
  'RENEWAL',
  'PRODUCT_CHANGE',
  'UNCANCELLATION',
  'NON_RENEWING_PURCHASE',
  'SUBSCRIPTION_EXTENDED',
  // Apple reversed a refund, so what was refunded is owned again.
  'REFUND_REVERSED',
]);

// RevenueCat grants up to a day of access when it can't validate a purchase
// with the store. That event names no product, so the profile gets Gold for
// the day, marked with this status. INITIAL_PURCHASE replaces it once the
// purchase validates, and the EXPIRATION that follows a failed validation
// ends it whatever product that event names.
const TEMPORARY = 'temporary_grant';
const TEMPORARY_MS = 24 * 60 * 60 * 1000;

function sameSecret(given, secret) {
  const a = Buffer.from(String(given));
  const b = Buffer.from(String(secret));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * RevenueCat sends the dashboard's Authorization value as is, so it may or
 * may not start with "Bearer ". Either form matches the secret.
 */
function authorized(header, secret) {
  if (!secret || !header) return false;
  const raw = String(header);
  return sameSecret(raw, secret) || sameSecret(raw.replace(/^Bearer\s+/i, ''), secret);
}

// Whether an account may have a sandbox lifetime purchase applied: it's listed
// in REVENUECAT_SANDBOX_LIFETIME_USERS, account ids separated by commas or
// spaces. List the App Review account there when review tests Lifetime.
function sandboxLifetimeAllowed(id) {
  const listed = String(process.env.REVENUECAT_SANDBOX_LIFETIME_USERS || '').split(/[\s,]+/).filter(Boolean);
  return listed.some((entry) => entry.toLowerCase() === String(id).toLowerCase());
}

function sandboxLifetimeBlocked(event, id) {
  if (event.environment !== 'SANDBOX' || sandboxLifetimeAllowed(id)) return false;
  console.warn(`[RevenueCat Webhook] Sandbox lifetime ${event.type} for ${id} not applied. List the account in REVENUECAT_SANDBOX_LIFETIME_USERS to allow it.`);
  return true;
}

// What Stripe still holds for an account, set by stripe.js when Stripe is
// configured. Called as check(userId, stripeCustomerId), it answers
// { tier, status, trialEnd } with tier 'free' when there's nothing, and throws
// when Stripe can't be read. The customer id is null when the profile has
// none, and the check then searches the account's customers for the user id
// stripe.js puts in their metadata.
let webPlanCheck = null;
function setWebPlanCheck(check) {
  webPlanCheck = typeof check === 'function' ? check : null;
}

async function readProfile(id) {
  const { data, error } = await supabase
    .from('profiles')
    .select('subscription_tier, subscription_status, subscription_expires_at, stripe_customer_id')
    .eq('id', id)
    .maybeSingle();
  if (error) throw new Error(`profile read failed: ${error.message}`);
  return data;
}

async function writeProfile(id, fields) {
  const { error } = await supabase.from('profiles').update(fields).eq('id', id);
  if (error) throw new Error(`profile update failed: ${error.message}`);
}

// A purchase for an account with no profile row yet makes a bare one first,
// as checkout does, so the purchase isn't dropped. A row that can't be made
// throws, and RevenueCat sends the event again.
async function profileForPurchase(id) {
  const profile = await readProfile(id);
  if (profile) return profile;
  const { error } = await supabase.from('profiles').upsert({ id }, { onConflict: 'id', ignoreDuplicates: true });
  if (error) throw new Error(`profile create failed: ${error.message}`);
  return (await readProfile(id)) || { subscription_tier: null, subscription_status: null, subscription_expires_at: null, stripe_customer_id: null };
}

// Each account's record is kept in app_state under this key as
// { purchasedAt, endedAt, subscriptionUntil, lifetime }:
//   - purchasedAt, the purchase time in ms of the newest App Store purchase
//     on record
//   - endedAt, the purchase time of the latest one a refund ended
//   - subscriptionUntil, when the latest App Store subscription period on
//     record ends, until it's refunded or expires
//   - lifetime, true while an App Store lifetime purchase stands
// Any of them can be missing.
function grantKey(id) {
  return `revenuecat_grant:${id}`;
}

// A time in ms, or null when it isn't a positive number.
function positiveMs(value) {
  const ms = Number(value);
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

// The account's record, with null or false for what isn't on it. A read that
// fails throws, so the event is answered 500 and sent again.
async function readRecord(id) {
  const { data, error } = await supabase.from('app_state').select('value').eq('key', grantKey(id)).maybeSingle();
  if (error) throw new Error(`purchase record read failed: ${error.message}`);
  let value = data?.value;
  // Stored as text, the value comes back as a JSON string.
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      value = null;
    }
  }
  return {
    purchasedAt: positiveMs(value?.purchasedAt),
    endedAt: positiveMs(value?.endedAt),
    subscriptionUntil: positiveMs(value?.subscriptionUntil),
    lifetime: value?.lifetime === true,
  };
}

// Saves the record, leaving out what's empty. A write that fails throws.
async function writeRecord(id, record) {
  const value = {};
  if (record.purchasedAt != null) value.purchasedAt = record.purchasedAt;
  if (record.endedAt != null) value.endedAt = record.endedAt;
  if (record.subscriptionUntil != null) value.subscriptionUntil = record.subscriptionUntil;
  if (record.lifetime) value.lifetime = true;
  const { error } = await supabase.from('app_state').upsert({ key: grantKey(id), value }, { onConflict: 'key' });
  if (error) throw new Error(`purchase record write failed: ${error.message}`);
}

// Reads the record, hands a copy to change, and saves what comes back only
// when something changed.
async function updateRecord(id, change) {
  const record = await readRecord(id);
  const next = change({ ...record });
  const same = ['purchasedAt', 'endedAt', 'subscriptionUntil', 'lifetime'].every((field) => next[field] === record[field]);
  if (!same) await writeRecord(id, next);
}

// Records a grant once its plan is on the profile, or once lifetime is kept
// over it: its purchase time, unless a newer one is already on record, which
// a late or repeated event finds; a subscription's expiry, when it's later
// than the one on record; and a lifetime purchase. A reversed refund also
// wipes the record of a refund ending this purchase or an older one, so the
// purchase it gives back is treated like any other from then on. A read or
// write that fails throws and RevenueCat sends the event again, and the
// profile write it repeats does no harm.
async function recordGrant(id, { purchasedAtMs, until = null, lifetime = false, reversesRefund = false }) {
  const at = positiveMs(purchasedAtMs);
  const ends = positiveMs(until);
  if (at == null && ends == null && !lifetime) return;
  await updateRecord(id, (record) => {
    if (at != null && (record.purchasedAt == null || record.purchasedAt < at)) record.purchasedAt = at;
    if (reversesRefund && at != null && record.endedAt != null && record.endedAt <= at) record.endedAt = null;
    if (ends != null && (record.subscriptionUntil == null || record.subscriptionUntil < ends)) record.subscriptionUntil = ends;
    if (lifetime) record.lifetime = true;
    return record;
  });
}

// Records that a refund ended a purchase, once the profile no longer has it,
// so a grant for it that RevenueCat sends again afterwards, on a retry or out
// of order, gives nothing back. The later of this purchase and any refunded
// one already on record is kept, and the newest purchase on record stays as
// it is. What was refunded, the lifetime purchase or the subscription, no
// longer counts as owed. A read or write that fails throws and RevenueCat
// sends the refund again, and the profile write it repeats does no harm.
async function recordEnd(id, purchasedAtMs, { lifetime }) {
  const at = positiveMs(purchasedAtMs);
  await updateRecord(id, (record) => {
    if (at != null && (record.endedAt == null || record.endedAt < at)) record.endedAt = at;
    if (lifetime) record.lifetime = false;
    else record.subscriptionUntil = null;
    return record;
  });
}

// A subscription period that ended comes off the record, unless a later
// period is already on it.
async function endSubscriptionOnRecord(id, expiresMs) {
  await updateRecord(id, (record) => {
    if (record.subscriptionUntil != null && (expiresMs == null || record.subscriptionUntil <= expiresMs)) record.subscriptionUntil = null;
    return record;
  });
}

// Whether a purchase newer than this one is on record for the account.
// Without a purchase time on the event or a record, there's no telling, so no.
async function newerGrantApplied(id, purchasedAtMs) {
  const at = positiveMs(purchasedAtMs);
  if (at == null) return false;
  const { purchasedAt } = await readRecord(id);
  return purchasedAt != null && purchasedAt > at;
}

// Whether what's on record has overtaken a grant: a refund ended this
// purchase or a later one, or, unless the grant is lifetime, a newer purchase
// is on record. Without a purchase time on the event or a record, there's no
// telling, so no.
async function grantSuperseded(id, purchasedAtMs, { lifetime = false } = {}) {
  const at = positiveMs(purchasedAtMs);
  if (at == null) return false;
  const { purchasedAt, endedAt } = await readRecord(id);
  if (endedAt != null && at <= endedAt) return true;
  return !lifetime && purchasedAt != null && at < purchasedAt;
}

// What the record says the App Store still owes an account: lifetime, Gold
// until the subscription's period ends, or null. ignore leaves out what just
// ended, 'lifetime' or 'subscription'.
function storePlanOnRecord(record, ignore = null) {
  if (record.lifetime && ignore !== 'lifetime') return { tier: 'lifetime', source: 'app_store' };
  if (ignore !== 'subscription' && record.subscriptionUntil != null && record.subscriptionUntil > Date.now()) {
    return { tier: 'gold', source: 'app_store', expiresAt: record.subscriptionUntil };
  }
  return null;
}

// The plan an account is left with once an App Store plan ends: lifetime from
// troystack.ai or the App Store, then an App Store subscription still
// running, then a web subscription, or free. The App Store subscription comes
// before the web one because its expiry goes on the profile, which lets
// stripe.js see it when the web plan ends. A profile with no customer id is
// asked about too, since a customer an older checkout made can hold a paid web
// plan the profile never recorded. A Stripe or record read that fails throws,
// so the event is answered 500 and RevenueCat sends it again, rather than free
// being saved over a plan that's still paid.
async function planLeft(id, profile, { ignore = null } = {}) {
  const web = webPlanCheck ? await webPlanCheck(id, profile.stripe_customer_id || null) : null;
  const webPlan = web && (web.tier === 'gold' || web.tier === 'lifetime') ? web : null;
  if (webPlan?.tier === 'lifetime') return webPlan;
  const store = storePlanOnRecord(await readRecord(id), ignore);
  if (store) return store;
  return webPlan || { tier: 'free' };
}

function fieldsFor(plan) {
  if (plan.tier === 'free') return { subscription_tier: 'free', subscription_expires_at: null };
  if (plan.source === 'app_store') {
    return { subscription_tier: plan.tier, subscription_expires_at: plan.expiresAt ? new Date(plan.expiresAt).toISOString() : null };
  }
  return { subscription_tier: plan.tier, subscription_status: plan.status ?? null, trial_end: plan.trialEnd ?? null, subscription_expires_at: null };
}

// RevenueCat's REST API answers what a subscriber holds right now. The secret
// key comes from REVENUECAT_SECRET_KEY and never goes into a log or an answer.
const REVENUECAT_SUBSCRIBERS = 'https://api.revenuecat.com/v1/subscribers/';
const REVENUECAT_TIMEOUT_MS = 10 * 1000;

async function fetchSubscriber(appUserId) {
  const key = process.env.REVENUECAT_SECRET_KEY;
  if (!key) throw new Error('REVENUECAT_SECRET_KEY is not set');
  const res = await fetch(REVENUECAT_SUBSCRIBERS + encodeURIComponent(appUserId), {
    headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(REVENUECAT_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`RevenueCat answered ${res.status}`);
  const body = await res.json();
  return body?.subscriber || {};
}

// What the App Store holds for a subscriber now, read by product: whether a
// lifetime purchase stands, and when the latest Gold subscription that's
// still running ends, counting a billing grace period. A refunded purchase
// doesn't count, and a sandbox lifetime counts only for an account listed
// for it.
function storeHoldings(subscriber, id) {
  const now = Date.now();
  let lifetime = false;
  let until = null;
  for (const [productId, purchases] of Object.entries(subscriber.non_subscriptions || {})) {
    if (mapProductToTier(productId) !== 'lifetime') continue;
    for (const purchase of Array.isArray(purchases) ? purchases : []) {
      if (purchase?.refunded_at || (purchase?.is_sandbox && !sandboxLifetimeAllowed(id))) continue;
      lifetime = true;
    }
  }
  for (const [productId, sub] of Object.entries(subscriber.subscriptions || {})) {
    const tier = mapProductToTier(productId);
    if (!sub || sub.refunded_at || tier === 'free') continue;
    const ends = Math.max(Date.parse(sub.expires_date || '') || 0, Date.parse(sub.grace_period_expires_date || '') || 0);
    // A lifetime product sold as a subscription, as a promotional grant can
    // be, runs with no expiry.
    if (tier === 'lifetime') {
      if ((!sub.expires_date || ends > now) && (!sub.is_sandbox || sandboxLifetimeAllowed(id))) lifetime = true;
      continue;
    }
    if (ends > now && (until == null || ends > until)) until = ends;
  }
  return { lifetime, until };
}

// Reads what RevenueCat holds for an account and puts it on the record and on
// the profile, alongside any plan bought on troystack.ai. A temporary grant
// that's still running is left alone, since RevenueCat may not show it by
// product. A read or write that fails throws.
async function syncFromRevenueCat(id) {
  const store = storeHoldings(await fetchSubscriber(id), id);
  await updateRecord(id, (record) => {
    record.lifetime = store.lifetime;
    record.subscriptionUntil = store.until;
    return record;
  });
  const profile = await profileForPurchase(id);
  const temporaryRunning = profile.subscription_status === TEMPORARY && Date.parse(profile.subscription_expires_at || '') > Date.now();
  if (temporaryRunning && !store.lifetime && store.until == null) return { tier: profile.subscription_tier, temporary: true };
  const plan = await planLeft(id, profile);
  const fields = fieldsFor(plan);
  if (profile.subscription_status === TEMPORARY) fields.subscription_status = plan.tier === 'free' ? null : 'active';
  await writeProfile(id, fields);
  return plan;
}

// The account an event belongs to: its app_user_id when that's an account
// id, or else the one account id among the ids RevenueCat has joined to the
// buyer, so a guest's purchase reaches the account once the guest has signed
// in. More than one account id there is ambiguous, and nothing is applied.
function accountFor(event) {
  const id = event.app_user_id;
  if (id && isUUID(String(id))) return { account: String(id) };
  const named = new Set();
  for (const alias of [event.original_app_user_id, ...(Array.isArray(event.aliases) ? event.aliases : [])]) {
    if (typeof alias === 'string' && isUUID(alias)) named.add(alias);
  }
  if (named.size === 1) return { account: [...named][0] };
  if (named.size > 1) return { skipped: 'ambiguous_user' };
  return { skipped: !id || String(id).startsWith('$RCAnonymousID:') ? 'anonymous_user' : 'non_uuid_user' };
}

/**
 * Applies one event to the account's profile and says what it did. Throws
 * when the database can't be read or written, so the caller answers 500.
 */
async function applyEvent(event) {
  const type = event.type;
  const id = event.app_user_id;
  // A plan change reports the product it moved to separately.
  const productId = event.new_product_id || event.product_id;
  const tier = mapProductToTier(productId);
  const expiresMs = positiveMs(event.expiration_at_ms);
  const expires = expiresMs != null ? new Date(expiresMs).toISOString() : null;

  if (GRANTS.has(type)) {
    if (tier === 'free') return { skipped: 'unknown_product' };
    const lifetimeGrant = tier === 'lifetime' || type === 'NON_RENEWING_PURCHASE';
    if (lifetimeGrant && sandboxLifetimeBlocked(event, id)) return { skipped: 'sandbox_lifetime' };
    // RevenueCat retries a delivery that failed and can deliver events out of
    // order, so a grant can land after the expiry or refund that ended it. A
    // subscription whose expiry is already past has nothing left to give,
    // since the period it paid for is over, and that goes for a reversed
    // refund too. Lifetime never expires, and a grant that names no expiry
    // isn't held to this.
    if (tier !== 'lifetime' && expires && expiresMs <= Date.now()) {
      return { skipped: 'already_expired' };
    }
    // A purchase a refund already ended stays ended when one of its grants
    // comes late. A subscription grant older than the newest purchase on
    // record is a delayed or retried event for a period that's been replaced,
    // and applying it would pull subscription_expires_at back or rewrite the
    // plan. One with the same purchase time, like an UNCANCELLATION or
    // SUBSCRIPTION_EXTENDED for the current period, still applies. Lifetime
    // outranks any subscription however old its event is, so a lifetime
    // grant, NON_RENEWING_PURCHASE included, is held only to the refund check.
    // A reversed refund is held to neither. It's how a refunded purchase comes
    // back, and when the account bought again after the refund, the purchase
    // it gives back is older than the one on record. That newer purchase may
    // have been refunded or run out since, so skipping the reversal could
    // leave the account without what Apple gave back.
    if (type !== 'REFUND_REVERSED' && (await grantSuperseded(id, event.purchased_at_ms, { lifetime: lifetimeGrant }))) {
      return { skipped: 'superseded' };
    }
    const profile = await profileForPurchase(id);
    const grant = {
      purchasedAtMs: event.purchased_at_ms,
      until: tier === 'lifetime' ? null : expiresMs,
      lifetime: tier === 'lifetime',
      reversesRefund: type === 'REFUND_REVERSED',
    };
    // A subscription bought after lifetime doesn't replace it. It's kept on
    // record, so it still counts if the lifetime purchase is refunded.
    if (profile.subscription_tier === 'lifetime' && tier !== 'lifetime') {
      await recordGrant(id, grant);
      return { kept: 'lifetime' };
    }
    await writeProfile(id, {
      subscription_tier: tier,
      subscription_expires_at: tier === 'lifetime' ? null : expires,
      // A purchase that validated after a temporary grant isn't temporary now.
      ...(profile.subscription_status === TEMPORARY ? { subscription_status: 'active' } : {}),
    });
    await recordGrant(id, grant);
    return { tier };
  }

  if (type === 'TEMPORARY_ENTITLEMENT_GRANT') {
    const profile = await profileForPurchase(id);
    // An account that already has a plan keeps it as it is.
    if (profile.subscription_tier === 'gold' || profile.subscription_tier === 'lifetime') return { kept: profile.subscription_tier };
    const from = Number(event.event_timestamp_ms) || Date.now();
    await writeProfile(id, {
      subscription_tier: 'gold',
      subscription_status: TEMPORARY,
      subscription_expires_at: new Date(from + TEMPORARY_MS).toISOString(),
    });
    return { tier: 'gold', temporary: true };
  }

  if (type === 'CANCELLATION') {
    if (tier === 'free') return { skipped: 'unknown_product' };
    const refund = event.cancel_reason === 'CUSTOMER_SUPPORT';
    // A sandbox lifetime purchase is never applied for an account that isn't
    // listed, so its refund has nothing of theirs to end.
    if (refund && tier === 'lifetime' && sandboxLifetimeBlocked(event, id)) return { skipped: 'sandbox_lifetime' };
    const profile = await readProfile(id);
    if (!profile) return { skipped: 'no_profile' };
    // A refund ends what was refunded right away. Another plan still stands.
    if (refund) {
      // A refund can arrive late, or come again on a retry, after a renewal
      // or a new purchase has started a newer period, and then it ends
      // nothing. The expiry date can't show that, because RevenueCat reports
      // a refunded purchase's expiration_at_ms as the time of the refund. The
      // period end stored here is always later, so a refund of the current
      // period would look replaced too. RevenueCat sends this event for a
      // subscription only when its latest period is refunded, so a refund for
      // a purchase older than the newest one on record came late, and the
      // purchase times are compared. A lifetime purchase can be refunded any
      // time, so its refund always counts.
      if (tier !== 'lifetime' && (await newerGrantApplied(id, event.purchased_at_ms))) return { skipped: 'superseded' };
      if (tier === 'lifetime' || profile.subscription_tier !== 'lifetime') {
        const left = await planLeft(id, profile, { ignore: tier === 'lifetime' ? 'lifetime' : 'subscription' });
        await writeProfile(id, fieldsFor(left));
        await recordEnd(id, event.purchased_at_ms, { lifetime: tier === 'lifetime' });
        return { tier: left.tier, refunded: true };
      }
      // A refunded subscription leaves lifetime as it is, but it comes off
      // the record, so it can't keep Gold if the lifetime purchase is
      // refunded later.
      await recordEnd(id, event.purchased_at_ms, { lifetime: false });
      return { kept: 'lifetime' };
    }
    // Auto-renew turned off. The plan runs to the end of the period.
    if (profile.subscription_tier === 'lifetime') return { kept: 'lifetime' };
    await writeProfile(id, { subscription_expires_at: expires });
    return { expires };
  }

  if (type === 'EXPIRATION') {
    const profile = await readProfile(id);
    if (!profile) return { skipped: 'no_profile' };
    // A temporary grant whose purchase never validated ends, whatever
    // product the event names, and its status goes with it.
    if (profile.subscription_status === TEMPORARY) {
      const left = await planLeft(id, profile);
      await writeProfile(id, left.tier === 'free' ? { ...fieldsFor(left), subscription_status: null } : fieldsFor(left));
      return { tier: left.tier, temporary: true };
    }
    if (tier === 'free') return { skipped: 'unknown_product' };
    if (tier === 'lifetime') return { skipped: 'lifetime_does_not_expire' };
    // The period is over, so it comes off the record and can't keep Gold if
    // a lifetime purchase is refunded later.
    if (profile.subscription_tier === 'lifetime') {
      await endSubscriptionOnRecord(id, expiresMs);
      return { kept: 'lifetime' };
    }
    // A retried expiry that lands after a renewal or a new purchase is for a
    // period that's already been replaced, so it ends nothing.
    const stored = Date.parse(profile.subscription_expires_at || '');
    if (expires && Number.isFinite(stored) && stored > expiresMs) return { skipped: 'superseded' };
    await endSubscriptionOnRecord(id, expiresMs);
    const left = await planLeft(id, profile);
    await writeProfile(id, fieldsFor(left));
    return { tier: left.tier };
  }

  if (type === 'BILLING_ISSUE' || type === 'BILLING_ISSUE_DETECTED') {
    // Apple keeps the subscription in its grace period, and so do we.
    return { skipped: 'billing_issue' };
  }

  return { skipped: 'unhandled' };
}

// TRANSFER moves purchases between app user ids without saying what moved,
// so every account on both sides is read from RevenueCat and gets the plan it
// now holds. The account the purchases left loses them, and the one they
// reached gets them. A read or write that fails answers 500, and RevenueCat
// sends the event again.
async function applyTransfer(event, res) {
  const from = Array.isArray(event.transferred_from) ? event.transferred_from : [];
  const to = Array.isArray(event.transferred_to) ? event.transferred_to : [];
  const accounts = [...new Set([...from, ...to].filter((id) => typeof id === 'string' && isUUID(id)))];
  if (!process.env.REVENUECAT_SECRET_KEY || accounts.length === 0) {
    const why = accounts.length === 0 ? 'names no account' : 'needs REVENUECAT_SECRET_KEY to be read';
    console.warn(`[RevenueCat Webhook] TRANSFER from ${JSON.stringify(from)} to ${JSON.stringify(to)} ${why}, settle it by hand`);
    return res.status(200).json({ success: true, skipped: 'transfer' });
  }
  try {
    const plans = {};
    for (const id of accounts) plans[id] = (await syncFromRevenueCat(id)).tier;
    console.log(`[RevenueCat Webhook] TRANSFER settled: ${JSON.stringify(plans)}`);
    return res.status(200).json({ success: true, transfer: plans });
  } catch (err) {
    console.error('[RevenueCat Webhook] TRANSFER failed:', err.message);
    return res.status(500).json({ error: 'Could not record the event' });
  }
}

async function revenueCatWebhookHandler(req, res) {
  const secret = process.env.REVENUECAT_WEBHOOK_SECRET;
  if (!secret) {
    console.error('[RevenueCat Webhook] REVENUECAT_WEBHOOK_SECRET is not set, refusing the event');
    return res.status(503).json({ error: 'Webhook not configured' });
  }
  if (!authorized(req.headers?.authorization, secret)) {
    console.warn('[RevenueCat Webhook] Invalid authorization');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const event = req.body?.event || req.body || {};
  const type = event.type;
  const appUserId = event.app_user_id;
  console.log(`[RevenueCat Webhook] Event: ${type}, env: ${event.environment || '?'}, user: ${appUserId}, product: ${event.new_product_id || event.product_id}`);

  if (type === 'TRANSFER') return applyTransfer(event, res);
  const { account, skipped } = accountFor(event);
  if (!account) return res.status(200).json({ success: true, skipped });
  if (account !== appUserId) console.log(`[RevenueCat Webhook] ${type} for ${appUserId} goes to account ${account}, named in its aliases`);

  try {
    const outcome = await applyEvent({ ...event, app_user_id: account });
    console.log(`[RevenueCat Webhook] ${type} for ${account}: ${JSON.stringify(outcome)}`);
    return res.status(200).json({ success: true, ...outcome });
  } catch (err) {
    // RevenueCat retries a failed delivery, so a database blip doesn't lose a purchase.
    console.error(`[RevenueCat Webhook] ${type} for ${account} failed:`, err.message);
    return res.status(500).json({ error: 'Could not record the event' });
  }
}

// The account behind the request's Supabase session token, or null.
async function signedInAccount(req) {
  const header = req.headers?.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) return null;
  try {
    const { data, error } = await supabase.auth.getUser(token);
    return !error && data?.user?.id ? data.user.id : null;
  } catch {
    return null;
  }
}

// POST /v1/revenuecat/sync, for the signed-in account. A purchase made as a
// guest, or moved by a restore, can reach no webhook under the account's id,
// so the app calls this after Purchases.logIn and after a restore, and the
// account gets the plan RevenueCat holds for it. Answers { success, tier,
// expires_at }, 401 without a session, and 503 until REVENUECAT_SECRET_KEY
// is set.
async function revenueCatSyncHandler(req, res) {
  const id = await signedInAccount(req);
  if (!id) return res.status(401).json({ error: 'Sign in first' });
  if (!process.env.REVENUECAT_SECRET_KEY) {
    return res.status(503).json({ error: 'App Store sync is not set up' });
  }
  try {
    const plan = await syncFromRevenueCat(id);
    console.log(`[RevenueCat Sync] ${id}: ${plan.tier}`);
    return res.json({ success: true, tier: plan.tier, expires_at: plan.expiresAt ? new Date(plan.expiresAt).toISOString() : null });
  } catch (err) {
    console.error(`[RevenueCat Sync] ${id} failed:`, err.message);
    return res.status(500).json({ error: "Couldn't check the App Store plan. Try again in a moment." });
  }
}

// For stripe.js: the App Store plan the record says still stands for an
// account when a web plan ends, lifetime or Gold until a subscription's period
// ends, or null. A read that fails throws.
async function appStorePlanOnRecord(id) {
  return storePlanOnRecord(await readRecord(id));
}

// For stripe.js: whether the record shows the account has had an App Store
// plan, a trial included, so the web's free week isn't a second one. A read
// that fails throws.
async function hadAppStorePlan(id) {
  const record = await readRecord(id);
  return record.purchasedAt != null || record.endedAt != null || record.subscriptionUntil != null || record.lifetime;
}

module.exports = {
  revenueCatWebhookHandler,
  revenueCatSyncHandler,
  applyEvent,
  mapProductToTier,
  authorized,
  setWebPlanCheck,
  appStorePlanOnRecord,
  hadAppStorePlan,
};
