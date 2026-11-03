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
            // With .lt, only a stale row. With .contains, only one holding that token.
            contains: async (c, obj) => {
              if (table[key] && table[key].value && table[key].value.token === obj.token) delete table[key];
              return { error: null };
            },
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
  const empty = await ic.runOncePerDay({ supabase: sb, run: async () => ({ briefsInserted: 0 }), log: quiet, now });
  assert.deepStrictEqual([empty.ran, empty.reason, ic.retryable(empty)], [false, 'no briefs inserted', true]);
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

test('a run only gives back its own lease', async () => {
  const now = T('2026-11-03T11:31:00Z');
  const sb = fakeSupabase({ clock: () => now });
  await ic.runOncePerDay({
    supabase: sb,
    log: quiet,
    now,
    run: async () => {
      // Another instance took the lease over while this run went long.
      sb.table['intelligence_run_2026-11-03'] = { value: { token: 'theirs' }, updated_at: now };
      return { briefsInserted: 0 };
    },
  });
  assert.strictEqual(sb.table['intelligence_run_2026-11-03'].value.token, 'theirs');
});

function fakeTimers() {
  const timers = [];
  return { timers, setTimer: (fn, ms) => { timers.push({ fn, ms }); return {}; } };
}

test('withOneRetry looks once more after the lease on a held lease, an error or a throw, and not on a done day', async () => {
  const day = () => T('2026-11-03T11:31:00Z');
  for (const [first, armed] of [
    [{ ran: false, reason: 'another run holds today', retry: true }, true],
    [{ ran: false, reason: 'claim failed: 500', retry: true }, true],
    [new Error('done check failed: timeout'), true],
    [{ ran: false, reason: '2026-11-03 already done', retry: false }, false],
    [{ ran: true }, false],
  ]) {
    const { timers, setTimer } = fakeTimers();
    let calls = 0;
    const attempt = async () => { calls++; if (first instanceof Error && calls === 1) throw first; return calls === 1 ? first : { ran: true }; };
    await ic.withOneRetry('test', attempt, { setTimer, now: day, retryMs: 5 });
    assert.strictEqual(timers.length, armed ? 1 : 0, JSON.stringify(first.reason || first.message || first));
    if (armed) {
      timers[0].fn();
      await new Promise(r => setImmediate(r));
      assert.strictEqual(calls, 2);
    }
  }
});

test('withOneRetry tries only once more, and not on a new UTC day', async () => {
  let t = T('2026-11-03T11:31:00Z');
  const { timers, setTimer } = fakeTimers();
  let calls = 0;
  await ic.withOneRetry('test', async () => { calls++; return { ran: false, reason: 'held', retry: true }; }, { setTimer, now: () => t });
  timers[0].fn();
  await new Promise(r => setImmediate(r));
  assert.strictEqual(calls, 2);
  assert.strictEqual(timers.length, 1);

  const second = fakeTimers();
  calls = 0;
  t = T('2026-11-03T23:59:00Z');
  await ic.withOneRetry('test', async () => { calls++; return { ran: false, reason: 'held', retry: true }; }, { setTimer: second.setTimer, now: () => t });
  t = T('2026-11-04T00:20:00Z');
  second.timers[0].fn();
  await new Promise(r => setImmediate(r));
  assert.strictEqual(calls, 1);
});

test('retryable skips done days and days that are not this instance\'s', () => {
  assert.strictEqual(ic.retryable({ ran: false, reason: 'another run holds today' }), true);
  assert.strictEqual(ic.retryable({ ran: false, reason: 'claim failed: 42501 x' }), true);
  assert.strictEqual(ic.retryable({ ran: false, reason: '2026-11-03 already done' }), false);
  assert.strictEqual(ic.retryable({ ran: false, reason: 'started before the cron' }), false);
  assert.strictEqual(ic.retryable({ ran: false, reason: 'day changed' }), false);
  assert.strictEqual(ic.retryable({ ran: true }), false);
});
