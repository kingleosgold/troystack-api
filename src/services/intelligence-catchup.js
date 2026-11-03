// One intelligence generation per UTC day, and a catch-up after a restart
// that missed it.
//
// The 11:30 UTC cron lives in the process. A deploy around 11:30 can stop
// the old instance mid-run, and the new instance starts after the minute has
// passed, so nothing runs that day and intelligence_briefs stays empty until
// tomorrow. That happened on 11/3.
//
// Two app_state rows keep it to one run a day across restarts and replicas.
// intelligence_run_<day> is a lease. An instance that inserts it runs the
// generation. A lease older than LEASE_MS belongs to a run that died, so
// another instance clears it and claims the day again. A run that inserts no
// briefs, or throws, gives its lease back. intelligence_done_<day> marks a
// run that inserted briefs, and nothing runs again that day.
//
// The cron and the catch-up both go through runOncePerDay. The catch-up runs
// a minute after a start that came after 11:30:00 UTC. If another instance
// holds a fresh lease, it looks again once the lease would have run out.

const CRON_MS_UTC = (11 * 60 + 30) * 60 * 1000;
const START_DELAY_MS = 60 * 1000;
const LEASE_MS = 20 * 60 * 1000;
const UNIQUE_VIOLATION = '23505';
const crypto = require('node:crypto');

function utcDay(t) {
  return new Date(t).toISOString().split('T')[0];
}

// True from 11:30:00.000 UTC. A server that starts in that second or later
// has missed node-cron's tick for the day.
function afterCron(t) {
  const d = new Date(t);
  const msOfDay = ((d.getUTCHours() * 60 + d.getUTCMinutes()) * 60 + d.getUTCSeconds()) * 1000 + d.getUTCMilliseconds();
  return msOfDay >= CRON_MS_UTC;
}

function runKey(day) { return `intelligence_run_${day}`; }
function doneKey(day) { return `intelligence_done_${day}`; }

async function isDone(supabase, day) {
  const { data, error } = await supabase.from('app_state').select('key').eq('key', doneKey(day)).maybeSingle();
  if (error) throw new Error(`done check failed: ${error.message}`);
  return Boolean(data);
}

// Returns { won: true } or { won: false, reason }.
// The lease's value is a jsonb object with a token, so a run only ever gives
// back its own lease, never one another instance took over.
async function claimDay(supabase, day, now) {
  const token = crypto.randomUUID();
  const row = () => ({ key: runKey(day), value: { claimed_at: new Date(now).toISOString(), token } });
  let { error } = await supabase.from('app_state').insert(row());
  if (!error) return { won: true, token };
  if (error.code !== UNIQUE_VIOLATION) return { won: false, reason: `claim failed: ${error.code || ''} ${error.message}`.trim() };

  // Someone holds the day. Clear the lease only if it's stale, then try once
  // more. A fresh lease is never deleted, so two instances can't both win.
  const cutoff = new Date(now - LEASE_MS).toISOString();
  const { error: clearError } = await supabase.from('app_state').delete().eq('key', runKey(day)).lt('updated_at', cutoff);
  if (clearError) return { won: false, reason: `stale lease clear failed: ${clearError.message}` };
  ({ error } = await supabase.from('app_state').insert(row()));
  if (!error) return { won: true, token };
  if (error.code === UNIQUE_VIOLATION) return { won: false, reason: 'another run holds today', held: true };
  return { won: false, reason: `claim failed: ${error.code || ''} ${error.message}`.trim() };
}

async function releaseDay(supabase, day, token, log) {
  const { error } = await supabase.from('app_state').delete().eq('key', runKey(day)).contains('value', { token });
  if (error) log(`🧠 [Intelligence] Lease release failed: ${error.message}`);
}

