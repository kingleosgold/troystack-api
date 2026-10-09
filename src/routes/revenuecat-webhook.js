// RevenueCat webhook: App Store purchases and their changes land on profiles.
//
// POST /v1/webhooks/revenuecat, mounted in index.js.
//
// Once migration 006 guards the plan columns, the iPhone app can no longer
// write its own plan, so this is the only way an App Store plan reaches
// profiles. That puts three duties on it:
//   - cover every event that changes what someone owns, including the
//     one-time lifetime purchase RevenueCat reports as NON_RENEWING_PURCHASE
//   - refuse calls that don't carry the shared secret, and refuse everything
//     when the secret isn't set, since a plan write here can't be undone by
//     the guard
//   - answer 500 when a profile read or write fails, so RevenueCat retries
//     instead of the purchase being lost
// Sandbox events are applied too. App Review buys in the sandbox, and a
// reviewer who pays has to get the server side of Gold.
//
// TRANSFER (purchases restored onto a different account) isn't applied. The
// event doesn't say what moved, and reading it needs RevenueCat's REST API
// and a secret key the API doesn't hold yet. It's logged so it can be settled
// by hand.
//
// When an App Store plan ends, by expiry or refund, the account may still
// hold a plan bought on troystack.ai. stripe.js hands this module a check of
// what Stripe holds, and the profile gets that plan before it gets free.
//
// RevenueCat retries a delivery that failed, and events can arrive out of
// order. For each account, app_state keeps the purchase time of the newest
// App Store purchase applied, so a refund or a subscription grant that
// arrives late can't end or replace a newer period, and of the latest
// purchase a refund ended, so a grant for it that arrives late can't give it
// back.

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

// The plan an account is left with once an App Store plan ends: what Stripe
// still holds for it, or free. A profile with no customer id is asked about
// too, since a customer an older checkout made can hold a paid web plan the
// profile never recorded. A Stripe read that fails throws, so the event is
// answered 500 and RevenueCat sends it again, rather than free being saved
// over a web plan that's still paid.
async function planLeft(id, profile) {
  if (!webPlanCheck) return { tier: 'free' };
  const plan = await webPlanCheck(id, profile.stripe_customer_id || null);
  return plan && (plan.tier === 'gold' || plan.tier === 'lifetime') ? plan : { tier: 'free' };
}

