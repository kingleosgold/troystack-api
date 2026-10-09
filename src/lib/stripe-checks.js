// Checks the Stripe routes run before they act for someone.
//
// signedInUserId: the account behind the request's Supabase session token.
//   Checkout and the billing portal only act for that account, so a user id
//   copied from somewhere else can't open someone's billing page.
// safeRedirect: Stripe sends people back to these addresses after checkout or
//   the billing portal, so only TroyStack's own sites count.
// cleanCampaign: the web page passes which surface the checkout started from,
//   stored on the Stripe session and subscription for attribution.
// liveSubscriptions: the subscriptions that are active or trialing.
// subscriptionTier: the plan a subscription's price gives, or null when the
//   price isn't a Gold price and isn't on a Gold product.
// paidLifetimeSessions: completed, paid one-time checkouts recorded as
//   lifetime, or recorded with no tier at all. Lifetime is a one-time payment,
//   so Stripe keeps no subscription for it. One with no tier still has to pass
//   soldLifetime before it counts.
// soldLifetime: whether a checkout's line items include the lifetime price or
//   a one-time price on a Gold product.

const SITE_ORIGINS = [
  'https://troystack.ai',
  'https://www.troystack.ai',
  'https://app.stacktrackergold.com',
  'https://stacktrackergold.com',
  'https://www.stacktrackergold.com',
];
const PREVIEW_ORIGIN = /^https:\/\/troystack-webapp-[a-z0-9-]+-jon-5842s-projects\.vercel\.app$/;
const DEV_ORIGINS = ['http://localhost:5173', 'http://localhost:4173', 'http://localhost:3000'];

function safeRedirect(url, fallback, { allowDev = process.env.NODE_ENV !== 'production' } = {}) {
  if (typeof url !== 'string' || url.length > 2000) return fallback;
  let origin;
  try {
    origin = new URL(url).origin;
  } catch {
    return fallback;
  }
  const allowed = SITE_ORIGINS.includes(origin) || PREVIEW_ORIGIN.test(origin) || (allowDev && DEV_ORIGINS.includes(origin));
  // The original string goes to Stripe so {CHECKOUT_SESSION_ID} stays intact.
  return allowed ? url : fallback;
}

function cleanCampaign(value) {
  return typeof value === 'string' && /^[a-z0-9-]{1,40}$/.test(value) ? value : null;
}

async function signedInUserId(req, supabase) {
  const header = req.headers?.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) return { status: 401, error: 'Sign in first' };
  try {
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data?.user?.id) return { status: 401, error: 'Your session has expired. Sign in again.' };
    return { userId: data.user.id };
  } catch {
    return { status: 401, error: 'Your session has expired. Sign in again.' };
  }
}

function liveSubscriptions(subscriptions) {
  const list = Array.isArray(subscriptions) ? subscriptions : [];
  return list.filter((s) => s && (s.status === 'active' || s.status === 'trialing'));
}

// mapPrice is the route's price-to-tier map, which answers 'free' for a price
// it doesn't know. goldProducts holds the products the Gold prices belong to,
// so someone on an older Gold price still counts.
function subscriptionTier(price, mapPrice, goldProducts) {
  const mapped = price?.id ? mapPrice(price.id) : 'free';
  if (mapped && mapped !== 'free') return mapped;
  const product = typeof price?.product === 'string' ? price.product : price?.product?.id;
  return product && goldProducts && goldProducts.has(product) ? 'gold' : null;
}

function paidLifetimeSessions(sessions) {
  const list = Array.isArray(sessions) ? sessions : [];
  return list.filter(
    (s) =>
      s &&
      s.mode === 'payment' &&
      s.status === 'complete' &&
      s.payment_status === 'paid' &&
      (s.metadata?.tier || 'lifetime') === 'lifetime',
  );
}

function soldLifetime(lineItems, lifetimePriceId, goldProducts) {
  const list = Array.isArray(lineItems) ? lineItems : [];
  return list.some((item) => {
    const price = item?.price;
    if (!price) return false;
    if (lifetimePriceId && price.id === lifetimePriceId) return true;
    const product = typeof price.product === 'string' ? price.product : price.product?.id;
    return price.type === 'one_time' && Boolean(product) && Boolean(goldProducts && goldProducts.has(product));
  });
}

module.exports = { safeRedirect, cleanCampaign, signedInUserId, liveSubscriptions, subscriptionTier, paidLifetimeSessions, soldLifetime, SITE_ORIGINS };
