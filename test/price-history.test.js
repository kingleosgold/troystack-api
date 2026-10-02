// GET /v1/prices/history and the MCP get_price_history tool share one daily
// series built from every page of price_log, not the first 1,000 rows.
//   node --test
// In-process only: supabase is replaced with a fake, no network.

process.env.TZ = 'UTC';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

process.env.SUPABASE_URL ||= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-dummy-service-role-key';

const SRC = path.join(__dirname, '..', 'src');
const SUPABASE_PATH = require.resolve(path.join(SRC, 'lib', 'supabase'));
const DAY_MS = 24 * 60 * 60 * 1000;
const STEP_MS = 5 * 60 * 1000;

function fakeModule(filename, exports) {
  return { id: filename, filename, loaded: true, exports };
}

// Load `target` with a fake supabase. routes/prices.js is reloaded with it
// either way, so each test starts with an empty daily cache.
function loadWith(target, supabase) {
  const paths = [target, 'routes/prices'].map((t) => require.resolve(path.join(SRC, t)));
  const saved = require.cache[SUPABASE_PATH];
  for (const p of paths) delete require.cache[p];
  require.cache[SUPABASE_PATH] = fakeModule(SUPABASE_PATH, supabase);
  try {
    return require(paths[0]);
  } finally {
    for (const p of paths) delete require.cache[p];
    if (saved) require.cache[SUPABASE_PATH] = saved; else delete require.cache[SUPABASE_PATH];
  }
}

// 40 days of 5-minute rows ending now, the shape price_log has after
// decimation. The first row of each UTC day carries base + day index and the
// rest of the day sits a quarter higher, so a test can tell which row won.
function makeRows(days = 40) {
  const now = Date.now();
  const firstDay = Math.floor(now / DAY_MS) * DAY_MS - (days - 1) * DAY_MS;
  const rows = [];
  for (let t = firstDay; t <= now; t += STEP_MS) {
    const d = Math.floor((t - firstDay) / DAY_MS);
    const bump = t % DAY_MS === 0 ? 0 : 0.25;
    rows.push({
      timestamp: new Date(t).toISOString().replace('Z', '+00:00'),
      gold_price: 4000 + d + bump,
      silver_price: 50 + d + bump,
      platinum_price: 1700 + d + bump,
      palladium_price: 1100 + d + bump,
    });
  }
  const dayIndex = (date) => (Date.parse(`${date}T00:00:00Z`) - firstDay) / DAY_MS;
  return { rows, dayIndex };
}

// Answers the query chain the code uses, caps every select at 1,000 rows like
// Supabase does, and returns only the columns that were asked for.
function fakeSupabase(rows) {
  const calls = [];
  return {
    calls,
    from(table) {
      assert.strictEqual(table, 'price_log');
      const q = { cols: '', gt: null, asc: true, limit: Infinity };
      const builder = {
        select(cols) { q.cols = cols; return builder; },
        gt(col, value) { assert.strictEqual(col, 'timestamp'); q.gt = value; return builder; },
        order(col, opts) { assert.strictEqual(col, 'timestamp'); q.asc = opts?.ascending !== false; return builder; },
        limit(n) { q.limit = n; return builder; },
        then(resolve, reject) {
          calls.push({ ...q });
          const after = q.gt == null ? -Infinity : Date.parse(q.gt);
          const picked = rows
            .filter((r) => Date.parse(r.timestamp) > after)
            .sort((a, b) => (Date.parse(a.timestamp) - Date.parse(b.timestamp)) * (q.asc ? 1 : -1))
            .slice(0, Math.min(q.limit, 1000));
          const cols = q.cols.split(',').map((c) => c.trim());
          const data = picked.map((r) => Object.fromEntries(cols.map((c) => [c, r[c]])));
          return Promise.resolve({ data, error: null }).then(resolve, reject);
        },
      };
      return builder;
    },
  };
}

function isoDate(d) {
  return d.toISOString().split('T')[0];
}

