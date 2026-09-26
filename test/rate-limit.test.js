// The public limiter counts each request once, however many of index.js's
// overlapping mounts ('/v1', '/', '/v1/troy' ...) the request passes through.
//   node --test
// In-process only: a local express app on a random port, no network.

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');
const rateLimit = require('express-rate-limit');

process.env.SUPABASE_URL ||= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-dummy-service-role-key';

function freshPublicLimiter() {
  const p = require.resolve('../src/middleware/rateLimit');
  delete require.cache[p];
  return require(p).publicLimiter;
}

// Same shape as index.js: one limiter mounted on overlapping prefixes ahead
// of the router that finally answers.
function appWithOverlappingMounts(limiter) {
  const app = express();
  const passThrough = express.Router();
  app.use('/v1', limiter, passThrough);
  app.use('/', limiter, passThrough);
  app.use('/v1', limiter, passThrough);
  app.use('/v1', limiter, passThrough);
  const troy = express.Router();
  troy.get('/conversations', (req, res) => res.json({ conversations: [] }));
  app.use('/v1/troy', limiter, troy);
  return app;
}

async function withServer(app, fn) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await fn(base);
  } finally {
    server.close();
    server.closeAllConnections();
  }
}

test('control: a bare limiter on overlapping mounts counts one request five times', async () => {
  const bare = rateLimit({ windowMs: 60 * 1000, max: 100, standardHeaders: true, legacyHeaders: false, validate: false });
  await withServer(appWithOverlappingMounts(bare), async (base) => {
    const res = await fetch(`${base}/v1/troy/conversations`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('ratelimit-remaining'), '95');
  });
});

test('publicLimiter counts one request once on the same mounts', async () => {
  await withServer(appWithOverlappingMounts(freshPublicLimiter()), async (base) => {
    const res = await fetch(`${base}/v1/troy/conversations`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('ratelimit-remaining'), '99');
  });
});

test('publicLimiter still refuses the 101st request in a minute', async () => {
  await withServer(appWithOverlappingMounts(freshPublicLimiter()), async (base) => {
    const statuses = [];
    for (let i = 0; i < 101; i++) {
      statuses.push((await fetch(`${base}/v1/troy/conversations`)).status);
    }
    assert.ok(statuses.slice(0, 100).every((s) => s === 200), 'the first 100 pass');
    assert.strictEqual(statuses[100], 429);
  });
});
