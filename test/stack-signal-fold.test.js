// The Signal fold: a news item names the morning recap of its ET day, and a
// morning recap lists that day's news, so troystack.com can fold one into the
// other.
//   node --test
// Pure in-process tests: supabase is replaced with an in-memory fake, and the
// router runs in a throwaway express app on a local port.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const express = require('express');

process.env.SUPABASE_URL ||= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-dummy-service-role-key';

const LONG = 'Paper gold, paper project, nothing for your stack';
const src = (name) => [{ name, url: `https://example.com/${name}`, title: `${name} headline` }];

const ROWS = [
  { id: 1, slug: 'the-stack-signal-2026-10-19', is_stack_signal: true, published_at: '2026-10-19T11:15:10Z', title: 'The Stack Signal' },
  { id: 2, slug: 'evening-signal-2026-10-19', is_stack_signal: true, published_at: '2026-10-19T21:30:09Z', title: 'Evening' },
  // 23:00 ET on 10/18, so the 10/18 recap's, which doesn't exist here.
  { id: 3, slug: 'late-2026-10-19', is_stack_signal: false, published_at: '2026-10-19T03:00:00Z', title: 'Late on the 18th', troy_one_liner: LONG, sources: src('A') },
  // 01:00 ET on 10/19, before the recap went out.
  { id: 5, slug: 'early-2026-10-19', is_stack_signal: false, published_at: '2026-10-19T05:00:00Z', title: 'Early', troy_one_liner: 'Fed', sources: src('B') },
  { id: 4, slug: 'tie-b-2026-10-19', is_stack_signal: null, published_at: '2026-10-19T15:00:00Z', title: 'Tie B', troy_one_liner: LONG, sources: [] },
  { id: 6, slug: 'tie-a-2026-10-19', is_stack_signal: false, published_at: '2026-10-19T15:00:00Z', title: 'Tie A', troy_one_liner: null, sources: null },
  // 23:00 ET on 10/19, after UTC midnight.
  { id: 7, slug: 'night-2026-10-20', is_stack_signal: false, published_at: '2026-10-20T03:00:00Z', title: 'Night', troy_one_liner: LONG, sources: src('C') },
  // 02:00 ET on 10/20, with no 10/20 recap yet.
  { id: 8, slug: 'today-2026-10-20', is_stack_signal: false, published_at: '2026-10-20T06:00:00Z', title: 'Today', troy_one_liner: LONG, sources: src('D') },
];

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function fakeSupabase(rows = ROWS) {
  const calls = [];
  function from() {
    const tests = [];
    const orders = [];
    let limit = Infinity;
    let mode = 'many';
    const chain = {
      select() { return chain; },
      eq(col, val) { tests.push((r) => r[col] === val); return chain; },
      or() { tests.push((r) => r.is_stack_signal === null || r.is_stack_signal === false); return chain; },
      gte(col, val) { tests.push((r) => Date.parse(r[col]) >= Date.parse(val)); return chain; },
      lt(col, val) { tests.push((r) => Date.parse(r[col]) < Date.parse(val)); return chain; },
      order(col, opts) { orders.push([col, opts?.ascending]); return chain; },
      limit(n) { limit = n; return chain; },
      single() { mode = 'single'; return chain; },
      maybeSingle() { mode = 'maybe'; return chain; },
      then(resolve) {
        calls.push({ orders: orders.slice(), limit, mode });
        let data = rows.filter((r) => tests.every((t) => t(r)));
        data.sort((a, b) => {
          for (const [col, asc] of orders) {
            const c = cmp(a[col], b[col]);
            if (c) return asc ? c : -c;
          }
          return 0;
        });
        data = data.slice(0, limit);
        if (mode === 'many') return Promise.resolve({ data, error: null }).then(resolve);
        if (data.length === 1) return Promise.resolve({ data: data[0], error: null }).then(resolve);
        if (mode === 'maybe' && data.length === 0) return Promise.resolve({ data: null, error: null }).then(resolve);
        return Promise.resolve({ data: null, error: { message: 'not one row' } }).then(resolve);
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

test('a morning recap lists its ET day of news, oldest first, ties by id', async () => {
  const { client } = fakeSupabase();
  await withApp(client, async (get) => {
    const res = await get('/v1/stack-signal/the-stack-signal-2026-10-19');
    assert.equal(res.status, 200);
    const news = res.body.article.news;
    assert.deepEqual(news.map((n) => n.slug), ['early-2026-10-19', 'tie-b-2026-10-19', 'tie-a-2026-10-19', 'night-2026-10-20']);
    assert.equal(res.body.article.home_slug, undefined);
  });
});

test('each listed item carries a usable one-liner or null, and its first source', async () => {
  const { client } = fakeSupabase();
  await withApp(client, async (get) => {
    const { body } = await get('/v1/stack-signal/the-stack-signal-2026-10-19');
    const [early, tieB, tieA, night] = body.article.news;
    assert.deepEqual(early, { title: 'Early', slug: 'early-2026-10-19', one_liner: null, source: 'B', source_url: 'https://example.com/B' });
    assert.equal(tieB.one_liner, LONG);
    assert.equal(tieB.source, null);
    assert.equal(tieA.source_url, null);
    assert.equal(night.source, 'C');
  });
});

test('other recaps carry neither news nor home_slug', async () => {
  const { client } = fakeSupabase();
  await withApp(client, async (get) => {
    const { body } = await get('/v1/stack-signal/evening-signal-2026-10-19');
    assert.equal(body.article.news, undefined);
    assert.equal(body.article.home_slug, undefined);
  });
});

test('a news item names the morning recap of its own ET day', async () => {
  const { client } = fakeSupabase();
  await withApp(client, async (get) => {
    for (const slug of ['early-2026-10-19', 'tie-b-2026-10-19', 'night-2026-10-20']) {
      const { body } = await get(`/v1/stack-signal/${slug}`);
      assert.equal(body.article.home_slug, 'the-stack-signal-2026-10-19', slug);
      assert.equal(body.article.news, undefined);
    }
  });
});

test('a news item whose day has no morning recap gets null', async () => {
  const { client } = fakeSupabase();
  await withApp(client, async (get) => {
    for (const slug of ['late-2026-10-19', 'today-2026-10-20']) {
      const { body } = await get(`/v1/stack-signal/${slug}`);
      assert.equal(body.article.home_slug, null, slug);
    }
  });
});

test('a busy day lists every item up to 200', async () => {
  const rows = [{ id: 0, slug: 'the-stack-signal-2026-03-02', is_stack_signal: true, published_at: '2026-03-02T12:15:00Z' }];
  for (let i = 1; i <= 210; i++) {
    const at = new Date(Date.parse('2026-03-02T05:00:00Z') + i * 60000).toISOString();
    rows.push({ id: i, slug: `n${i}`, is_stack_signal: false, published_at: at, title: `n${i}` });
  }
  const { calls, client } = fakeSupabase(rows);
  await withApp(client, async (get) => {
    const { body } = await get('/v1/stack-signal/the-stack-signal-2026-03-02');
    assert.equal(body.article.news.length, 200);
    assert.equal(body.article.news[0].slug, 'n1');
  });
  assert.deepEqual(calls[1].orders, [['published_at', true], ['id', true]]);
});

test('ET days follow daylight saving time', () => {
  const { client } = fakeSupabase();
  const { etDay } = loadRouter(client);
  assert.equal(etDay('2026-10-20T03:59:00Z'), '2026-10-19');
  assert.equal(etDay('2026-10-20T04:00:00Z'), '2026-10-20');
  assert.equal(etDay('2026-03-02T04:59:00Z'), '2026-03-01');
  assert.equal(etDay('2026-03-02T05:00:00Z'), '2026-03-02');
});
