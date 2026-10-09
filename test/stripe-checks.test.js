const test = require('node:test');
const assert = require('node:assert/strict');
const { safeRedirect, cleanCampaign, signedInUserId, liveSubscriptions, subscriptionTier, paidLifetimeSessions } = require('../src/lib/stripe-checks');

const FALLBACK = 'https://troystack.ai/settings';

test('redirects stay on TroyStack sites', () => {
  const back = 'https://troystack.ai/settings?session_id={CHECKOUT_SESSION_ID}';
  assert.equal(safeRedirect(back, FALLBACK), back, 'keeps the session placeholder as written');
  assert.equal(safeRedirect('https://app.stacktrackergold.com/settings', FALLBACK), 'https://app.stacktrackergold.com/settings');
  assert.equal(
    safeRedirect('https://troystack-webapp-git-feat-x-jon-5842s-projects.vercel.app/settings', FALLBACK),
    'https://troystack-webapp-git-feat-x-jon-5842s-projects.vercel.app/settings',
  );
});

test('redirects to anywhere else fall back', () => {
  assert.equal(safeRedirect('https://evil.example/settings', FALLBACK), FALLBACK);
  assert.equal(safeRedirect('https://troystack.ai.evil.example/', FALLBACK), FALLBACK);
  assert.equal(safeRedirect('javascript:alert(1)', FALLBACK), FALLBACK);
  assert.equal(safeRedirect('/settings', FALLBACK), FALLBACK);
  assert.equal(safeRedirect(undefined, FALLBACK), FALLBACK);
  assert.equal(safeRedirect('https://troystack.ai/' + 'x'.repeat(2100), FALLBACK), FALLBACK);
});

test('local dev hosts only count outside production', () => {
  assert.equal(safeRedirect('http://localhost:5173/settings', FALLBACK, { allowDev: true }), 'http://localhost:5173/settings');
  assert.equal(safeRedirect('http://localhost:5173/settings', FALLBACK, { allowDev: false }), FALLBACK);
});

test('campaign tokens are short and plain', () => {
  assert.equal(cleanCampaign('webapp-troy-limit'), 'webapp-troy-limit');
  assert.equal(cleanCampaign('Webapp'), null);
  assert.equal(cleanCampaign('a b'), null);
  assert.equal(cleanCampaign('x'.repeat(41)), null);
  assert.equal(cleanCampaign(42), null);
});

function fakeSupabase(result) {
  return { auth: { getUser: async () => result } };
}

test('the signed-in account comes from the bearer token', async () => {
  const ok = await signedInUserId(
    { headers: { authorization: 'Bearer token-1' } },
    fakeSupabase({ data: { user: { id: 'user-1' } }, error: null }),
  );
  assert.deepEqual(ok, { userId: 'user-1' });
});

test('no token, a bad token or a failed lookup is a 401', async () => {
  const none = await signedInUserId({ headers: {} }, fakeSupabase({ data: null, error: null }));
  assert.equal(none.status, 401);
  const bad = await signedInUserId(
    { headers: { authorization: 'Bearer nope' } },
    fakeSupabase({ data: { user: null }, error: { message: 'invalid JWT' } }),
  );
  assert.equal(bad.status, 401);
  const thrown = await signedInUserId(
    { headers: { authorization: 'Bearer x' } },
    { auth: { getUser: async () => { throw new Error('network'); } } },
  );
  assert.equal(thrown.status, 401);
});

test('only active or trialing subscriptions are live', () => {
  assert.deepEqual(liveSubscriptions([{ status: 'canceled' }, { status: 'incomplete_expired' }]), []);
  assert.deepEqual(liveSubscriptions([{ status: 'canceled' }, { id: 's2', status: 'trialing' }, { id: 's3', status: 'active' }]).map((s) => s.id), ['s2', 's3']);
  assert.deepEqual(liveSubscriptions(undefined), []);
});

test('only a Gold price, or a price on a Gold product, gives a plan', () => {
  const map = (id) => ({ price_monthly: 'gold', price_yearly: 'gold' })[id] || 'free';
  const gold = new Set(['prod_gold']);
  assert.equal(subscriptionTier({ id: 'price_monthly', product: 'prod_gold' }, map, gold), 'gold');
  assert.equal(subscriptionTier({ id: 'price_2025_monthly', product: 'prod_gold' }, map, gold), 'gold', 'an older Gold price still counts');
  assert.equal(subscriptionTier({ id: 'price_2025_monthly', product: { id: 'prod_gold' } }, map, gold), 'gold');
  assert.equal(subscriptionTier({ id: 'price_other', product: 'prod_other' }, map, gold), null);
  assert.equal(subscriptionTier(undefined, map, gold), null);
  assert.equal(subscriptionTier({ id: 'price_other', product: 'prod_other' }, map, new Set()), null);
});

test('every paid, completed lifetime checkout is found, nothing else is', () => {
  const paid = { id: 'cs_life', mode: 'payment', status: 'complete', payment_status: 'paid', metadata: { tier: 'lifetime' } };
  assert.deepEqual(paidLifetimeSessions([paid, { ...paid, id: 'cs_old', metadata: {} }]).map((s) => s.id), ['cs_life', 'cs_old'], 'older sessions without a tier count, as in the webhook');
  assert.deepEqual(paidLifetimeSessions([{ ...paid, payment_status: 'unpaid' }]), []);
  assert.deepEqual(paidLifetimeSessions([{ ...paid, status: 'expired' }]), []);
  assert.deepEqual(paidLifetimeSessions([{ ...paid, mode: 'subscription' }]), []);
  assert.deepEqual(paidLifetimeSessions([{ ...paid, metadata: { tier: 'gold' } }]), []);
  assert.deepEqual(paidLifetimeSessions(undefined), []);
});
