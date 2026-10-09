const test = require('node:test');
const assert = require('node:assert/strict');
const { safeRedirect, cleanCampaign, signedInUserId, liveSubscription, paidLifetimeSession } = require('../src/lib/stripe-checks');

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

test('only an active or trialing subscription restores Gold', () => {
  assert.equal(liveSubscription([{ status: 'canceled' }, { status: 'incomplete_expired' }]), null);
  assert.equal(liveSubscription([{ status: 'canceled' }, { id: 's2', status: 'trialing' }]).id, 's2');
  assert.equal(liveSubscription([{ id: 's1', status: 'active' }]).id, 's1');
  assert.equal(liveSubscription(undefined), null);
});

test('a paid, completed lifetime checkout counts, nothing else does', () => {
  const paid = { id: 'cs_life', mode: 'payment', status: 'complete', payment_status: 'paid', metadata: { tier: 'lifetime' } };
  assert.equal(paidLifetimeSession([paid]).id, 'cs_life');
  assert.equal(paidLifetimeSession([{ ...paid, metadata: {} }]).id, 'cs_life', 'older sessions without a tier still count, as in the webhook');
  assert.equal(paidLifetimeSession([{ ...paid, payment_status: 'unpaid' }]), null);
  assert.equal(paidLifetimeSession([{ ...paid, status: 'expired' }]), null);
  assert.equal(paidLifetimeSession([{ ...paid, mode: 'subscription' }]), null);
  assert.equal(paidLifetimeSession([{ ...paid, metadata: { tier: 'gold' } }]), null);
  assert.equal(paidLifetimeSession(undefined), null);
});