// Runs the generation if today isn't done and this instance wins the lease.
async function runOncePerDay({ supabase, run, log = console.log, now = Date.now(), who = 'cron' }) {
  const day = utcDay(now);
  if (await isDone(supabase, day)) return { ran: false, reason: `${day} already done` };
  const claim = await claimDay(supabase, day, now);
  if (!claim.won) return { ran: false, reason: claim.reason, held: Boolean(claim.held) };

  log(`🧠 [Intelligence ${who}] Running for ${day}`);
  let result;
  try {
    result = await run();
  } catch (err) {
    await releaseDay(supabase, day, claim.token, log);
    throw err;
  }
  if (result && result.briefsInserted > 0) {
    const { error } = await supabase.from('app_state').insert({ key: doneKey(day), value: { briefs: result.briefsInserted } });
    if (error && error.code !== UNIQUE_VIOLATION) log(`🧠 [Intelligence] Done mark failed: ${error.message}`);
  } else {
    await releaseDay(supabase, day, claim.token, log);
  }
  const briefs = result ? result.briefsInserted : 0;
  log(`🧠 [Intelligence ${who}] Done: ${briefs} briefs`);
  // A run that inserted nothing, like one where every search failed, gave
  // the day back and gets the same one retry as a held lease.
  if (!(briefs > 0)) return { ran: false, reason: 'no briefs inserted', result };
  return { ran: true, result };
}

// The catch-up's check, a minute after start. bootTime decides whether the
// start missed today's cron.
async function catchUpIntelligence({ supabase, run, log = console.log, bootTime, now = Date.now() }) {
  if (!afterCron(bootTime)) return { ran: false, reason: 'started before the cron' };
  // A server started late on one day and checked after midnight UTC would
  // look at a day whose cron hasn't fired yet.
  if (utcDay(now) !== utcDay(bootTime)) return { ran: false, reason: 'day changed' };
  return runOncePerDay({ supabase, run, log, now, who: 'catch-up' });
}

// Runs attempt() now, and once more after a lease would have run out when
// it didn't run for any reason other than the day being done or a guard
// saying it isn't this instance's day. That covers a lease held by a run
// that may have died, a database error on the check or the claim, and a
// generation that threw. The retry only fires on the same UTC day.
function withOneRetry(label, attempt, { retryMs = LEASE_MS + 60 * 1000, setTimer = setTimeout, now = () => Date.now(), log = console.log, logError = console.error } = {}) {
  const firstDay = utcDay(now());
  const go = (isRetry) => attempt()
    .then(r => {
      if (r.ran) return;
      log(`🧠 [Intelligence ${label}] Skipped: ${r.reason}`);
      if (!isRetry && r.retry) arm();
    })
    .catch(err => {
      logError(`🧠 [Intelligence ${label}] Failed: ${err.message}`);
      if (!isRetry) arm();
    });
  const arm = () => {
    const t = setTimer(() => {
      if (utcDay(now()) !== firstDay) return;
      go(true);
    }, retryMs);
    if (t && t.unref) t.unref();
  };
  return go(false);
}

// Whether a result that didn't run is worth one more look later.
function retryable(r) {
  return !r.ran && !/already done|before the cron|day changed/.test(r.reason || '');
}

function attemptWith(fn) {
  return () => fn().then(r => ({ ...r, retry: retryable(r) }));
}

// The 11:30 UTC cron's handler.
function runCronOncePerDay() {
  const supabase = require('../lib/supabase');
  const { runIntelligenceGeneration } = require('../routes/intelligence');
  return withOneRetry('Cron', attemptWith(() => runOncePerDay({ supabase, run: runIntelligenceGeneration, who: 'Cron' })));
}

function scheduleIntelligenceCatchUp({ delayMs = START_DELAY_MS } = {}) {
  const bootTime = Date.now();
  const timer = setTimeout(() => {
    const supabase = require('../lib/supabase');
    const { runIntelligenceGeneration } = require('../routes/intelligence');
    withOneRetry('catch-up', attemptWith(() => catchUpIntelligence({ supabase, run: runIntelligenceGeneration, bootTime })));
  }, delayMs);
  if (timer.unref) timer.unref();
  return timer;
}

module.exports = {
  LEASE_MS,
  afterCron,
  utcDay,
  claimDay,
  runOncePerDay,
  catchUpIntelligence,
  scheduleIntelligenceCatchUp,
  runCronOncePerDay,
  withOneRetry,
  retryable,
};
