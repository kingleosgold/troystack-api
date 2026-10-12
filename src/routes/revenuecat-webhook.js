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
// The sync and TRANSFER also need the web plan check stripe.js hands in, since
// without it a plan bought on troystack.ai looks like nothing and would be
// written over. Until it's handed in, the sync answers 503 and TRANSFER is
// only logged.
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
// back. Subscriptions and lifetime keep those times apart, and an event is
// judged only against its own kind. It also keeps what the App Store still
// owes the account, the latest subscription expiry and whether a lifetime
// purchase stands, so one plan ending doesn't take another away.
//
// Where an event writes both the record and the profile, the record goes
// first. The checks a retry makes read the profile, which a failed write
// left as it was, or parts of the record whose answer the event's own record
// write doesn't change, so when the profile write fails and RevenueCat sends
// the event again, the retry takes the same path and finishes it.

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

// Events and syncs for one account take turns across every instance of the
// API. Each one reads the profile and the purchase record and then writes
// them, so two at once could each write over what the other just did: an
// expiry clearing a renewal that landed meanwhile, or a lifetime refund and a
// renewal each keeping half of the other's change. The turn is a row in
// app_state, revenuecat_turn:{id}, that only one request can insert, given
// back when the work is done. A turn left by a request that died runs out
// after ttlMs. A request that can't get the turn within waitMs throws, so the
// event is answered 500 and RevenueCat sends it again later. Tests shorten
// the wait.
const accountTurn = { ttlMs: 2 * 60 * 1000, waitMs: 5 * 1000, pollMs: 100 };

async function withAccountTurn(id, work) {
  const key = `revenuecat_turn:${id}`;
  const owner = crypto.randomUUID();
  const giveUpAt = Date.now() + accountTurn.waitMs;
  for (;;) {
    const until = new Date(Date.now() + accountTurn.ttlMs).toISOString();
    const { error } = await supabase.from('app_state').insert({ key, value: { until, owner } });
    if (!error) break;
    if (error.code !== '23505') throw new Error(`account turn failed: ${error.message}`);
    // Taken. A turn whose request died is cleared, and otherwise this waits.
    const { error: clearError } = await supabase.from('app_state').delete().eq('key', key).lt('value->>until', new Date(Date.now()).toISOString());
    if (clearError) throw new Error(`account turn clear failed: ${clearError.message}`);
    if (Date.now() >= giveUpAt) throw new Error('another event for this account is still being applied');
    await new Promise((resolve) => setTimeout(resolve, accountTurn.pollMs));
  }
  try {
    return await work();
  } finally {
    const { error } = await supabase.from('app_state').delete().eq('key', key).eq('value->>owner', owner);
    if (error) console.warn(`[RevenueCat Webhook] Couldn't give back the turn for ${id}, it runs out on its own:`, error.message);
  }
}

// Each account's record is kept in app_state under this key as
// { subscriptionPurchasedAt, subscriptionEndedAt, subscriptionReversedAt,
// subscriptionUntil, subscriptionTrial, graceUntil, lifetimePurchasedAt,
// lifetimeEndedAt, lifetimeReversedAt, lifetime, temporaryEndedAt, hadPlan }:
//   - subscriptionPurchasedAt, the purchase time in ms of the newest App
//     Store subscription purchase on record, a renewal included
//   - subscriptionEndedAt, the purchase time of the latest subscription
//     purchase a refund ended
//   - subscriptionReversedAt, the event time of the latest REFUND_REVERSED
//     for a subscription, so the refund it undid, sent again, ends nothing
//   - subscriptionUntil, when the latest App Store subscription period on
//     record ends, until it's refunded or expires
//   - subscriptionTrial, true while that period is a free trial
//   - graceUntil, when Apple's billing grace period after that period ends,
//     as the sync read it from RevenueCat. The period's own end stays in
//     subscriptionUntil and on the profile, so the EXPIRATION sent when the
//     grace period runs out still matches it.
//   - lifetimePurchasedAt, lifetimeEndedAt and lifetimeReversedAt, the same
//     three times for App Store lifetime purchases
//   - lifetime, true while an App Store lifetime purchase stands
//   - temporaryEndedAt, the event time of the latest expiry that ended a
//     temporary grant
//   - hadPlan, true once the sync has found RevenueCat listing a Gold
//     product for the account, running, expired or refunded
// Any of them can be missing.
function grantKey(id) {
  return `revenuecat_grant:${id}`;
}