function fieldsFor(plan) {
  if (plan.tier === 'free') return { subscription_tier: 'free', subscription_expires_at: null };
  return { subscription_tier: plan.tier, subscription_status: plan.status ?? null, trial_end: plan.trialEnd ?? null, subscription_expires_at: null };
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
// { purchasedAt, endedAt }: the purchase time in ms of the newest App Store
// purchase applied, and of the latest purchase a refund ended. Either can be
// missing.
function grantKey(id) {
  return `revenuecat_grant:${id}`;
}

// A time in ms, or null when it isn't a positive number.
function positiveMs(value) {
  const ms = Number(value);
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

// The account's record, with null for a time that isn't on it. A read that
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
  return { purchasedAt: positiveMs(value?.purchasedAt), endedAt: positiveMs(value?.endedAt) };
}

// Saves the record, leaving out a time that's null. A write that fails throws.
async function writeRecord(id, { purchasedAt, endedAt }) {
  const value = {};
  if (purchasedAt != null) value.purchasedAt = purchasedAt;
  if (endedAt != null) value.endedAt = endedAt;
  const { error } = await supabase.from('app_state').upsert({ key: grantKey(id), value }, { onConflict: 'key' });
  if (error) throw new Error(`purchase record write failed: ${error.message}`);
}

// Records a purchase's time once its plan is on the profile, unless a newer
// one is already on record, which a late or repeated event finds. A reversed
// refund also wipes the record of a refund ending this purchase or an older
// one, so the purchase it gives back is treated like any other from then on.
// A read or write that fails throws and RevenueCat sends the event again, and
// the profile write it repeats does no harm.
async function recordGrant(id, purchasedAtMs, { reversesRefund = false } = {}) {
  const at = positiveMs(purchasedAtMs);
  if (at == null) return;
  const record = await readRecord(id);
  const purchasedAt = record.purchasedAt != null && record.purchasedAt >= at ? record.purchasedAt : at;
  const endedAt = reversesRefund && record.endedAt != null && record.endedAt <= at ? null : record.endedAt;
  if (purchasedAt === record.purchasedAt && endedAt === record.endedAt) return;
  await writeRecord(id, { purchasedAt, endedAt });
}

// Records that a refund ended a purchase, once the profile no longer has it,
// so a grant for it that RevenueCat sends again afterwards, on a retry or out
// of order, gives nothing back. The later of this purchase and any refunded
// one already on record is kept, and the newest purchase on record stays as
// it is. A read or write that fails throws and RevenueCat sends the refund
// again, and the profile write it repeats does no harm.
async function recordEnd(id, purchasedAtMs) {
  const at = positiveMs(purchasedAtMs);
  if (at == null) return;
  const record = await readRecord(id);
  if (record.endedAt != null && record.endedAt >= at) return;
  await writeRecord(id, { purchasedAt: record.purchasedAt, endedAt: at });
}

// Whether a purchase newer than this one has been applied to the account.
// Without a purchase time on the event or a record, there's no telling, so no.
async function newerGrantApplied(id, purchasedAtMs) {
  const at = positiveMs(purchasedAtMs);
  if (at == null) return false;
  const { purchasedAt } = await readRecord(id);
  return purchasedAt != null && purchasedAt > at;
}

// Whether what's on record has overtaken a grant: a refund ended this
// purchase or a later one, or, unless the grant is lifetime, a newer purchase
// has been applied. Without a purchase time on the event or a record, there's
// no telling, so no.
async function grantSuperseded(id, purchasedAtMs, { lifetime = false } = {}) {
  const at = positiveMs(purchasedAtMs);
  if (at == null) return false;
  const { purchasedAt, endedAt } = await readRecord(id);
  if (endedAt != null && at <= endedAt) return true;
  return !lifetime && purchasedAt != null && at < purchasedAt;
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
  const expires = event.expiration_at_ms ? new Date(Number(event.expiration_at_ms)).toISOString() : null;

  if (GRANTS.has(type)) {
    if (tier === 'free') return { skipped: 'unknown_product' };
    // RevenueCat retries a delivery that failed and can deliver events out of
    // order, so a grant can land after the expiry or refund that ended it. A
    // subscription whose expiry is already past has nothing left to give,
    // since the period it paid for is over, and that goes for a reversed
    // refund too. Lifetime never expires, and a grant that names no expiry
    // isn't held to this.
    if (tier !== 'lifetime' && expires && Date.parse(expires) <= Date.now()) {
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
    const lifetimeGrant = tier === 'lifetime' || type === 'NON_RENEWING_PURCHASE';
    if (type !== 'REFUND_REVERSED' && (await grantSuperseded(id, event.purchased_at_ms, { lifetime: lifetimeGrant }))) {
      return { skipped: 'superseded' };
    }
    const profile = await profileForPurchase(id);
    // A subscription bought after lifetime doesn't replace it.
    if (profile.subscription_tier === 'lifetime' && tier !== 'lifetime') return { kept: 'lifetime' };
    await writeProfile(id, {
      subscription_tier: tier,
      subscription_expires_at: tier === 'lifetime' ? null : expires,
      // A purchase that validated after a temporary grant isn't temporary now.
      ...(profile.subscription_status === TEMPORARY ? { subscription_status: 'active' } : {}),
    });
    await recordGrant(id, event.purchased_at_ms, { reversesRefund: type === 'REFUND_REVERSED' });
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
    const profile = await readProfile(id);
    if (!profile) return { skipped: 'no_profile' };
    // A refund ends what was refunded right away. A web plan still stands.
    if (event.cancel_reason === 'CUSTOMER_SUPPORT') {
      if (tier === 'lifetime' || profile.subscription_tier !== 'lifetime') {
        // A refund can arrive late, or come again on a retry, after a renewal
        // or a new purchase has started a newer period, and then it ends
        // nothing. The expiry date can't show that, because RevenueCat
        // reports a refunded purchase's expiration_at_ms as the time of the
        // refund. The period end stored here is always later, so a refund of
        // the current period would look replaced too. RevenueCat sends this
        // event for a subscription only when its latest period is refunded,
        // so a refund for a purchase older than the newest one applied here
        // came late. The API holds no RevenueCat REST key to ask what's
        // current, so the purchase times are compared. A lifetime purchase
        // can be refunded any time, so its refund always counts.
        if (tier !== 'lifetime' && (await newerGrantApplied(id, event.purchased_at_ms))) return { skipped: 'superseded' };
        const left = await planLeft(id, profile);
        await writeProfile(id, fieldsFor(left));
        await recordEnd(id, event.purchased_at_ms);
        return { tier: left.tier, refunded: true };
      }
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
    if (profile.subscription_tier === 'lifetime') return { kept: 'lifetime' };
    // A retried expiry that lands after a renewal or a new purchase is for a
    // period that's already been replaced, so it ends nothing.
    const stored = Date.parse(profile.subscription_expires_at || '');
    if (expires && Number.isFinite(stored) && stored > Date.parse(expires)) return { skipped: 'superseded' };
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

  if (type === 'TRANSFER') {
    console.warn(`[RevenueCat Webhook] TRANSFER from ${JSON.stringify(event.transferred_from || [])} to ${JSON.stringify(event.transferred_to || [])} needs settling by hand`);
    return res.status(200).json({ success: true, skipped: 'transfer' });
  }
  if (!appUserId || String(appUserId).startsWith('$RCAnonymousID:')) {
    return res.status(200).json({ success: true, skipped: 'anonymous_user' });
  }
  if (!isUUID(appUserId)) {
    return res.status(200).json({ success: true, skipped: 'non_uuid_user' });
  }

  try {
    const outcome = await applyEvent(event);
    console.log(`[RevenueCat Webhook] ${type} for ${appUserId}: ${JSON.stringify(outcome)}`);
    return res.status(200).json({ success: true, ...outcome });
  } catch (err) {
    // RevenueCat retries a failed delivery, so a database blip doesn't lose a purchase.
    console.error(`[RevenueCat Webhook] ${type} for ${appUserId} failed:`, err.message);
    return res.status(500).json({ error: 'Could not record the event' });
  }
}

module.exports = { revenueCatWebhookHandler, applyEvent, mapProductToTier, authorized, setWebPlanCheck };
