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
// when Stripe can't be read.
let webPlanCheck = null;
function setWebPlanCheck(check) {
  webPlanCheck = typeof check === 'function' ? check : null;
}

// The plan an account is left with once an App Store plan ends: what Stripe
// still holds for it, or free. A Stripe read that fails throws, so the event
// is answered 500 and RevenueCat sends it again, rather than free being saved
// over a web plan that's still paid.
async function planLeft(id, profile) {
  if (!webPlanCheck || !profile.stripe_customer_id) return { tier: 'free' };
  const plan = await webPlanCheck(id, profile.stripe_customer_id);
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
    const profile = await readProfile(id);
    if (!profile) return { skipped: 'no_profile' };
    // A subscription bought after lifetime doesn't replace it.
    if (profile.subscription_tier === 'lifetime' && tier !== 'lifetime') return { kept: 'lifetime' };
    await writeProfile(id, {
      subscription_tier: tier,
      subscription_expires_at: tier === 'lifetime' ? null : expires,
      // A purchase that validated after a temporary grant isn't temporary now.
      ...(profile.subscription_status === TEMPORARY ? { subscription_status: 'active' } : {}),
    });
    return { tier };
  }

  if (type === 'TEMPORARY_ENTITLEMENT_GRANT') {
    const profile = await readProfile(id);
    if (!profile) return { skipped: 'no_profile' };
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
        const left = await planLeft(id, profile);
        await writeProfile(id, fieldsFor(left));
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
