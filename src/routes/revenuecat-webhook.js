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
  'TEMPORARY_ENTITLEMENT_GRANT',
]);

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

async function readProfile(id) {
  const { data, error } = await supabase
    .from('profiles')
    .select('subscription_tier, subscription_expires_at')
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
    await writeProfile(id, { subscription_tier: tier, subscription_expires_at: tier === 'lifetime' ? null : expires });
    return { tier };
  }

  if (type === 'CANCELLATION') {
    if (tier === 'free') return { skipped: 'unknown_product' };
    const profile = await readProfile(id);
    if (!profile) return { skipped: 'no_profile' };
    // A refund ends what was refunded right away.
    if (event.cancel_reason === 'CUSTOMER_SUPPORT') {
      if (tier === 'lifetime' || profile.subscription_tier !== 'lifetime') {
        await writeProfile(id, { subscription_tier: 'free', subscription_expires_at: null });
        return { tier: 'free', refunded: true };
      }
      return { kept: 'lifetime' };
    }
    // Auto-renew turned off. The plan runs to the end of the period.
    if (profile.subscription_tier === 'lifetime') return { kept: 'lifetime' };
    await writeProfile(id, { subscription_expires_at: expires });
    return { expires };
  }

  if (type === 'EXPIRATION') {
    if (tier === 'free') return { skipped: 'unknown_product' };
    if (tier === 'lifetime') return { skipped: 'lifetime_does_not_expire' };
    const profile = await readProfile(id);
    if (!profile) return { skipped: 'no_profile' };
    if (profile.subscription_tier === 'lifetime') return { kept: 'lifetime' };
    await writeProfile(id, { subscription_tier: 'free', subscription_expires_at: null });
    return { tier: 'free' };
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

module.exports = { revenueCatWebhookHandler, applyEvent, mapProductToTier, authorized };
