// The Signal list's type filter, which troystack.com's sitemap uses to list
// every recap.
//   node --test
// Pure in-process tests: supabase is replaced with an in-memory fake, and the
// router runs in a throwaway express app on a local port.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const express = require('express');

process.env.SUPABASE_URL ||= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-dummy-service-role-key';

const ROWS = [
  { slug: 'the-stack-signal-2026-10-19', is_stack_signal: true, category: 'macro' },
  { slug: 'gold-rises-2026-10-19', is_stack_signal: false, category: 'gold' },
  { slug: 'evening-signal-2026-10-18', is_stack_signal: true, category: 'macro' },
  { slug: 'silver-dips-2026-10-18', is_stack_signal: false, category: 'silver' },
  { slug: 'old-import-2026-02-26', is_stack_signal: null, category: 'gold' },
];

// Records every filter the route applies and answers the rows that match.
function fakeSupabase(rows = ROWS, { failIn = false } = {}) {
  const calls = [];
  function from() {
    const filters = {};
    let inFilter = null;
    const orders = [];
    let range = null;
    let orExpr = null;
    const chain = {
      select() { return chain; },
      order(col, opts) { orders.push([col, opts?.ascending]); return chain; },
      range(a, b) { range = [a, b]; return chain; },
      eq(col, val) { filters[col] = val; return chain; },
      or(expr) { orExpr = expr; return chain; },
      in(col, vals) { inFilter = [col, vals]; return chain; },
      then(resolve) {
        calls.push({ filters: { ...filters }, orders: orders.slice(), range, or: orExpr, in: inFilter });
        if (inFilter && failIn) return Promise.resolve({ data: null, error: { message: 'boom' } }).then(resolve);
        // The one or() the route sends: the flag is null or false.
        const news = (r) => r.is_stack_signal === null || r.is_stack_signal === false;
        const data = rows
          .filter((r) => Object.entries(filters).every(([k, v]) => r[k] === v))
          .filter((r) => !inFilter || inFilter[1].includes(r[inFilter[0]]))
          .filter((r) => !orExpr || news(r));
        return Promise.resolve({ data, error: null }).then(resolve);
      },
    };
    return chain;
  }
  return { calls, client: { from } };
}

function loadRouter(client) {
  const supabasePath = require.resolve(path.join(__dirname, '..', 'src', 'lib', 'supabase'));
  const routePath = require.resolve(path.join(__dirname, '..', 'src', 'routes', 'stack-signal'));
  delete require.cache[routePath];
  require.cache[supabasePath] = { id: supabasePath, filename: supabasePath, loaded: true, exports: client };
  try {
    return require(routePath);
  } finally {
    delete require.cache[supabasePath];
    delete require.cache[routePath];
  }
}

async function withApp(client, fn) {
  const app = express();
  app.use('/v1/stack-signal', loadRouter(client));
  const server = app.listen(0);
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    await fn((p) => fetch(base + p).then(async (r) => ({ status: r.status, body: await r.json() })));
  } finally {
    server.close();
  }
}

test('no type lists recaps and news items alike', async () => {
  const { calls, client } = fakeSupabase();
  await withApp(client, async (get) => {
    const res = await get('/v1/stack-signal?limit=10');
    assert.equal(res.status, 200);
    assert.equal(res.body.articles.length, 5);
    assert.deepEqual(calls[0].filters, {});
  });
});

test('type=signal lists only recaps', async () => {
  const { calls, client } = fakeSupabase();
  await withApp(client, async (get) => {
    const res = await get('/v1/stack-signal?type=signal&limit=50&offset=50');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.articles.map((a) => a.slug), ['the-stack-signal-2026-10-19', 'evening-signal-2026-10-18']);
    assert.deepEqual(calls[0].filters, { is_stack_signal: true });
    assert.deepEqual(calls[0].range, [50, 99]);
  });
});