// The record's purchase and refund times for each kind of App Store purchase.
const KIND_TIMES = {
  subscription: { purchased: 'subscriptionPurchasedAt', ended: 'subscriptionEndedAt', reversed: 'subscriptionReversedAt' },
  lifetime: { purchased: 'lifetimePurchasedAt', ended: 'lifetimeEndedAt', reversed: 'lifetimeReversedAt' },
};

// The kind of purchase a product's tier makes: lifetime, or a subscription.
function kindOf(tier) {
  return tier === 'lifetime' ? 'lifetime' : 'subscription';
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
    subscriptionPurchasedAt: positiveMs(value?.subscriptionPurchasedAt),
    subscriptionEndedAt: positiveMs(value?.subscriptionEndedAt),
    subscriptionReversedAt: positiveMs(value?.subscriptionReversedAt),
    subscriptionUntil: positiveMs(value?.subscriptionUntil),
    subscriptionTrial: value?.subscriptionTrial === true,
    graceUntil: positiveMs(value?.graceUntil),
    lifetimePurchasedAt: positiveMs(value?.lifetimePurchasedAt),
    lifetimeEndedAt: positiveMs(value?.lifetimeEndedAt),
    lifetimeReversedAt: positiveMs(value?.lifetimeReversedAt),
    lifetime: value?.lifetime === true,
    temporaryEndedAt: positiveMs(value?.temporaryEndedAt),
    hadPlan: value?.hadPlan === true,
  };
}

const RECORD_FIELDS = [
  'subscriptionPurchasedAt',
  'subscriptionEndedAt',
  'subscriptionReversedAt',
  'subscriptionUntil',
  'subscriptionTrial',
  'graceUntil',
  'lifetimePurchasedAt',
  'lifetimeEndedAt',
  'lifetimeReversedAt',
  'lifetime',
  'temporaryEndedAt',
  'hadPlan',
];

// Saves the record, leaving out what's empty. A write that fails throws.
async function writeRecord(id, record) {
  const value = {};
  for (const field of RECORD_FIELDS) {
    if (record[field] != null && record[field] !== false) value[field] = record[field];
  }
  // A trial or a grace period means nothing without the period it belongs to.
  if (value.subscriptionUntil == null) {
    delete value.subscriptionTrial;
    delete value.graceUntil;
  }
  const { error } = await supabase.from('app_state').upsert({ key: grantKey(id), value }, { onConflict: 'key' });
  if (error) throw new Error(`purchase record write failed: ${error.message}`);
}

// Reads the record, hands a copy to change, and saves what comes back only
// when something changed.
async function updateRecord(id, change) {
  const record = await readRecord(id);
  const next = change({ ...record });
  if (!RECORD_FIELDS.every((field) => next[field] === record[field])) await writeRecord(id, next);
}