function datesBetween(start, end) {
  const out = [];
  for (let t = Date.parse(`${start}T00:00:00Z`); t <= Date.parse(`${end}T00:00:00Z`); t += DAY_MS) {
    out.push(isoDate(new Date(t)));
  }
  return out;
}

function oneMonthAgo() {
  const now = new Date();
  return isoDate(new Date(now.getFullYear(), now.getMonth() - 1, now.getDate()));
}

test('1M history has a point for every day through today, past the 1,000-row cap', async () => {
  const { rows, dayIndex } = makeRows();
  const supabase = fakeSupabase(rows);
  const { buildPriceHistory } = loadWith('routes/prices', supabase);

  const got = await buildPriceHistory({ metal: 'platinum', range: '1M', maxPoints: '1000' });
  const today = isoDate(new Date());

  assert.deepStrictEqual(got.prices.map((p) => p.date), datesBetween(oneMonthAgo(), today));
  for (const p of got.prices.slice(0, -1)) {
    assert.strictEqual(p.price, 1700 + dayIndex(p.date), `${p.date} should be that day's first price_log row`);
  }
  assert.ok(supabase.calls.length > 1, 'read more than one page');
  assert.ok(supabase.calls.every((c) => c.limit <= 1000), 'no single select asks for more than 1,000 rows');
  assert.ok(supabase.calls.every((c) => c.cols.includes('platinum_price')), 'reads the *_price columns');
});

test('one price_log scan serves the next request for another metal', async () => {
  const { rows, dayIndex } = makeRows();
  const supabase = fakeSupabase(rows);
  const { buildPriceHistory } = loadWith('routes/prices', supabase);

  await buildPriceHistory({ metal: 'gold', range: '1M', maxPoints: '1000' });
  const scans = supabase.calls.length;
  const silver = await buildPriceHistory({ metal: 'silver', range: '1M', maxPoints: '1000' });

  assert.strictEqual(supabase.calls.length, scans, 'the second request used the cached series');
  const yesterday = isoDate(new Date(Date.now() - DAY_MS));
  assert.strictEqual(silver.prices.find((p) => p.date === yesterday).price, 50 + dayIndex(yesterday));
});

test('a bad metal is a 400, not a 500', async () => {
  const { buildPriceHistory } = loadWith('routes/prices', fakeSupabase([]));
  await assert.rejects(buildPriceHistory({ metal: 'copper' }), (err) => err.status === 400);
  await assert.rejects(buildPriceHistory({ metal: 'gold', range: '2W' }), (err) => err.status === 400);
});

test('MCP get_price_history returns current daily points', async () => {
  const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
  const { rows, dayIndex } = makeRows();
  const { createMcpServer } = loadWith('routes/mcp', fakeSupabase(rows));

  const server = createMcpServer();
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'price-history-test', version: '1.0.0' });
  await client.connect(clientSide);

  try {
    const month = await client.callTool({ name: 'get_price_history', arguments: { metal: 'silver', range: '1M' } });
    assert.ok(!month.isError, 'the tool call succeeds');
    const body = JSON.parse(month.content[0].text);
    const today = isoDate(new Date());
    const yesterday = isoDate(new Date(Date.now() - DAY_MS));

    assert.strictEqual(body.metal, 'silver');
    assert.strictEqual(body.range, '1M');
    assert.strictEqual(body.unit, 'USD/oz');
    assert.strictEqual(body.count, body.points.length);
    assert.deepStrictEqual(body.points.map((p) => p.date), datesBetween(oneMonthAgo(), today));
    assert.strictEqual(body.points.find((p) => p.date === yesterday).price, 50 + dayIndex(yesterday));

    const all = JSON.parse((await client.callTool({ name: 'get_price_history', arguments: { metal: 'gold', range: 'ALL' } })).content[0].text);
    assert.ok(all.count > 0 && all.count <= 120, `ALL is sampled to at most 120 points, got ${all.count}`);
    assert.strictEqual(all.points.at(-1).date, today);
  } finally {
    await client.close();
    await server.close();
  }
});
