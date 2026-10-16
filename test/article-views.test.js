// Signal article views, on the path the iPhone app calls.
//   node --test
// Pure in-process tests: supabase is replaced with an in-memory fake, and the
// router runs in a throwaway express app on a local port.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const express = require('express');

process.env.SUPABASE_URL ||= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-dummy-service-role-key';

const ARTICLE = '33333333-3333-4333-8333-333333333333';
const MISSING = '44444444-4444-4444-8444-444444444444';
const USER = '11111111-1111-4111-8111-111111111111';

// Holds the two tables the view route touches.
function fakeSupabase({ insertError = null } = {}) {
  const db = {
    articles: { [ARTICLE]: { view_count: 4 } },
    views: [],
  };
  function query(table) {
    const filters = {};
    let patch = null;
    const chain = {
      select() { return chain; },
      eq(col, val) { filters[col] = val; return chain; },
      limit() { return chain; },
      update(values) { patch = values; return chain; },
      insert(row) {
        if (!insertError) db.views.push(row);
        return Promise.resolve({ error: insertError });
      },
      single() {
        if (table === 'stack_signal_articles') {
          return Promise.resolve({ data: db.articles[filters.id] || null });
        }
        const hit = db.views.find((v) => Object.entries(filters).every(([k, val]) => v[k] === val));
        return Promise.resolve({ data: hit || null });
      },
      then(resolve) {
        if (patch && table === 'stack_signal_articles') Object.assign(db.articles[filters.id], patch);
        return Promise.resolve({ error: null }).then(resolve);
      },
    };
    return chain;
  }
  return { db, client: { from: query } };
}

function loadSocialRouter(client) {
  const supabasePath = require.resolve(path.join(__dirname, '..', 'src', 'lib', 'supabase'));
  const socialPath = require.resolve(path.join(__dirname, '..', 'src', 'routes', 'social'));
  delete require.cache[socialPath];
  require.cache[supabasePath] = { id: supabasePath, filename: supabasePath, loaded: true, exports: client };
  try {
    return require(socialPath);
  } finally {
    delete require.cache[supabasePath];
    delete require.cache[socialPath];
  }
}

// Mounts the router the way index.js does and runs fn against it.
async function withApp(client, fn) {
  const router = loadSocialRouter(client);
  const app = express();
  app.use(express.json());
  app.use('/v1/stack-signal', router);
  app.use('/v1', router);
  app.use((req, res) => res.status(404).json({ error: 'Not found' }));
  const server = app.listen(0);
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    await fn((p, body) => fetch(base + p, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(async (r) => ({ status: r.status, body: await r.json() })));
  } finally {
    server.close();
  }
}

test('index.js serves the social routes at /v1 too', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');
  assert.ok(src.includes("app.use('/v1/stack-signal', publicLimiter, socialRouter);"));
  assert.ok(src.includes("app.use('/v1', publicLimiter, socialRouter);"));
});

test('a view on the app path is recorded and answers the new count', async () => {
  const { db, client } = fakeSupabase();
  await withApp(client, async (post) => {
    const res = await post(`/v1/articles/${ARTICLE}/view`, { userId: USER });
    assert.equal(res.status, 200);
    assert.equal(res.body.view_count, 5);
    assert.equal(db.articles[ARTICLE].view_count, 5);
    assert.equal(db.views.length, 1);
  });
});

test('the same viewer twice counts once', async () => {
  const { db, client } = fakeSupabase();
  await withApp(client, async (post) => {
    await post(`/v1/stack-signal/articles/${ARTICLE}/view`, { deviceId: 'phone-1' });
    const again = await post(`/v1/articles/${ARTICLE}/view`, { deviceId: 'phone-1' });
    assert.equal(again.body.view_count, 5);
    assert.equal(db.views.length, 1);
  });
});

test('an article that does not exist records nothing', async () => {
  const { db, client } = fakeSupabase();
  await withApp(client, async (post) => {
    const missing = await post(`/v1/articles/${MISSING}/view`, { deviceId: 'phone-1' });
    assert.equal(missing.status, 404);
    const bad = await post('/v1/articles/null/view', { deviceId: 'phone-1' });
    assert.equal(bad.status, 400);
    assert.equal(db.views.length, 0);
  });
});

test('a failed insert is an error, not a silent success', async () => {
  const { db, client } = fakeSupabase({ insertError: { message: 'permission denied' } });
  await withApp(client, async (post) => {
    const res = await post(`/v1/articles/${ARTICLE}/view`, { deviceId: 'phone-1' });
    assert.equal(res.status, 500);
    assert.equal(db.articles[ARTICLE].view_count, 4);
  });
});