// Records a grant, before its plan goes on the profile: its purchase time
// among purchases of its kind, unless a newer one is already on record, which
// a late or repeated event finds; a subscription's expiry, when it's later
// than the one on record; and a lifetime purchase. A reversed refund, given
// its event time as reversedAtMs, also wipes the record of a refund ending
// this purchase or an older one of its kind, so the purchase it gives back is
// treated like any other from then on, and keeps the latest reversal's time
// for its kind. A read or write that fails throws and RevenueCat sends the
// event again, and the record write it repeats changes nothing.
async function recordGrant(id, { kind, purchasedAtMs, until = null, trial = false, reversedAtMs = null }) {
  const at = positiveMs(purchasedAtMs);
  const ends = positiveMs(until);
  const reversedAt = positiveMs(reversedAtMs);
  if (at == null && ends == null && reversedAt == null && kind !== 'lifetime') return;
  const { purchased, ended, reversed } = KIND_TIMES[kind];
  await updateRecord(id, (record) => {
    if (at != null && (record[purchased] == null || record[purchased] < at)) record[purchased] = at;
    if (reversedAt != null) {
      if (at != null && record[ended] != null && record[ended] <= at) record[ended] = null;
      if (record[reversed] == null || record[reversed] < reversedAt) record[reversed] = reversedAt;
    }
    if (kind === 'lifetime') {
      record.lifetime = true;
      return record;
    }
    // Whether the period is a free trial goes with the period on record, and
    // a new period starts with no grace period.
    if (ends != null && (record.subscriptionUntil == null || record.subscriptionUntil <= ends)) {
      if (record.subscriptionUntil !== ends) record.graceUntil = null;
      record.subscriptionUntil = ends;
      record.subscriptionTrial = trial;
    }
    return record;
  });
}

// Records that a refund ended a purchase, before the profile drops it, so a
// grant for it that RevenueCat sends again afterwards, on a retry or out of
// order, gives nothing back. The later of this purchase and any refunded one
// of its kind already on record is kept, and the newest purchase on record
// stays as it is. What was refunded, the lifetime purchase or the
// subscription, no longer counts as owed. A read or write that fails throws
// and RevenueCat sends the refund again.
async function recordEnd(id, purchasedAtMs, kind) {
  const at = positiveMs(purchasedAtMs);
  const { ended } = KIND_TIMES[kind];
  await updateRecord(id, (record) => {
    if (at != null && (record[ended] == null || record[ended] < at)) record[ended] = at;
    if (kind === 'lifetime') {
      record.lifetime = false;
    } else {
      record.subscriptionUntil = null;
      record.subscriptionTrial = false;
      record.graceUntil = null;
    }
    return record;
  });
}

// A subscription period that ended comes off the record. An expiry for the
// newest subscription purchase on record, current, takes it off whatever its
// date, and otherwise the date decides, so a later period already on record
// stays.
async function endSubscriptionOnRecord(id, expiresMs, { current = false } = {}) {
  await updateRecord(id, (record) => {
    if (record.subscriptionUntil != null && (current || expiresMs == null || record.subscriptionUntil <= expiresMs)) {
      record.subscriptionUntil = null;
      record.subscriptionTrial = false;
      record.graceUntil = null;
    }
    return record;
  });
}

// Whether a refund is one a reversal already undid, sent again late: its
// event is older than the latest REFUND_REVERSED for its kind on record.
// Without an event time on the refund or a reversal on record, there's no
// telling, so no.
async function refundReversedSince(id, refundedAtMs, kind) {
  const at = positiveMs(refundedAtMs);
  if (at == null) return false;
  const reversedAt = (await readRecord(id))[KIND_TIMES[kind].reversed];
  return reversedAt != null && at < reversedAt;
}

// How a subscription event's purchase compares with the newest subscription
// purchase on record: 'older' or 'current', the same one or newer, and null
// when the event or the record has no purchase time, so there's no telling.
async function subscriptionPurchaseOrder(id, purchasedAtMs) {
  const at = positiveMs(purchasedAtMs);
  if (at == null) return null;
  const newest = (await readRecord(id)).subscriptionPurchasedAt;
  if (newest == null) return null;
  return at < newest ? 'older' : 'current';
}

// Whether a purchase of the same kind newer than this one is on record for
// the account. Without a purchase time on the event or a record, there's no
// telling, so no.
async function newerPurchaseOnRecord(id, purchasedAtMs, kind) {
  const at = positiveMs(purchasedAtMs);
  if (at == null) return false;
  const newest = (await readRecord(id))[KIND_TIMES[kind].purchased];
  return newest != null && newest > at;
}

