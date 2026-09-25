// Server-side guards that change no client contract.
//   node --test
// Pure in-process tests: supabase is replaced with an in-memory fake, and no
// network or model call is made.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

process.env.SUPABASE_URL ||= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-dummy-service-role-key';

const VIEWER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const COMMENTS = [
  { id: 'c1', user_id: VIEWER, content: 'mine', created_at: '1999-01-31T12:00:00Z' },
  { id: 'c2', user_id: OTHER, content: 'theirs', created_at: '1999-01-31T11:00:00Z' },
];

// Chainable stand-in for the one query the comments route runs.
function fakeSupabase(rows) {
  const chain = {
    select() { return chain; },
    eq() { return chain; },
    order() { return chain; },
    range() { return Promise.resolve({ data: rows, error: null }); },
  };
  return { from: () => chain };
}

function loadSocialRouter(rows) {
  const supabasePath = require.resolve(path.join(__dirname, '..', 'src', 'lib', 'supabase'));
  const socialPath = require.resolve(path.join(__dirname, '..', 'src', 'routes', 'social'));
  delete require.cache[socialPath];
  require.cache[supabasePath] = { id: supabasePath, filename: supabasePath, loaded: true, exports: fakeSupabase(rows) };
  try {
    return require(socialPath);
  } finally {
    delete require.cache[supabasePath];
    delete require.cache[socialPath];
  }
}

async function getComments(router, query) {
  const layer = router.stack.find((l) => l.route && l.route.path === '/articles/:id/comments' && l.route.methods.get);
  let body;
  const res = { json: (b) => { body = b; }, status() { return res; } };
  await layer.route.stack[0].handle({ params: { id: 'a1' }, query, body: {} }, res);
  return body;
}

test('public comment list never returns user_id', async () => {
  const body = await getComments(loadSocialRouter(COMMENTS), {});
  assert.strictEqual(body.success, true);
  assert.strictEqual(body.comments.length, 2);
  for (const c of body.comments) {
    assert.ok(!('user_id' in c), 'user_id must not be in the response');
    assert.strictEqual(c.is_own, false);
  }
});

test('a caller passing its own userId sees is_own on its comments only', async () => {
  const body = await getComments(loadSocialRouter(COMMENTS), { userId: VIEWER });
  const byId = Object.fromEntries(body.comments.map((c) => [c.id, c]));
  assert.strictEqual(byId.c1.is_own, true);
  assert.strictEqual(byId.c2.is_own, false);
  assert.ok(!JSON.stringify(body).includes(OTHER), 'another user id never leaks');
});

test('daily budget caps per day and resets the next day', () => {
  const { createDailyBudget } = require('../src/lib/daily-budget');
  const budget = createDailyBudget(3);
  const day1 = new Date('1999-01-31T10:00:00Z');
  const granted = [1, 2, 3, 4, 5].filter(() => budget.take(day1)).length;
  assert.strictEqual(granted, 3);
  assert.strictEqual(budget.take(new Date('1999-02-01T00:00:01Z')), true, 'a new day starts a fresh budget');
});

test('mcp chat_with_troy draws anonymous calls from the daily budget', () => {
  const src = require('node:fs').readFileSync(path.join(__dirname, '..', 'src', 'routes', 'mcp.js'), 'utf8');
  const fn = src.slice(src.indexOf('async function tool_chatWithTroy'), src.indexOf('async function tool_getPortfolio'));
  assert.ok(fn.includes('if (!keyed && !anonChatBudget.take())'), 'anonymous calls must take a budget slot before the model call');
  assert.ok(fn.indexOf('anonChatBudget.take()') < fn.indexOf('callGemini('), 'the budget check runs before the model call');
});
