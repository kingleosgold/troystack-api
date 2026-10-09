// Checks the Stripe routes run before they act for someone.
//
// signedInUserId: the account behind the request's Supabase session token.
//   Checkout and the billing portal only act for that account, so a user id
//   copied from somewhere else can't open someone's billing page.
// safeRedirect: Stripe sends people back to these addresses after checkout or
//   the billing portal, so only TroyStack's own sites count.
// cleanCampaign: the web page passes which surface the checkout started from,
//   stored on the Stripe session and subscription for attribution.
// liveSubscription: the subscription that should give an account Gold.
// paidLifetimeSession: a completed, paid lifetime checkout. Lifetime is a
//   one-time payment, so Stripe keeps no subscription for it.

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

function liveSubscription(subscriptions) {
  const list = Array.isArray(subscriptions) ? subscriptions : [];
  return list.find((s) => s && (s.status === 'active' || s.status === 'trialing')) || null;
}

function paidLifetimeSession(sessions) {
  const list = Array.isArray(sessions) ? sessions : [];
  return (
    list.find(
      (s) =>
        s &&
        s.mode === 'payment' &&
        s.status === 'complete' &&
        s.payment_status === 'paid' &&
        (s.metadata?.tier || 'lifetime') === 'lifetime',
    ) || null
  );
}

module.exports = { safeRedirect, cleanCampaign, signedInUserId, liveSubscription, paidLifetimeSession, SITE_ORIGINS };
