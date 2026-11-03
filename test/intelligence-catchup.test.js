// Tests for the intelligence catch-up after a restart that missed the 11:30
// UTC cron. Supabase and the generation are faked.
//   node --test

const test = require('node:test');
const assert = require('node:assert');

const { catchUpIntelligence, afterCron } = require('../src/services/intelligence-catchup');

function fakeSupabase({ count = 0, countError = null, lockTaken = false } = {}) {
  const calls = { inserts: [], counted: [] };
  return {
    calls,
    from(table) {
      return {
        select() {
          return { eq: async (col, val) => { calls.counted.push([table, col, val]); return { count, error: countError }; } };
        },
        insert: async (row) => { calls.inserts.push([table, row]); return { error: lockTaken ? { message: 'duplicate key' } : null }; },
      };
    },
  };
}

const T = (iso) => Date.parse(iso);
const result = { briefsInserted: 6, vaultInserted: 4 };

test('afterCron is true from 11:30:01 UTC', () => {
  assert.strictEqual(afterCron(T('2026-11-03T11:29:59Z')), false);
  assert.strictEqual(afterCron(T('2026-11-03T11:30:00Z')), false);
  assert.strictEqual(afterCron(T('2026-11-03T11:30:01Z')), true);
  assert.strictEqual(afterCron(T('2026-11-03T23:59:59Z')), true);
});

test('a restart after the cron on a day with no briefs claims the day and runs once', async () => {
  const sb = fakeSupabase();
  let runs = 0;
  const r = await catchUpIntelligence({ supabase: sb, run: async () => { runs++; return result; }, log: () => {}, bootTime: T('2026-11-03T11:30:01Z'), now: T('2026-11-03T11:31:01Z') });
  assert.strictEqual(r.ran, true);
  assert.strictEqual(runs, 1);
  assert.deepStrictEqual(sb.calls.counted, [['intelligence_briefs', 'date', '2026-11-03']]);
  assert.strictEqual(sb.calls.inserts[0][0], 'app_state');
  assert.strictEqual(sb.calls.inserts[0][1].key, 'intelligence_catchup_2026-11-03');
});

test('it leaves the day alone when it started before the cron, briefs exist, the day is claimed or the count fails', async () => {
  const cases = [
    [{}, T('2026-11-03T11:29:00Z'), T('2026-11-03T11:30:00Z'), /before the cron/],
    [{ count: 8 }, T('2026-11-03T12:00:00Z'), T('2026-11-03T12:01:00Z'), /8 briefs already/],
    [{ lockTaken: true }, T('2026-11-03T12:00:00Z'), T('2026-11-03T12:01:00Z'), /already claimed/],
    [{ countError: { message: 'timeout' } }, T('2026-11-03T12:00:00Z'), T('2026-11-03T12:01:00Z'), /count failed: timeout/],
    [{}, T('2026-11-03T23:59:30Z'), T('2026-11-04T00:00:30Z'), /day changed/],
  ];
  for (const [opts, bootTime, now, reason] of cases) {
    let runs = 0;
    const r = await catchUpIntelligence({ supabase: fakeSupabase(opts), run: async () => { runs++; return result; }, log: () => {}, bootTime, now });
    assert.strictEqual(r.ran, false);
    assert.match(r.reason, reason);
    assert.strictEqual(runs, 0);
  }
});
