// Each metal's all-time high and its 1 year, 5 year and all-time ranges, for
// Troy. Without them the only history in his prompt was the stack's last 30
// days, and asked when silver would hit its all-time high again he called a
// 30 day high "the recent high" and said he had no record figure.
//
// Two sources, the same ones the app's charts use:
// - data/historical-prices.json, gold and silver monthly averages from 1915.
//   A monthly average sits below that month's intraday high, so it never
//   stands in for a record, it only shows whether an older peak could beat
//   one TroyStack recorded.
// - price_log, TroyStack's own spot readings, kept as daily rows past a year.
//   The ranges use the first reading of each day and the record uses the
//   highest reading in the table.
//
// The record is kept current two ways: price_log logs live spot every minute
// and the record is reread each minute, and every question sets live spot
// against it, so Troy knows the minute one is broken. The decimator never
// deletes a record row (services/price-log-decimator.js), so thinning
// price_log can't lower a record. Anything the data can't back is left out
// and Troy is told he doesn't have it.

const fs = require('fs');
const path = require('path');

const METALS = ['gold', 'silver', 'platinum', 'palladium'];
const DAY_MS = 86400000;

// A record has to show up in more than one reading. One bad row, like the
// old $2,700 platinum placeholder scripts/patch-ptpd-outliers.js cleaned up,
// would otherwise become an all-time high. Price_log keeps at least one row a
// day, so a real peak always has a neighbor within a day and a half.
const TOP_ROWS = 50;
const NEIGHBOR_MS = 1.5 * DAY_MS;
const NEIGHBORS = 1;
const PLACEHOLDERS = { platinum: [2700], palladium: [2000] };
// How many of the highest rows are checked in their own window, and how close
// a neighbor there has to be.
const WINDOW_CHECKS = 5;
const NEAR_SHARE = 0.9;

// The 1980 peaks ran about 30% over their months' averages, so a high
// TroyStack recorded counts as the all-time high only when it clears every
// earlier monthly average by more than that.
const MONTHLY_MARGIN = 1.35;
const LIVE_RECORD_MAX = 1.1;

// Platinum and palladium have no monthly history before price_log. Palladium's
// published record, March 2022's, stands until TroyStack records a higher
// one. Platinum's was broken around the turn of 2026, possibly while its
// price_log readings were frozen (API #15), so no figure is known to be its
// record and Troy gets only the highest TroyStack has recorded.
const PRIOR_RECORDS = {
  palladium: { price: 3440, when: 'March 2022' },
};

const RANGES = [
  { key: '1y', label: '1 year', years: 1 },
  { key: '5y', label: '5 years', years: 5 },
];

let monthlyCache = null;
function monthlyHistory() {
  if (!monthlyCache) {
    try {
      monthlyCache = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'data', 'historical-prices.json'), 'utf8'));
    } catch (e) {
      console.log(`[Troy History] historical-prices.json unavailable: ${e.message}`);
      monthlyCache = {};
    }
  }
  return monthlyCache;
}

function name(metal) {
  return metal.charAt(0).toUpperCase() + metal.slice(1);
}

