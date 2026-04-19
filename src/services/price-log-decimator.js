/**
 * TroyStack price_log decimator
 *
 * Keeps the price_log table bounded while preserving analytic fidelity:
 *   - Last 24h:             full 60s resolution (untouched)
 *   - 24h .. 30d:           one row per 5-minute bucket
 *   - 30d .. 365d:          one row per 1-hour bucket
 *   - older than 365d:      one row per day, closest to 16:00 America/New_York
 *
 * Rows that survive a pass are stamped with `decimated_to` so future runs skip
 * them (null < '5min' < '1hour' < 'daily').
 *
 * Safety rails:
 *   - If a pass has more than SAFETY_MAX_DELETIONS_PER_PASS candidate rows,
 *     it aborts and logs an error (one-off manual decimation required).
 *   - Per bucket the survivor is MARKED first, then the non-survivors are
 *     deleted — so the "survivor exists" invariant holds at every moment
 *     even though supabase-js can't wrap this in a true transaction.
 *   - Progress is logged every 1000 deletions.
 */

const supabase = require('../lib/supabase');

const LEVEL_FIVE_MIN = '5min';
const LEVEL_ONE_HOUR = '1hour';
const LEVEL_DAILY = 'daily';

const SAFETY_MAX_DELETIONS_PER_PASS = 50000;
const PROGRESS_LOG_EVERY = 1000;
const FETCH_PAGE = 1000;
const DELETE_BATCH = 500;

// ---------- time helpers ----------

function isoHoursAgo(h) { return new Date(Date.now() - h * 3600 * 1000).toISOString(); }
function isoDaysAgo(d)  { return new Date(Date.now() - d * 86400 * 1000).toISOString(); }

function fiveMinBucketKey(iso) {
  const d = new Date(iso);
  d.setUTCSeconds(0, 0);
  d.setUTCMinutes(Math.floor(d.getUTCMinutes() / 5) * 5);
  return d.getTime();
}

function hourBucketKey(iso) {
  const d = new Date(iso);
  d.setUTCMinutes(0, 0, 0);
  return d.getTime();
}

const etDayFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York',
  year: 'numeric', month: '2-digit', day: '2-digit',
});
function etDayKey(iso) {
  const parts = {};
  for (const p of etDayFmt.formatToParts(new Date(iso))) parts[p.type] = p.value;
  return `${parts.year}-${parts.month}-${parts.day}`;
}

const etTimeFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  hour: '2-digit', minute: '2-digit', hour12: false,
});
function etMinutesOfDay(iso) {
  const parts = {};
  for (const p of etTimeFmt.formatToParts(new Date(iso))) parts[p.type] = p.value;
  const h = parseInt(parts.hour, 10);
  const m = parseInt(parts.minute, 10);
  return (h % 24) * 60 + m;
}

// ---------- keeper pickers ----------
// Each takes an array of rows (guaranteed same bucket) and returns the one to keep.

function pickClosestToBucketStart(rows, bucketStartMs) {
  let best = rows[0];
  let bestDiff = Infinity;
  for (const r of rows) {
    const diff = Math.abs(new Date(r.timestamp).getTime() - bucketStartMs);
    if (diff < bestDiff) { bestDiff = diff; best = r; }
  }
  return best;
}

function pickClosestToMarketClose(rows) {
  const TARGET_MIN = 16 * 60;
  let best = rows[0];
  let bestDiff = Infinity;
  for (const r of rows) {
    const diff = Math.abs(etMinutesOfDay(r.timestamp) - TARGET_MIN);
    if (diff < bestDiff) { bestDiff = diff; best = r; }
  }
  return best;
}

// ---------- core pass ----------

/**
 * Runs a single decimation pass over a time window.
 * @param {object} p
 * @param {string} p.name            label for logs
 * @param {string} p.level           decimated_to value to stamp survivors with
 * @param {string} p.gte             ISO lower bound (inclusive) for timestamp
 * @param {string|null} p.lt         ISO upper bound (exclusive) for timestamp, or null for no upper bound
 * @param {string[]} p.excludeLevels rows whose decimated_to is in this list are skipped
 * @param {(iso:string)=>string|number} p.bucketKey
 * @param {(rows:any[], bucketKey:string|number)=>any} p.pickKeeper
 */
