// Troy reply reports and account deletion, for Google Play's review.
//   node --test
// Pure in-process tests: supabase is a recording fake handed to each route.

const test = require('node:test');
const assert = require('node:assert');

process.env.SUPABASE_URL ||= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-dummy-service-role-key';

const { createAccountRouter, createTroyReportHandler, USER_TABLES, REPORT_CONTENT_MAX } = require('../src/routes/account');

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const CONV = '33333333-3333-4333-8333-333333333333';
const MSG = '44444444-4444-4444-8444-444444444444';

// Records every call. `answers` gives a result per table and operation, as
// "table.op", and anything else answers like an empty table.
function fakeSupabase({ user = { id: USER }, answers = {}, deleteUserError = null } = {}) {
  const log = [];
  const deletedUsers = [];
  function chain(table) {
    let op = 'select';
    const self = new Proxy({}, {
      get(_, prop) {
        if (prop === 'then') {
          const answer = answers[`${table}.${op}`] || { data: [], error: null };
          return (resolve) => resolve(answer);
        }
        return (...args) => {
          if (['select', 'insert', 'delete', 'update', 'upsert'].includes(prop) && op === 'select') op = prop;
          log.push([table, prop, ...args]);
          if (prop === 'single' || prop === 'maybeSingle') {
            return Promise.resolve(answers[`${table}.${op}`] || { data: null, error: null });
          }
          return self;
        };
      },
    });
    return self;
  }
  return {
    log,
    deletedUsers,
    from: (table) => chain(table),
    auth: {
      getUser: async (token) => (token === 'good' && user ? { data: { user }, error: null } : { data: { user: null }, error: { message: 'bad token' } }),
      admin: {
        deleteUser: async (id) => {
          deletedUsers.push(id);
          return { error: deleteUserError };
        },
      },
    },
  };
}

