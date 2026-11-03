// Tests for one intelligence run a day and the catch-up after a restart that
// missed the 11:30 UTC cron. Supabase and the generation are faked.
//   node --test

const test = require('node:test');
const assert = require('node:assert');

const ic = require('../src/services/intelligence-catchup');

const T = (iso) => Date.parse(iso);

// An app_state table with a unique key and updated_at, like production.
function fakeSupabase({ rows = {}, failInsert = null, clock = () => Date.now() } = {}) {
  const table = { ...rows }; // key -> { value, updated_at (ms) }
  const api = {
    table,
    from(name) {
      assert.strictEqual(name, 'app_state');
      return {
        insert: async (row) => {
          if (failInsert) return { error: failInsert };
          if (table[row.key]) return { error: { code: '23505', message: 'duplicate key' } };
          table[row.key] = { value: row.value, updated_at: clock() };
          return { error: null };
        },
        select: () => ({
          eq: (col, key) => ({ maybeSingle: async () => ({ data: table[key] ? { key } : null, error: null }) }),
        }),
        delete: () => ({
          eq: (col, key) => ({
            // Awaited directly, it deletes the row. With .lt, only a stale one.
            then: (resolve, reject) => Promise.resolve().then(() => { delete table[key]; return { error: null }; }).then(resolve, reject),
            lt: async (c, cutoff) => {
              if (table[key] && table[key].updated_at < Date.parse(cutoff)) delete table[key];
              return { error: null };
            },
          }),
        }),
      };
    },
  };
  return api;
}

const ok = async () => ({ briefsInserted: 6 });
const quiet = () => {};

test('afterCron is true from 11:30:00.000 UTC', () => {
  assert.strictEqual(ic.afterCron(T('2026-11-03T11:29:59.999Z')), false);
  assert.strictEqual(ic.afterCron(T('2026-11-03T11:30:00.000Z')), true);
  assert.strictEqual(ic.afterCron(T('2026-11-03T11:30:00.500Z')), true);
  assert.strictEqual(ic.afterCron(T('2026-11-03T23:59:59Z')), true);
});

test('a restart after the cron runs the day once and marks it done', async () => {
  const now = T('2026-11-03T11:31:01Z');
  const sb = fakeSupabase({ clock: () => now });
  let runs = 0;
  const r = await ic.catchUpIntelligence({ supabase: sb, run: async () => { runs++; return ok(); }, log: quiet, bootTime: T('2026-11-03T11:30:01Z'), now });
  assert.strictEqual(r.ran, true);
  assert.ok(sb.table['intelligence_done_2026-11-03']);
  const again = await ic.catchUpIntelligence({ supabase: sb, run: async () => { runs++; return ok(); }, log: quiet, bootTime: T('2026-11-03T12:00:00Z'), now: T('2026-11-03T12:01:00Z') });
  assert.strictEqual(again.ran, false);
  assert.match(again.reason, /already done/);
  assert.strictEqual(runs, 1);
});

test('the catch-up leaves the day to the cron when it started before 11:30, and skips across midnight', async () => {
  for (const [bootTime, now, reason] of [
    [T('2026-11-03T11:29:00Z'), T('2026-11-03T11:30:00Z'), /before the cron/],
    [T('2026-11-03T23:59:30Z'), T('2026-11-04T00:00:30Z'), /day changed/],
  ]) {
    let runs = 0;
    const r = await ic.catchUpIntelligence({ supabase: fakeSupabase(), run: async () => { runs++; return ok(); }, log: quiet, bootTime, now });
    assert.strictEqual(r.ran, false);
    assert.match(r.reason, reason);
    assert.strictEqual(runs, 0);
  }
});

test('a fresh lease from another run blocks a second run and says it is held', async () => {
  const now = T('2026-11-03T11:32:00Z');
  const sb = fakeSupabase({ rows: { 'intelligence_run_2026-11-03': { value: '"x"', updated_at: T('2026-11-03T11:30:00Z') } }, clock: () => now });
  let runs = 0;
  const r = await ic.runOncePerDay({ supabase: sb, run: async () => { runs++; return ok(); }, log: quiet, now });
  assert.deepStrictEqual([r.ran, r.held], [false, true]);
  assert.strictEqual(runs, 0);
  assert.ok(sb.table['intelligence_run_2026-11-03']);
});

test('a stale lease from a run that died is taken over', async () => {
  const now = T('2026-11-03T11:55:00Z');
  const sb = fakeSupabase({ rows: { 'intelligence_run_2026-11-03': { value: '"x"', updated_at: T('2026-11-03T11:30:00Z') } }, clock: () => now });
  let runs = 0;
  const r = await ic.runOncePerDay({ supabase: sb, run: async () => { runs++; return ok(); }, log: quiet, now });
  assert.strictEqual(r.ran, true);
  assert.strictEqual(runs, 1);
});

test('a run that inserts nothing or throws gives the day back', async () => {
  const now = T('2026-11-03T11:31:00Z');
  const sb = fakeSupabase({ clock: () => now });
  await ic.runOncePerDay({ supabase: sb, run: async () => ({ briefsInserted: 0 }), log: quiet, now });
  assert.deepStrictEqual(Object.keys(sb.table), []);
  await assert.rejects(ic.runOncePerDay({ supabase: sb, run: async () => { throw new Error('gemini down'); }, log: quiet, now }), /gemini down/);
  assert.deepStrictEqual(Object.keys(sb.table), []);
  const r = await ic.runOncePerDay({ supabase: sb, run: ok, log: quiet, now });
  assert.strictEqual(r.ran, true);
});

test('a claim error that is not a duplicate key is reported as itself', async () => {
  const sb = fakeSupabase({ failInsert: { code: '42501', message: 'permission denied' } });
  const r = await ic.runOncePerDay({ supabase: sb, run: ok, log: quiet, now: T('2026-11-03T11:31:00Z') });
  assert.strictEqual(r.ran, false);
  assert.match(r.reason, /42501 permission denied/);
});