test('type=news lists only news items, a null flag included', async () => {
  const { calls, client } = fakeSupabase();
  await withApp(client, async (get) => {
    const res = await get('/v1/stack-signal?type=news&category=gold');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.articles.map((a) => a.slug), ['gold-rises-2026-10-19', 'old-import-2026-02-26']);
    assert.deepEqual(calls[0].filters, { category: 'gold' });
    assert.equal(calls[0].or, 'is_stack_signal.is.null,is_stack_signal.eq.false');
  });
});

test('any other type is refused before the database is asked', async () => {
  const { calls, client } = fakeSupabase();
  await withApp(client, async (get) => {
    for (const q of ['type=all', 'type=', 'type=signal&type=news']) {
      const res = await get(`/v1/stack-signal?${q}`);
      assert.equal(res.status, 400, q);
    }
    assert.equal(calls.length, 0);
  });
});

test('the list sorts by published_at, then id, so equal timestamps page in a fixed order', async () => {
  const { calls, client } = fakeSupabase();
  await withApp(client, async (get) => {
    const res = await get('/v1/stack-signal?type=signal&limit=5&offset=10');
    assert.equal(res.status, 200);
  });
  assert.deepStrictEqual(calls[0].orders, [['published_at', false], ['id', false]]);
  assert.deepStrictEqual(calls[0].range, [10, 14]);
});

// News items carry home_slug, the morning recap of their ET day once it
// exists, so troystack.com's cards can link to the anchor on the recap.
const FOLD_ROWS = [
  { slug: 'the-stack-signal-2026-10-19', is_stack_signal: true, published_at: '2026-10-19T11:15:10Z' },
  { slug: 'evening-signal-2026-10-19', is_stack_signal: true, published_at: '2026-10-19T21:30:09Z' },
  // 01:00 ET on 10/19.
  { slug: 'early-2026-10-19', is_stack_signal: false, published_at: '2026-10-19T05:00:00Z' },
  // 23:00 ET on 10/18, with no 10/18 recap.
  { slug: 'late-2026-10-19', is_stack_signal: null, published_at: '2026-10-19T03:00:00Z' },
  // 23:00 ET on 10/19, after UTC midnight.
  { slug: 'night-2026-10-20', is_stack_signal: false, published_at: '2026-10-20T03:00:00Z' },
  { slug: 'undated', is_stack_signal: false, published_at: null },
];

test('news items carry the home_slug of their ET day, recaps carry none', async () => {
  const { calls, client } = fakeSupabase(FOLD_ROWS);
  await withApp(client, async (get) => {
    const res = await get('/v1/stack-signal');
    assert.equal(res.status, 200);
    const by = Object.fromEntries(res.body.articles.map((a) => [a.slug, a]));
    assert.equal(by['early-2026-10-19'].home_slug, 'the-stack-signal-2026-10-19');
    assert.equal(by['night-2026-10-20'].home_slug, 'the-stack-signal-2026-10-19');
    assert.equal(by['late-2026-10-19'].home_slug, null);
    assert.equal(by['undated'].home_slug, null);
    assert.equal('home_slug' in by['the-stack-signal-2026-10-19'], false);
    assert.equal('home_slug' in by['evening-signal-2026-10-19'], false);
  });
  // One lookup for the whole page, for each day once, recaps only.
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].filters, { is_stack_signal: true });
  assert.deepEqual(calls[1].in[1].sort(), ['the-stack-signal-2026-10-18', 'the-stack-signal-2026-10-19']);
});

test('a page of recaps only skips the lookup', async () => {
  const { calls, client } = fakeSupabase(FOLD_ROWS);
  await withApp(client, async (get) => {
    const res = await get('/v1/stack-signal?type=signal');
    assert.equal(res.status, 200);
    assert.equal(res.body.articles.length, 2);
  });
  assert.equal(calls.length, 1);
});

test('a failed lookup still lists every item, with no home', async () => {
  const { client } = fakeSupabase(FOLD_ROWS, { failIn: true });
  await withApp(client, async (get) => {
    const res = await get('/v1/stack-signal?type=news');
    assert.equal(res.status, 200);
    assert.equal(res.body.articles.length, 4);
    for (const a of res.body.articles) assert.equal(a.home_slug, null);
  });
});