function fakeRes() {
  const res = { statusCode: 200, body: undefined };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

function fakeStripe(subscriptions) {
  const asked = [];
  return {
    asked,
    subscriptions: {
      list: async (params) => {
        asked.push(params);
        if (subscriptions instanceof Error) throw subscriptions;
        return { data: subscriptions };
      },
    },
  };
}

async function callDelete(supabase, headers = {}, stripe = null) {
  const router = createAccountRouter({ supabase, stripe });
  const layer = router.stack.find((l) => l.route && l.route.path === '/' && l.route.methods.delete);
  const res = fakeRes();
  await layer.route.stack[0].handle({ headers, body: {} }, res);
  return res;
}

async function report(supabase, body) {
  const res = fakeRes();
  await createTroyReportHandler({ supabase })({ body, headers: {} }, res);
  return res;
}

test('a report on a reply is kept and answered 201', async () => {
  const supabase = fakeSupabase({ answers: { 'troy_reports.insert': { data: { id: 'r1' }, error: null } } });
  const res = await report(supabase, { userId: USER, conversationId: CONV, messageId: MSG, reason: 'Wrong price', content: 'Gold is $9 an ounce.' });
  assert.strictEqual(res.statusCode, 201);
  assert.deepStrictEqual(res.body, { id: 'r1' });
  const insert = supabase.log.find(([t, op]) => t === 'troy_reports' && op === 'insert');
  assert.deepStrictEqual(insert[2], { user_id: USER, conversation_id: CONV, message_id: MSG, reason: 'Wrong price', content: 'Gold is $9 an ounce.' });
});

test('a visitor who is not signed in can report a reply', async () => {
  const supabase = fakeSupabase({ answers: { 'troy_reports.insert': { data: { id: 'r2' }, error: null } } });
  const res = await report(supabase, { reason: 'Harmful', content: 'Something Troy said' });
  assert.strictEqual(res.statusCode, 201);
  const insert = supabase.log.find(([t, op]) => t === 'troy_reports' && op === 'insert');
  assert.strictEqual(insert[2].user_id, null);
  assert.strictEqual(insert[2].conversation_id, null);
});

test('a report keeps the first 4,000 characters of a longer reply', async () => {
  const supabase = fakeSupabase({ answers: { 'troy_reports.insert': { data: { id: 'r3' }, error: null } } });
  const res = await report(supabase, { reason: 'Other', content: 'x'.repeat(5000) });
  assert.strictEqual(res.statusCode, 201);
  const insert = supabase.log.find(([t, op]) => t === 'troy_reports' && op === 'insert');
  assert.strictEqual(insert[2].content.length, REPORT_CONTENT_MAX);
});

test('a report with no reason or content, or ids that are not ids, is refused before anything is saved', async () => {
  for (const body of [
    { content: 'text' },
    { reason: 'why' },
    { reason: '   ', content: '  ' },
    { reason: 'why', content: 'text', userId: 'x,user_id.not.is.null' },
    { reason: 'why', content: 'text', messageId: 42 },
  ]) {
    const supabase = fakeSupabase();
    const res = await report(supabase, body);
    assert.strictEqual(res.statusCode, 400, JSON.stringify(body));
    assert.strictEqual(supabase.log.length, 0);
  }
});

test('a report the database refuses answers 500 with the support address', async () => {
  const supabase = fakeSupabase({ answers: { 'troy_reports.insert': { data: null, error: { message: 'relation does not exist', code: '42P01' } } } });
  const res = await report(supabase, { reason: 'Other', content: 'text' });
  assert.strictEqual(res.statusCode, 500);
  assert.match(res.body.error, /support@troystack\.com/);
});

test('deleting an account needs a session, and nothing is touched without one', async () => {
  for (const headers of [{}, { authorization: 'Bearer ' }, { authorization: 'Bearer bad' }, { authorization: 'good' }]) {
    const supabase = fakeSupabase();
    const res = await callDelete(supabase, headers);
    assert.strictEqual(res.statusCode, 401);
    assert.strictEqual(supabase.log.length, 0);
    assert.strictEqual(supabase.deletedUsers.length, 0);
  }
});

test("deleting an account removes every table's rows for the session's account, then the sign-in", async () => {
  const supabase = fakeSupabase({ answers: { 'troy_conversations.select': { data: [{ id: CONV }], error: null } } });
  const res = await callDelete(supabase, { authorization: 'Bearer good' });
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(res.body, { deleted: true });

  const deletes = supabase.log.filter(([, op]) => op === 'eq' || op === 'in' || op === 'like');
  const messages = supabase.log.find(([t, op]) => t === 'troy_messages' && op === 'in');
  assert.deepStrictEqual(messages.slice(2), ['conversation_id', [CONV]]);
  for (const [table, column] of USER_TABLES) {
    assert.ok(
      supabase.log.some(([t, op, col, val]) => t === table && op === 'eq' && col === column && val === USER)
        && supabase.log.some(([t, op]) => t === table && op === 'delete'),
      `${table} rows deleted`,
    );
  }
  assert.ok(supabase.log.some(([t, op, col, val]) => t === 'app_state' && op === 'in' && col === 'key' && val.includes(`revenuecat_grant:${USER}`)));
  assert.ok(supabase.log.some(([t, op, col, val]) => t === 'app_state' && op === 'like' && val === `voice_usage_${USER}_%`));
  assert.ok(supabase.log.some(([t, op, val]) => t === 'troy_reports' && op === 'update' && val.user_id === null), 'reports kept without the account');
  assert.ok(supabase.log.some(([t, op, col, val]) => t === 'troy_reports' && op === 'eq' && col === 'user_id' && val === USER));
  assert.ok(supabase.log.some(([t, op, col, val]) => t === 'profiles' && op === 'eq' && val === USER));
  assert.deepStrictEqual(supabase.deletedUsers, [USER]);
  // Only ever the session's account.
  assert.ok(!deletes.some((call) => JSON.stringify(call).includes(OTHER)));
});

test('the sign-in is deleted last, and not at all when a table refuses', async () => {
  const supabase = fakeSupabase({ answers: { 'holdings.delete': { data: null, error: { message: 'timeout', code: '57014' } } } });
  const res = await callDelete(supabase, { authorization: 'Bearer good' });
  assert.strictEqual(res.statusCode, 500);
  assert.match(res.body.error, /support@troystack\.com/);
  assert.strictEqual(supabase.deletedUsers.length, 0);
  assert.ok(!supabase.log.some(([t, op]) => t === 'profiles' && op === 'delete'), 'profile kept for a retry');
});

test("a table this database doesn't have is passed over", async () => {
  const supabase = fakeSupabase({ answers: { 'affiliate_clicks.delete': { data: null, error: { message: 'missing', code: 'PGRST205' } } } });
  const res = await callDelete(supabase, { authorization: 'Bearer good' });
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(supabase.deletedUsers, [USER]);
});

test('an account on a Stripe plan that will charge again is told to cancel first, and nothing is deleted', async () => {
  for (const status of ['active', 'trialing', 'past_due']) {
    const supabase = fakeSupabase({
      answers: { 'profiles.select': { data: { subscription_tier: 'gold', subscription_status: status, stripe_customer_id: 'cus_1' }, error: null } },
    });
    const res = await callDelete(supabase, { authorization: 'Bearer good' });
    assert.strictEqual(res.statusCode, 409, status);
    assert.strictEqual(res.body.error, 'stripe_plan_active');
    assert.ok(!supabase.log.some(([, op]) => op === 'delete'));
    assert.strictEqual(supabase.deletedUsers.length, 0);
  }
});

test('Lifetime and cancelled Stripe plans, and App Store plans, can be deleted', async () => {
  for (const profile of [
    { subscription_tier: 'lifetime', subscription_status: 'active', stripe_customer_id: 'cus_1' },
    { subscription_tier: 'free', subscription_status: 'canceled', stripe_customer_id: 'cus_1' },
    { subscription_tier: 'gold', subscription_status: 'active', stripe_customer_id: null },
  ]) {
    const supabase = fakeSupabase({ answers: { 'profiles.select': { data: profile, error: null } } });
    const res = await callDelete(supabase, { authorization: 'Bearer good' });
    assert.strictEqual(res.statusCode, 200, JSON.stringify(profile));
    assert.deepStrictEqual(supabase.deletedUsers, [USER]);
  }
});

const GOLD_ON_STRIPE = { 'profiles.select': { data: { subscription_tier: 'gold', subscription_status: 'active', stripe_customer_id: 'cus_1' }, error: null } };

test("Stripe decides whether a plan will charge again, not the profile's stored status", async () => {
  // Cancelled in Stripe while the profile still says active, as the
  // cancellation webhook leaves it.
  let supabase = fakeSupabase({ answers: { 'profiles.select': { data: { subscription_tier: 'free', subscription_status: 'active', stripe_customer_id: 'cus_1' }, error: null } } });
  let stripe = fakeStripe([{ status: 'canceled', cancel_at_period_end: false }]);
  let res = await callDelete(supabase, { authorization: 'Bearer good' }, stripe);
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(stripe.asked, [{ customer: 'cus_1', status: 'all', limit: 100 }]);

  // Set to cancel at the end of the period, so it won't charge again.
  supabase = fakeSupabase({ answers: GOLD_ON_STRIPE });
  stripe = fakeStripe([{ status: 'active', cancel_at_period_end: true }]);
  res = await callDelete(supabase, { authorization: 'Bearer good' }, stripe);
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(supabase.deletedUsers, [USER]);

  // Still renewing.
  supabase = fakeSupabase({ answers: GOLD_ON_STRIPE });
  stripe = fakeStripe([{ status: 'canceled' }, { status: 'trialing', cancel_at_period_end: false }]);
  res = await callDelete(supabase, { authorization: 'Bearer good' }, stripe);
  assert.strictEqual(res.statusCode, 409);
  assert.strictEqual(supabase.deletedUsers.length, 0);
});

test("when Stripe can't be asked, nothing is deleted", async () => {
  const supabase = fakeSupabase({ answers: GOLD_ON_STRIPE });
  const res = await callDelete(supabase, { authorization: 'Bearer good' }, fakeStripe(new Error('network')));
  assert.strictEqual(res.statusCode, 503);
  assert.ok(!supabase.log.some(([, op]) => op === 'delete'));
  assert.strictEqual(supabase.deletedUsers.length, 0);
});

test('without Stripe set up, a profile moved to free by the cancellation webhook can be deleted', async () => {
  const supabase = fakeSupabase({ answers: { 'profiles.select': { data: { subscription_tier: 'free', subscription_status: 'active', stripe_customer_id: 'cus_1' }, error: null } } });
  const res = await callDelete(supabase, { authorization: 'Bearer good' });
  assert.strictEqual(res.statusCode, 200);
});

test('the stories the account liked or commented on are counted again after its rows go', async () => {
  const supabase = fakeSupabase({
    answers: {
      'article_likes.select': { data: [{ article_id: 'a1' }], count: 4, error: null },
      'article_comments.select': { data: [{ article_id: 'a2' }], count: 1, error: null },
    },
  });
  const res = await callDelete(supabase, { authorization: 'Bearer good' });
  assert.strictEqual(res.statusCode, 200);
  const updates = supabase.log.filter(([t, op]) => t === 'stack_signal_articles' && op === 'update').map(([, , v]) => v);
  assert.deepStrictEqual(updates, [{ like_count: 4, comment_count: 1 }, { like_count: 4, comment_count: 1 }]);
  const ids = supabase.log.filter(([t, op, col]) => t === 'stack_signal_articles' && op === 'eq' && col === 'id').map(([, , , v]) => v);
  assert.deepStrictEqual(ids, ['a1', 'a2']);
  const lastLikeDelete = supabase.log.findLastIndex(([t, op]) => t === 'article_likes' && op === 'delete');
  const firstRecount = supabase.log.findIndex(([t, op]) => t === 'stack_signal_articles' && op === 'update');
  assert.ok(lastLikeDelete < firstRecount, 'counted after the rows are gone');
});