async function runPass(p) {
  const { name, level, gte, lt, excludeLevels, bucketKey, pickKeeper } = p;

  // ---- candidate count (and safety abort) ----
  let countQ = supabase
    .from('price_log')
    .select('*', { count: 'exact', head: true })
    .gte('timestamp', gte);
  if (lt) countQ = countQ.lt('timestamp', lt);
  if (excludeLevels.length) {
    countQ = countQ.or(`decimated_to.is.null,decimated_to.not.in.(${excludeLevels.join(',')})`);
  }
  const { count, error: countErr } = await countQ;
  if (countErr) throw new Error(`[${name}] count failed: ${countErr.message}`);

  const candidates = count || 0;
  console.log(`[PriceLogDecimator] ${name}: ${candidates} candidate rows in window`);

  if (candidates === 0) {
    return { aborted: false, candidates: 0, kept: 0, deleted: 0 };
  }
  if (candidates > SAFETY_MAX_DELETIONS_PER_PASS) {
    console.error(
      `[PriceLogDecimator] ${name}: ABORT — ${candidates} candidate rows exceeds ` +
      `safety cap of ${SAFETY_MAX_DELETIONS_PER_PASS}. Run a one-off manual decimation first.`
    );
    return { aborted: true, candidates, kept: 0, deleted: 0 };
  }

  // ---- fetch all candidate rows ordered by timestamp (stable, pre-mutation) ----
  const rows = [];
  let offset = 0;
  while (true) {
    let q = supabase
      .from('price_log')
      .select('id, timestamp, decimated_to')
      .gte('timestamp', gte)
      .order('timestamp', { ascending: true })
      .range(offset, offset + FETCH_PAGE - 1);
    if (lt) q = q.lt('timestamp', lt);
    if (excludeLevels.length) {
      q = q.or(`decimated_to.is.null,decimated_to.not.in.(${excludeLevels.join(',')})`);
    }
    const { data, error } = await q;
    if (error) throw new Error(`[${name}] fetch failed: ${error.message}`);
    if (!data || data.length === 0) break;
    rows.push(...data);
    if (data.length < FETCH_PAGE) break;
    offset += FETCH_PAGE;
  }

  // ---- group, pick keeper, mark + delete ----
  let kept = 0;
  let deleted = 0;
  let lastProgressLog = 0;
  const pendingDeleteIds = [];

  async function flushDeletes(force) {
    while (pendingDeleteIds.length >= (force ? 1 : DELETE_BATCH)) {
      const batch = pendingDeleteIds.splice(0, DELETE_BATCH);
      const { error } = await supabase.from('price_log').delete().in('id', batch);
      if (error) throw new Error(`[${name}] delete failed: ${error.message}`);
      deleted += batch.length;
      if (deleted - lastProgressLog >= PROGRESS_LOG_EVERY) {
        console.log(`[PriceLogDecimator] ${name}: ${deleted} deleted so far`);
        lastProgressLog = deleted;
      }
    }
  }

  async function closeBucket(bucketRows, bucketK) {
    if (!bucketRows.length) return;
    const keeper = pickKeeper(bucketRows, bucketK);
    const { error: upErr } = await supabase
      .from('price_log')
      .update({ decimated_to: level })
      .eq('id', keeper.id);
    if (upErr) throw new Error(`[${name}] update failed for id=${keeper.id}: ${upErr.message}`);
    kept += 1;
    for (const r of bucketRows) {
      if (r.id !== keeper.id) pendingDeleteIds.push(r.id);
    }
    await flushDeletes(false);
  }

  let currentKey = null;
  let bucketRows = [];
  for (const row of rows) {
    const k = bucketKey(row.timestamp);
    if (currentKey === null) currentKey = k;
    if (k !== currentKey) {
      await closeBucket(bucketRows, currentKey);
      bucketRows = [];
      currentKey = k;
    }
    bucketRows.push(row);
  }
  await closeBucket(bucketRows, currentKey);
  await flushDeletes(true);

  console.log(`[PriceLogDecimator] ${name}: kept=${kept}, deleted=${deleted}`);
  return { aborted: false, candidates, kept, deleted };
}

// ---------- public entrypoint ----------

async function decimatePriceLog() {
  const startedAt = Date.now();

  // Pass 1: 24h .. 30d → 5-minute buckets
  const pass1 = await runPass({
    name: 'pass1-5min',
    level: LEVEL_FIVE_MIN,
    gte: isoDaysAgo(30),
    lt: isoHoursAgo(24),
    excludeLevels: [LEVEL_FIVE_MIN, LEVEL_ONE_HOUR, LEVEL_DAILY],
    bucketKey: fiveMinBucketKey,
    pickKeeper: (rows, bucketStartMs) => pickClosestToBucketStart(rows, bucketStartMs),
  });

  // Pass 2: 30d .. 365d → 1-hour buckets
  const pass2 = await runPass({
    name: 'pass2-1hour',
    level: LEVEL_ONE_HOUR,
    gte: isoDaysAgo(365),
    lt: isoDaysAgo(30),
    excludeLevels: [LEVEL_ONE_HOUR, LEVEL_DAILY],
    bucketKey: hourBucketKey,
    pickKeeper: (rows, bucketStartMs) => pickClosestToBucketStart(rows, bucketStartMs),
  });

  // Pass 3: older than 365d → one row per ET calendar day, closest to 16:00 ET
  const pass3 = await runPass({
    name: 'pass3-daily',
    level: LEVEL_DAILY,
    gte: new Date(0).toISOString(),
    lt: isoDaysAgo(365),
    excludeLevels: [LEVEL_DAILY],
    bucketKey: etDayKey,
    pickKeeper: (rows) => pickClosestToMarketClose(rows),
  });

  const { count: remaining } = await supabase
    .from('price_log')
    .select('*', { count: 'exact', head: true });

  const elapsedMs = Date.now() - startedAt;
  const summary = { pass1, pass2, pass3, remaining: remaining || 0, elapsedMs };
  console.log(
    `[PriceLogDecimator] Summary: ` +
    `p1(del=${pass1.deleted}${pass1.aborted ? ',ABORTED' : ''}) ` +
    `p2(del=${pass2.deleted}${pass2.aborted ? ',ABORTED' : ''}) ` +
    `p3(del=${pass3.deleted}${pass3.aborted ? ',ABORTED' : ''}) ` +
    `remaining=${summary.remaining} elapsed=${elapsedMs}ms`
  );
  return summary;
}

module.exports = {
  decimatePriceLog,
};