// Whether what's on record for purchases of the grant's kind has overtaken
// it: a refund ended this purchase or a later one, or, when olderIsLate, a
// newer purchase is on record. Without a purchase time on the event or a
// record, there's no telling, so no.
async function grantSuperseded(id, purchasedAtMs, kind, { olderIsLate }) {
  const at = positiveMs(purchasedAtMs);
  if (at == null) return false;
  const record = await readRecord(id);
  const { purchased, ended } = KIND_TIMES[kind];
  if (record[ended] != null && at <= record[ended]) return true;
  return olderIsLate && record[purchased] != null && at < record[purchased];
}

// What the record says the App Store still owes an account: lifetime, Gold
// until the subscription's period ends or through a billing grace period
// after it, or null. The plan's expiry is the period's own end, so during a
// grace period it has passed. ignore leaves out what just ended, 'lifetime'
// or 'subscription'.
function storePlanOnRecord(record, ignore = null) {
  if (record.lifetime && ignore !== 'lifetime') return { tier: 'lifetime', source: 'app_store' };
  const runsUntil = Math.max(record.subscriptionUntil ?? 0, record.graceUntil ?? 0);
  if (ignore !== 'subscription' && record.subscriptionUntil != null && runsUntil > Date.now()) {
    return { tier: 'gold', source: 'app_store', expiresAt: record.subscriptionUntil, trial: record.subscriptionTrial };
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

// The profile fields for a plan, with subscription_status and trial_end set
// the way the Stripe side sets them: a web plan's own, active for an App Store
// plan on record, or trialing with the trial's end while that plan is a free
// trial, and cleared for free. The queries that count paying subscribers
// look for subscription_status active, so a trial isn't counted as paid.
function fieldsFor(plan) {
  if (plan.tier === 'free') return { subscription_tier: 'free', subscription_status: null, trial_end: null, subscription_expires_at: null };
  if (plan.source === 'app_store') {
    const expires = plan.expiresAt ? new Date(plan.expiresAt).toISOString() : null;
    return {
      subscription_tier: plan.tier,
      subscription_status: plan.trial ? 'trialing' : 'active',
      trial_end: plan.trial ? expires : null,
      subscription_expires_at: expires,
    };
  }
  return { subscription_tier: plan.tier, subscription_status: plan.status ?? null, trial_end: plan.trialEnd ?? null, subscription_expires_at: null };
}

// RevenueCat's REST API answers what a subscriber holds right now. The secret
// key comes from REVENUECAT_SECRET_KEY and never goes into a log or an answer.
const REVENUECAT_SUBSCRIBERS = 'https://api.revenuecat.com/v1/subscribers/';
const REVENUECAT_TIMEOUT_MS = 10 * 1000;

async function fetchSubscriber(appUserId, { timeoutMs = REVENUECAT_TIMEOUT_MS } = {}) {
  const key = process.env.REVENUECAT_SECRET_KEY;
  if (!key) throw new Error('REVENUECAT_SECRET_KEY is not set');
  const res = await fetch(REVENUECAT_SUBSCRIBERS + encodeURIComponent(appUserId), {
    headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`RevenueCat answered ${res.status}`);
  const body = await res.json();
  return body?.subscriber || {};
}

// The plan an entitlement gives: lifetime when it's named for lifetime or a
// lifetime product grants it, Gold when it's the Gold entitlement, the legacy
// Silver one, or a Gold product grants it, and otherwise none. The app reads
// its plan the same way, so a Gold product named some other way still counts.
function entitlementTier(entitlementId, productId) {
  if (mapProductToTier(entitlementId) === 'lifetime' || mapProductToTier(productId) === 'lifetime') return 'lifetime';
  if (String(entitlementId).toLowerCase() === 'silver' || mapProductToTier(entitlementId) === 'gold' || mapProductToTier(productId) === 'gold') return 'gold';
  return 'free';
}

// Whether every purchase RevenueCat lists for a product was made in the
// sandbox. A product with none listed, as a promotional grant can be, isn't.
function sandboxOnly(subscriber, productId) {
  const oneTime = subscriber.non_subscriptions?.[productId];
  const bought = [...(Array.isArray(oneTime) ? oneTime : []), subscriber.subscriptions?.[productId]].filter(Boolean);
  return bought.length > 0 && bought.every((purchase) => purchase.is_sandbox === true);
}

// What the App Store holds for a subscriber now. Plans come from the
// subscriber's entitlements, the way the app reads them, which RevenueCat
// ends when a purchase is refunded or a family share is revoked. Subscriptions
// whose product is a Gold one count too, so one still running behind a
// lifetime entitlement stays on record.
//   - lifetime comes from an entitlement named for lifetime, or granted by a
//     lifetime product, while it has no expiry or one still ahead. A lifetime
//     purchase stays listed under non_subscriptions with nothing to say it was
//     refunded, so it doesn't count on its own. A sandbox lifetime counts only
//     for an account listed for it.
//   - until, graceUntil, trial and purchasedAt come from a Gold entitlement or
//     Gold subscription that wasn't refunded and is still running, or still
//     in Apple's billing grace period: when its period ends, when its grace
//     period ends, whether the period is a free trial, and when it was bought
//     or last renewed. One whose period still runs is picked over one that's
//     only in its grace period, and then the one that runs longest.
//   - listed says whether RevenueCat lists any Gold plan for the subscriber
//     at all, running, expired or refunded, which means the account has had
//     an App Store plan.
function storeHoldings(subscriber, id) {
  const now = Date.now();
  let lifetime = false;
  let pick = null;
  let listed = false;
  const consider = (expiresDate, graceDate, sub) => {
    const ends = Date.parse(expiresDate || '') || 0;
    const grace = Date.parse(graceDate || '') || 0;
    const runsTo = Math.max(ends, grace);
    if (sub?.refunded_at || ends <= 0 || runsTo <= now) return;
    const running = ends > now;
    if (!pick || (running && !pick.running) || (running === pick.running && runsTo > pick.runsTo)) {
      const trial = String(sub?.period_type || '').toLowerCase() === 'trial';
      pick = { ends, grace, runsTo, running, trial, purchasedAt: Date.parse(sub?.purchase_date || '') || null };
    }
  };
  for (const [entitlementId, entitlement] of Object.entries(subscriber.entitlements || {})) {
    const productId = entitlement?.product_identifier;
    const tier = entitlement ? entitlementTier(entitlementId, productId) : 'free';
    if (tier === 'free') continue;
    if (tier === 'lifetime' && sandboxOnly(subscriber, productId) && !sandboxLifetimeAllowed(id)) continue;
    listed = true;
    if (tier === 'lifetime') {
      if (!entitlement.expires_date || Date.parse(entitlement.expires_date) > now) lifetime = true;
      continue;
    }
    consider(entitlement.expires_date, entitlement.grace_period_expires_date, subscriber.subscriptions?.[productId] || { purchase_date: entitlement.purchase_date });
  }
  for (const [productId, purchases] of Object.entries(subscriber.non_subscriptions || {})) {
    if (mapProductToTier(productId) !== 'lifetime') continue;
    if ((Array.isArray(purchases) ? purchases : []).some((purchase) => purchase && (!purchase.is_sandbox || sandboxLifetimeAllowed(id)))) listed = true;
  }
  for (const [productId, sub] of Object.entries(subscriber.subscriptions || {})) {
    const tier = mapProductToTier(productId);
    if (!sub || tier === 'free') continue;
    if (tier !== 'lifetime' || !sub.is_sandbox || sandboxLifetimeAllowed(id)) listed = true;
    if (tier !== 'lifetime') consider(sub.expires_date, sub.grace_period_expires_date, sub);
  }
  return {
    lifetime,
    until: pick ? pick.ends : null,
    graceUntil: pick && pick.grace > pick.ends ? pick.grace : null,
    trial: pick ? pick.trial : false,
    purchasedAt: pick ? pick.purchasedAt : null,
    listed,
  };
}

// Reads what RevenueCat holds for an account and puts it on the record and on
// the profile, alongside any plan bought on troystack.ai, in the account's
// turn. A temporary grant that's still running is left alone, since
// RevenueCat may not show it by product. A read or write that fails throws.
async function syncFromRevenueCat(id) {
  return withAccountTurn(id, async () => {
    const store = storeHoldings(await fetchSubscriber(id), id);
    await updateRecord(id, (record) => {
      record.lifetime = store.lifetime;
      record.subscriptionUntil = store.until;
      record.subscriptionTrial = store.until != null && store.trial;
      record.graceUntil = store.until != null ? store.graceUntil : null;
      // The running period's purchase time, so an expiry or a refund for it
      // is judged by purchase time, as when a grant put it there.
      if (store.purchasedAt != null && (record.subscriptionPurchasedAt == null || record.subscriptionPurchasedAt < store.purchasedAt)) {
        record.subscriptionPurchasedAt = store.purchasedAt;
      }
      if (store.listed) record.hadPlan = true;
      return record;
    });
    const profile = await profileForPurchase(id);
    const temporaryRunning = profile.subscription_status === TEMPORARY && Date.parse(profile.subscription_expires_at || '') > Date.now();
    if (temporaryRunning && !store.lifetime && store.until == null) return { tier: profile.subscription_tier, temporary: true };
    const plan = await planLeft(id, profile);
    await writeProfile(id, fieldsFor(plan));
    return plan;
  });
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
    // Each kind is judged by its own purchase and refund times only.
    const kind = kindOf(tier);
    if (type !== 'REFUND_REVERSED' && (await grantSuperseded(id, event.purchased_at_ms, kind, { olderIsLate: !lifetimeGrant }))) {
      return { skipped: 'superseded' };
    }
    const profile = await profileForPurchase(id);
    // The status is active, as the Stripe side writes a paid plan, or trialing
    // with the trial's end during an App Store free trial, so the queries that
    // count paying subscribers by subscription_status count App Store ones
    // too. A purchase that validated after a temporary grant isn't temporary
    // now. Whether the period is a trial goes on record with it.
    const trial = kind === 'subscription' && String(event.period_type || '').toUpperCase() === 'TRIAL';
    // The record goes first. If the profile write fails, the retry finds this
    // purchase on record, which doesn't hold it back, and finishes. The other
    // way round, a retry that came after the period ran out would be skipped,
    // and the purchase would never reach the record.
    await recordGrant(id, {
      kind,
      purchasedAtMs: event.purchased_at_ms,
      until: kind === 'lifetime' ? null : expiresMs,
      trial,
      // A reversal's time is kept, so the refund it undid, sent again, ends
      // nothing. Without one on the event, it's the time it arrived.
      reversedAtMs: type === 'REFUND_REVERSED' ? (positiveMs(event.event_timestamp_ms) ?? Date.now()) : null,
    });
    // A subscription bought after lifetime doesn't replace it. It's on record,
    // so it still counts if the lifetime purchase is refunded.
    if (profile.subscription_tier === 'lifetime' && kind !== 'lifetime') return { kept: 'lifetime' };
    await writeProfile(id, {
      subscription_tier: tier,
      subscription_expires_at: tier === 'lifetime' ? null : expires,
      subscription_status: trial ? 'trialing' : 'active',
      trial_end: trial ? expires : null,
    });
    return { tier };
  }

  if (type === 'TEMPORARY_ENTITLEMENT_GRANT') {
    const from = positiveMs(event.event_timestamp_ms) ?? Date.now();
    // A grant delivered or retried after its day is over gives nothing, since
    // the profile would read Gold with nothing coming later to end it, and
    // routes that check only the tier would give Gold. Neither does one sent
    // again after the expiry that ended it.
    if (from + TEMPORARY_MS <= Date.now()) return { skipped: 'already_expired' };
    const { temporaryEndedAt } = await readRecord(id);
    if (temporaryEndedAt != null && from <= temporaryEndedAt) return { skipped: 'superseded' };
    const profile = await profileForPurchase(id);
    // An account that already has a plan keeps it as it is.
    if (profile.subscription_tier === 'gold' || profile.subscription_tier === 'lifetime') return { kept: profile.subscription_tier };
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
    const kind = kindOf(tier);
    // A refund ends what was refunded right away. Another plan still stands.
    if (refund) {
      // A refund can arrive late, or come again on a retry, after a renewal
      // or a new purchase has started a newer period, and then it ends
      // nothing. The expiry date can't show that, because RevenueCat reports
      // a refunded purchase's expiration_at_ms as the time of the refund. The
      // period end stored here is always later, so a refund of the current
      // period would look replaced too. RevenueCat sends this event for a
      // subscription only when its latest period is refunded, so a refund for
      // a purchase older than the newest subscription purchase on record came
      // late, and the purchase times are compared. A lifetime purchase made
      // after it doesn't count, since it's another kind. A lifetime purchase
      // can be refunded any time, so its refund counts unless a reversal
      // undid it. Of either kind, a refund older than the latest reversal for
      // its kind is the one that reversal undid, sent again, and it ends
      // nothing.
      if (await refundReversedSince(id, event.event_timestamp_ms, kind)) return { skipped: 'superseded' };
      if (kind === 'subscription' && (await newerPurchaseOnRecord(id, event.purchased_at_ms, 'subscription'))) return { skipped: 'superseded' };
      if (kind === 'lifetime' || profile.subscription_tier !== 'lifetime') {
        // The record goes first, and the plan left is worked out from it.
        await recordEnd(id, event.purchased_at_ms, kind);
        const left = await planLeft(id, profile, { ignore: kind });
        await writeProfile(id, fieldsFor(left));
        return { tier: left.tier, refunded: true };
      }
      // A refunded subscription leaves lifetime as it is, but it comes off
      // the record, so it can't keep Gold if the lifetime purchase is
      // refunded later.
      await recordEnd(id, event.purchased_at_ms, 'subscription');
      return { kept: 'lifetime' };
    }
    // Auto-renew turned off. The plan runs to the end of the period. One for
    // a purchase older than the newest subscription purchase on record came
    // late, after a renewal, and its expiry would pull the profile's back far
    // enough for that older period's expiry to end the current one.
    if (profile.subscription_tier === 'lifetime') return { kept: 'lifetime' };
    if (kind === 'subscription' && (await newerPurchaseOnRecord(id, event.purchased_at_ms, 'subscription'))) return { skipped: 'superseded' };
    await writeProfile(id, { subscription_expires_at: expires });
    return { expires };
  }

  if (type === 'EXPIRATION') {
    const profile = await readProfile(id);
    if (!profile) return { skipped: 'no_profile' };
    // A temporary grant whose purchase never validated ends, whatever
    // product the event names, and its status goes with it. An expiry from
    // before the grant began is an older one sent again late, so it isn't the
    // grant's end, and it's judged below like any other, against the grant's
    // expiry on the profile.
    const eventAt = positiveMs(event.event_timestamp_ms);
    const grantBegan = Date.parse(profile.subscription_expires_at || '') - TEMPORARY_MS;
    if (profile.subscription_status === TEMPORARY && !(eventAt != null && eventAt < grantBegan)) {
      // The end goes on record first, so the grant sent again gives nothing
      // back, and a retry after a failed profile write still finds the grant
      // on the profile and finishes.
      const endedAt = eventAt ?? Date.now();
      await updateRecord(id, (record) => {
        if (record.temporaryEndedAt == null || record.temporaryEndedAt < endedAt) record.temporaryEndedAt = endedAt;
        return record;
      });
      const left = await planLeft(id, profile);
      await writeProfile(id, fieldsFor(left));
      return { tier: left.tier, temporary: true };
    }
    if (tier === 'free') return { skipped: 'unknown_product' };
    if (tier === 'lifetime') return { skipped: 'lifetime_does_not_expire' };
    // A retried expiry that lands after a renewal or a new purchase is for a
    // period that's already been replaced, so it ends nothing. The purchase
    // times decide, as for a cancellation. A date can't: an expiry for the
    // current purchase can carry an earlier date than the one stored, when a
    // family share is revoked partway through the period or a cancellation
    // for a failed renewal stored its grace period's end, and it still ends
    // the plan. Only when a purchase time is missing do the dates decide.
    const order = await subscriptionPurchaseOrder(id, event.purchased_at_ms);
    const stored = Date.parse(profile.subscription_expires_at || '');
    const replaced = order ? order === 'older' : Boolean(expires && Number.isFinite(stored) && stored > expiresMs);
    if (replaced) return { skipped: 'superseded' };
    // The period is over, so it comes off the record and can't keep Gold if
    // a lifetime purchase is refunded later.
    await endSubscriptionOnRecord(id, expiresMs, { current: order === 'current' });
    if (profile.subscription_tier === 'lifetime') return { kept: 'lifetime' };
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
// sends the event again. Without the key or the web plan check it's logged.
async function applyTransfer(event, res) {
  const from = Array.isArray(event.transferred_from) ? event.transferred_from : [];
  const to = Array.isArray(event.transferred_to) ? event.transferred_to : [];
  const accounts = [...new Set([...from, ...to].filter((id) => typeof id === 'string' && isUUID(id)))];
  if (!process.env.REVENUECAT_SECRET_KEY || !webPlanCheck || accounts.length === 0) {
    let why = 'needs REVENUECAT_SECRET_KEY to be read';
    if (accounts.length === 0) why = 'names no account';
    else if (process.env.REVENUECAT_SECRET_KEY) why = "can't be settled without stripe.js's web plan check";
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
    const outcome = await withAccountTurn(account, () => applyEvent({ ...event, app_user_id: account }));
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
  // Without stripe.js's web plan check, a plan bought on troystack.ai would
  // look like nothing and be written over, so the sync doesn't run.
  if (!process.env.REVENUECAT_SECRET_KEY || !webPlanCheck) {
    if (!webPlanCheck) console.warn('[RevenueCat Sync] No web plan check from stripe.js, so nothing is synced');
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
  return [record.subscriptionPurchasedAt, record.subscriptionEndedAt, record.subscriptionUntil, record.lifetimePurchasedAt, record.lifetimeEndedAt].some((time) => time != null) || record.lifetime || record.hadPlan;
}

// For stripe.js: what RevenueCat says the App Store holds for the account
// now, read as the sync reads it: whether Lifetime stands, when a running
// subscription's period and grace period end, and whether RevenueCat lists
// any Gold plan at all, running, expired or refunded. The record only knows
// the purchases this webhook or the sync has seen, so someone who took the
// App Store trial before then, let it lapse, or holds a plan the profile
// never got, is found here. It's null without REVENUECAT_SECRET_KEY, since
// RevenueCat can't be asked, and a read that fails or runs past timeoutMs
// throws.
async function revenueCatHoldings(id, { timeoutMs } = {}) {
  if (!process.env.REVENUECAT_SECRET_KEY) return null;
  return storeHoldings(await fetchSubscriber(id, { timeoutMs }), id);
}

// For stripe.js: puts what RevenueCat holds for the account on the record and
// the profile, in the account's turn, as the sync route does, which counts
// Apple's billing grace period and a renewal the webhook never got. Checkout
// calls it for App Store Gold on a profile whose period has ended, since an
// EXPIRATION that's late or lost would leave it Gold and keep the account
// out for good, and for an App Store plan RevenueCat shows that the profile
// never got. The record alone can't tell a grace period from a plan that
// ended, and a plan sold on the web during one would be billed twice once
// Apple's retry goes through. So without REVENUECAT_SECRET_KEY, or without
// the web plan check that keeps a plan bought on troystack.ai from being
// written over, nothing is synced and it answers null. Otherwise it answers
// the plan the account now has, and a read or write that fails throws.
async function syncStorePlan(id) {
  if (!process.env.REVENUECAT_SECRET_KEY || !webPlanCheck) return null;
  return syncFromRevenueCat(id);
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
  revenueCatHoldings,
  syncStorePlan,
  accountTurn,
};