function usd(n) {
  return `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// Calendar dates are kept as YYYY-MM-DD and read as noon UTC, so no time
// zone moves them to the day before.
function dayLabel(date) {
  const d = new Date(`${String(date).slice(0, 10)}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

function monthLabel(month) {
  const d = new Date(`${month}-15T12:00:00Z`);
  return d.toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
}

// A reading's own day in New York, the day the app and Troy's other dates use.
function nyDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

function pct(from, to) {
  return ((to - from) / from) * 100;
}

function signed(p) {
  return `${p >= 0 ? 'up' : 'down'} ${Math.abs(p).toFixed(1)}%`;
}

/**
 * The highest reading among a metal's top rows that has company: at least
 * NEIGHBORS other top rows within NEIGHBOR_MS of it. Pure, for tests.
 * @param {{ timestamp: string, price: number }[]} rows highest first
 */
function confirmedHigh(rows, metal) {
  const skip = PLACEHOLDERS[metal] || [];
  const usable = (rows || [])
    .map((r) => ({ id: r.id, timestamp: r.timestamp, price: Number(r.price), at: new Date(r.timestamp).getTime() }))
    .filter((r) => r.price > 0 && Number.isFinite(r.at) && !skip.includes(r.price))
    .sort((a, b) => b.price - a.price);
  for (const r of usable) {
    // A much lower reading nearby doesn't vouch for a spike.
    const company = usable.filter((o) => o !== r && Math.abs(o.at - r.at) <= NEIGHBOR_MS && o.price >= r.price * NEAR_SHARE);
    if (company.length >= NEIGHBORS) {
      // The neighbor is kept through decimation too, so the record stays confirmed.
      const neighborId = company[0].id;
      return { price: r.price, date: nyDate(r.timestamp), ...(r.id != null && { id: r.id }), ...(neighborId != null && { neighborId }) };
    }
  }
  return null;
}

/**
 * A metal's all-time high from what's known, or why there isn't one.
 * Pure, for tests.
 * @param {{ metal: string, recorded: { price: number, date: string } | null, since: string | null,
 *           monthly: object, live?: number | null, today?: string }} p
 */
function allTimeHigh({ metal, recorded, since, monthly, live, today }) {
  let high = recorded;
  // Live spot over the record is a new one, the minute it happens. With no
  // record to beat it's only a reading, not a record, and where the record
  // isn't known it's never passed off as one TroyStack recorded.
  // A jump of more than 10% is what the price fetcher's spike guard keeps out
  // of price_log as a likely bad quote, so it isn't a record here either.
  if (high && live > high.price && live <= high.price * LIVE_RECORD_MAX && today) high = { price: live, date: today, live: true };
  const prior = PRIOR_RECORDS[metal];
  if (prior) {
    if (high && high.price > prior.price) return { metal, known: true, ...high };
    return { metal, known: true, price: prior.price, when: prior.when, prior: true, recorded, since };
  }
  if (!high) return { metal, known: false, since };
  // No history before price_log and no published record: unknown.
  if (metal !== 'gold' && metal !== 'silver') return { metal, known: false, since, recorded };

  // Gold and silver: the highest monthly average before price_log began.
  const startMonth = since ? since.slice(0, 7) : null;
  let before = null;
  for (const [month, m] of Object.entries(monthly || {})) {
    const v = Number(m && m[metal]);
    if (!(v > 0) || (startMonth && month >= startMonth)) continue;
    if (!before || v > before.price) before = { price: v, month };
  }
  if (!before || high.price > before.price * MONTHLY_MARGIN) return { metal, known: true, ...high };
  return { metal, known: false, since, recorded, before };
}

// The series a range is read from: monthly averages for the months before
// price_log began (gold and silver only), then price_log's first reading of
// each day.
function seriesFor(metal, { monthly, daily, since }) {
  const points = [];
  const startMonth = since ? since.slice(0, 7) : null;
  if (metal === 'gold' || metal === 'silver') {
    for (const [month, m] of Object.entries(monthly || {})) {
      const v = Number(m && m[metal]);
      if (v > 0 && (!startMonth || month < startMonth)) points.push({ date: `${month}-15`, price: v, month });
    }
  }
  const skip = PLACEHOLDERS[metal] || [];
  for (const [date, d] of Object.entries(daily || {})) {
    const v = Number(d && d[metal]);
    if (v > 0 && !skip.includes(v)) points.push({ date, price: v });
  }
  return points.sort((a, b) => a.date.localeCompare(b.date));
}

function pointLabel(p) {
  return p.month ? `${monthLabel(p.month)} monthly average` : dayLabel(p.date);
}

function yearsBefore(today, years) {
  const d = new Date(`${today}T12:00:00Z`);
  d.setUTCFullYear(d.getUTCFullYear() - years);
  return d.toISOString().slice(0, 10);
}

/**
 * One line for one range, or the reason there isn't one. Pure, for tests.
 */
function rangeLine(metal, range, { series, today, live, ath, since }) {
  const start = yearsBefore(today, range.years);
  const first = series[0];
  // The range has to reach back to its start, with a reading close to it.
  const opening = series.filter((p) => p.date <= start).pop();
  const lead = `${name(metal)}, ${range.label}:`;
  if (!first || !opening || (!opening.month && new Date(start) - new Date(opening.date) > 7 * DAY_MS)) {
    return since ? `${lead} not in TroyStack's records, which start ${dayLabel(since)} for ${metal}.` : `${lead} not in TroyStack's records.`;
  }
  // A reading over a known record is one the record check threw out.
  const cap = ath && ath.known ? ath.price : Infinity;
  const inside = series.filter((p) => p.date > start && p.price <= cap);
  const all = [opening, ...inside];
  let low = all[0];
  let high = all[0];
  for (const p of all) {
    if (p.price < low.price) low = p;
    if (p.price > high.price) high = p;
  }
  // The record is a real reading, so it tops a range it falls in.
  let highText = `${usd(high.price)} (${pointLabel(high)})`;
  if (ath && ath.known && !ath.prior && ath.date && ath.date > start && ath.price > high.price) {
    highText = `${usd(ath.price)} (${dayLabel(ath.date)}, the all-time high)`;
  }
  const now = live > 0 ? `, ${signed(pct(opening.price, live))} to now` : '';
  return `${lead} started at ${usd(opening.price)} (${pointLabel(opening)})${now}. Low ${usd(low.price)} (${pointLabel(low)}), high ${highText}.`;
}

// Where spot sits against a record. Spot can be over one it wasn't allowed to
// replace, like a quote the spike guard held back, so the side is read from
// the sign.
function spotVs(record, live) {
  if (!(live > 0)) return '';
  const gap = pct(record, live);
  if (Math.abs(gap) < 0.05) return ' Spot is at it.';
  if (gap < 0) return ` Spot is ${Math.abs(gap).toFixed(1)}% below it.`;
  return ` Spot is ${gap.toFixed(1)}% above it, but that quote isn't confirmed, so it isn't counted as a record. Don't call it a new all-time high.`;
}

function athLine(metal, ath, live) {
  const n = name(metal);
  const since = ath.since ? dayLabel(ath.since) : null;
  const sinceText = since ? ` since ${since}` : '';
  if (!ath.known) {
    if (!ath.recorded) return `${n} all-time high: you don't have it.${since ? ` TroyStack's ${metal} records start ${since}.` : ''}`;
    const before = ath.before ? ` Before then you only have monthly averages, which peaked at ${usd(ath.before.price)} in ${monthLabel(ath.before.month)}, and a month's intraday high runs above its average.` : '';
    return `${n} all-time high: you don't have it. The highest ${metal} spot TroyStack has recorded${sinceText} is ${usd(ath.recorded.price)} on ${dayLabel(ath.recorded.date)}.${before}`;
  }
  if (ath.prior) {
    const ours = ath.recorded ? ` The highest TroyStack has recorded${sinceText} is ${usd(ath.recorded.price)} on ${dayLabel(ath.recorded.date)}.` : '';
    return `${n} all-time high: ${usd(ath.price)}, set in ${ath.when}, before TroyStack's records.${ours}${spotVs(ath.price, live)}`;
  }
  if (ath.live) return `${n} all-time high: ${usd(ath.price)}, current spot, a new record set today.`;
  return `${n} all-time high: ${usd(ath.price)} on ${dayLabel(ath.date)}, the highest spot TroyStack has recorded.${spotVs(ath.price, live)}`;
}

/**
 * The prompt block. Pure, for tests.
 * @param {{ data?: { highs?: object, monthly?: object, daily?: object, since?: object } | null,
 *           live?: object, today?: string }} p
 *   live holds each metal's current spot only when it was read live.
 */
function buildHistoryBlock({ data, live = {}, today, promote = true } = {}) {
  if (!data || !today) return '';
  const lines = [];
  for (const metal of METALS) {
    const since = data.since?.[metal] || null;
    const spot = Number(live[metal]) > 0 ? Number(live[metal]) : null;
    const ath = allTimeHigh({ metal, recorded: data.highs?.[metal] || null, since, monthly: data.monthly, live: spot, today: promote ? today : null });
    const series = seriesFor(metal, { monthly: data.monthly, daily: data.daily, since });
    lines.push(athLine(metal, ath, spot));
    for (const range of RANGES) lines.push(rangeLine(metal, range, { series, today, live: spot, ath, since }));
    const first = series[0];
    if (first) lines.push(`${name(metal)}, all time: TroyStack's records start ${pointLabel(first)} at ${usd(first.price)}.`);
  }
  return `PRICE HISTORY AND RECORDS (spot, USD per oz):\n${lines.join('\n')}\nThese are the only all-time highs and long-range figures you have. Quote them with their dates. An all-time high here is the highest spot TroyStack recorded, unless its line says it was set before TroyStack's records, so call it that if asked, since a market's intraday peak can sit a little above it. A range's figures come from TroyStack's first reading of each day, or a monthly average where it says so, so an intraday high can run above them. Never call a recent or 30 day high the all-time high. When a figure isn't here, say plainly that you don't have it before anything else, and don't estimate it.`;
}

/**
 * The daily series and where each metal's records start. The series is the
 * one the history route already keeps cached.
 * @param {{ getDailyPriceLog: () => Promise<object> }} deps
 */
async function readSeries({ getDailyPriceLog }) {
  const daily = (await getDailyPriceLog()) || {};
  const since = {};
  for (const metal of METALS) {
    const days = Object.keys(daily).filter((d) => Number(daily[d] && daily[d][metal]) > 0).sort();
    since[metal] = days[0] || null;
  }
  return { daily, since, monthly: monthlyHistory() };
}

/**
 * Each metal's record row: four small reads, cheap enough to repeat each minute.
 * @param {{ db: object }} deps
 */
async function readHighs({ db }) {
  const highs = {};
  await Promise.all(METALS.map(async (metal) => {
    const column = `${metal}_price`;
    const { data, error } = await db
      .from('price_log')
      .select(`id, timestamp, ${column}`)
      .gt(column, 0)
      .order(column, { ascending: false })
      .limit(TOP_ROWS);
    if (error) throw new Error(`${metal} high read failed: ${error.message}`);
    const rows = (data || []).map((r) => ({ id: r.id, timestamp: r.timestamp, price: r[column] }));
    highs[metal] = confirmedHigh(rows, metal);
    // Months later a run just under the record can fill the top rows, leaving
    // the record's thinned-out neighbors outside them. The highest rows are
    // then checked against their own day and a half instead.
    const skip = PLACEHOLDERS[metal] || [];
    const candidates = rows.filter((r) => Number(r.price) > 0 && !skip.includes(Number(r.price))).slice(0, WINDOW_CHECKS);
    for (const r of candidates) {
      if (highs[metal] && highs[metal].price >= Number(r.price)) break;
      const at = new Date(r.timestamp).getTime();
      if (!Number.isFinite(at)) continue;
      const { data: near, error: nearErr } = await db
        .from('price_log')
        .select('id')
        .gte('timestamp', new Date(at - NEIGHBOR_MS).toISOString())
        .lte('timestamp', new Date(at + NEIGHBOR_MS).toISOString())
        .gte(column, Number(r.price) * NEAR_SHARE)
        .neq('id', r.id)
        .limit(1);
      if (nearErr) throw new Error(`${metal} high check failed: ${nearErr.message}`);
      if (near && near.length) {
        highs[metal] = { price: Number(r.price), date: nyDate(r.timestamp), ...(r.id != null && { id: r.id }), ...(near[0].id != null && { neighborId: near[0].id }) };
        break;
      }
    }
  }));
  return highs;
}

// The ids of the rows the records come from and the neighbors that confirm
// them, for the decimator to keep.
async function recordRowIds({ db }) {
  const highs = await readHighs({ db });
  return METALS.flatMap((m) => (highs[m] ? [highs[m].id, highs[m].neighborId] : [])).filter((id) => id != null);
}

module.exports = {
  buildHistoryBlock,
  readSeries,
  readHighs,
  recordRowIds,
  confirmedHigh,
  allTimeHigh,
  seriesFor,
  rangeLine,
  PRIOR_RECORDS,
  MONTHLY_MARGIN,
};
