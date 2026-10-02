#!/usr/bin/env node
// One-time backfill for price_log. Platinum and palladium were frozen while
// MetalPriceAPI was down, spring 2026 through the 9/26 switch to Yahoo: the
// fetcher kept re-logging its last value, so platinum read 2,098.09 and
// palladium 1,560.02 for months. This puts each frozen value back to Yahoo's
// daily settlement for its day.
//
//   node scripts/backfill-ptpd.js            dry run, prints what would change
//   node scripts/backfill-ptpd.js --apply    writes the changes
//   node scripts/backfill-ptpd.js --from 2026-04-01 --to 2026-09-27
//
// Reads SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY from .env like the server.
//
// A value counts as frozen when the exact same number shows up on two or more
// UTC days in the window (live prices don't repeat to the cent across days)
// and sits more than 1 percent off Yahoo's close for its day. Live rows,
// correct rows, nulls and gold and silver are never touched.

const DEFAULT_FROM = '2026-04-01';
const DEFAULT_TO = '2026-09-27';
const THRESHOLD = 0.01;
const PAGE = 1000;
const MAX_PAGES = 500;
const ID_CHUNK = 150;
const METALS = [
  { metal: 'platinum', column: 'platinum_price', symbol: 'PL=F' },
  { metal: 'palladium', column: 'palladium_price', symbol: 'PA=F' },
];
const DAY_MS = 24 * 60 * 60 * 1000;

const round2 = (n) => Math.round(n * 100) / 100;
const utcDate = (timestamp) => String(timestamp).split('T')[0];

function parseArgs(argv) {
  const args = { apply: false, from: DEFAULT_FROM, to: DEFAULT_TO };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--apply') args.apply = true;
    else if (argv[i] === '--from') args.from = argv[++i];
    else if (argv[i] === '--to') args.to = argv[++i];
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  for (const key of ['from', 'to']) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(args[key] || '')) throw new Error(`--${key} must be YYYY-MM-DD`);
  }
  if (args.from > args.to) throw new Error('--from is after --to');
  return args;
}

// Yahoo daily bars for one symbol, as [{ date, close }] oldest first. The bar
// date is the exchange's trading day, so Monday's settlement is Monday.
async function fetchYahooCloses(axios, symbol, from, to) {
  const period1 = Math.floor((Date.parse(`${from}T00:00:00Z`) - 7 * DAY_MS) / 1000);
  const period2 = Math.floor((Date.parse(`${to}T00:00:00Z`) + 2 * DAY_MS) / 1000);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?period1=${period1}&period2=${period2}&interval=1d`;
  const res = await axios.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TroyStack/1.0)' }, timeout: 15000 });
  const result = res?.data?.chart?.result?.[0];
  const stamps = result?.timestamp || [];
  const closes = result?.indicators?.quote?.[0]?.close || [];
  const offset = result?.meta?.gmtoffset || 0;
  const bars = [];
  stamps.forEach((t, i) => {
    if (typeof closes[i] === 'number' && closes[i] > 0) {
      bars.push({ date: new Date((t + offset) * 1000).toISOString().slice(0, 10), close: round2(closes[i]) });
    }
  });
  if (bars.length === 0) throw new Error(`Yahoo returned no daily bars for ${symbol}`);
  return bars.sort((a, b) => a.date.localeCompare(b.date));
}

// The close for a day, or the last one before it for weekends and holidays.
function closeOn(bars, date) {
  let found = null;
  for (const bar of bars) {
    if (bar.date > date) break;
    found = bar.close;
  }
  return found;
}

// Every price_log row in [from, to], oldest first, paged past Supabase's
// 1,000-row cap.
async function readRows(supabase, from, to) {
  const start = `${from}T00:00:00Z`;
  const end = new Date(Date.parse(`${to}T00:00:00Z`) + DAY_MS).toISOString();
  const rows = [];
  let cursor = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    let query = supabase
      .from('price_log')
      .select('id, timestamp, platinum_price, palladium_price')
      .lt('timestamp', end);
    query = cursor ? query.gt('timestamp', cursor) : query.gte('timestamp', start);
    const { data, error } = await query.order('timestamp', { ascending: true }).limit(PAGE);
    if (error) throw new Error(`price_log page ${page + 1} failed: ${error.message}`);
    if (!data || data.length === 0) return rows;
    rows.push(...data);
    const next = data[data.length - 1].timestamp;
    if (data.length < PAGE || next === cursor) return rows;
    cursor = next;
  }
  throw new Error(`price_log read stopped at ${MAX_PAGES} pages, narrow --from and --to`);
}

// Pure planning step. Returns, per metal, the updates grouped by day.
function planBackfill(rows, barsByMetal, threshold = THRESHOLD) {
  const plan = {};
  for (const { metal, column } of METALS) {
    const bars = barsByMetal[metal] || [];
    const daysByValue = new Map();
    for (const row of rows) {
      const value = parseFloat(row[column]);
      if (!(value > 0)) continue;
      if (!daysByValue.has(value)) daysByValue.set(value, new Set());
      daysByValue.get(value).add(utcDate(row.timestamp));
    }

    const byDay = new Map();
    for (const row of rows) {
      const value = parseFloat(row[column]);
      if (!(value > 0) || daysByValue.get(value).size < 2) continue;
      const date = utcDate(row.timestamp);
      const close = closeOn(bars, date);
      if (!close || Math.abs(value - close) / close <= threshold) continue;
      if (!byDay.has(date)) byDay.set(date, { date, close, ids: [], oldValues: new Set() });
      const day = byDay.get(date);
      day.ids.push(row.id);
      day.oldValues.add(value);
    }

    const days = [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date));
    plan[metal] = {
      column,
      days,
      rowCount: days.reduce((n, d) => n + d.ids.length, 0),
    };
  }
  return plan;
}

async function applyPlan(supabase, plan, log = console.log) {
  let written = 0;
  for (const { column, days } of Object.values(plan)) {
    for (const day of days) {
      for (let i = 0; i < day.ids.length; i += ID_CHUNK) {
        const ids = day.ids.slice(i, i + ID_CHUNK);
        const { error } = await supabase.from('price_log').update({ [column]: day.close }).in('id', ids);
        if (error) throw new Error(`update of ${column} on ${day.date} failed after ${written} rows: ${error.message}`);
        written += ids.length;
      }
    }
    log(`   ${column}: ${days.reduce((n, d) => n + d.ids.length, 0)} rows written`);
  }
  return written;
}

function describe(plan, log = console.log) {
  for (const [metal, { rowCount, days }] of Object.entries(plan)) {
    if (days.length === 0) {
      log(`${metal}: nothing to change`);
      continue;
    }
    log(`${metal}: ${rowCount} rows on ${days.length} days, ${days[0].date} to ${days[days.length - 1].date}`);
    const step = Math.max(1, Math.floor(days.length / 8));
    for (let i = 0; i < days.length; i += step) {
      const d = days[i];
      log(`   ${d.date}  ${[...d.oldValues].join(', ')} -> ${d.close}  (${d.ids.length} rows)`);
    }
  }
}

async function main(argv = process.argv.slice(2), deps = {}) {
  const args = parseArgs(argv);
  const axios = deps.axios || require('axios');
  const supabase = deps.supabase || require('../src/lib/supabase');
  const log = deps.log || console.log;

  log(`price_log platinum and palladium backfill, ${args.from} to ${args.to}, ${args.apply ? 'APPLY' : 'dry run'}`);
  const barsByMetal = {};
  for (const { metal, symbol } of METALS) {
    barsByMetal[metal] = await fetchYahooCloses(axios, symbol, args.from, args.to);
    log(`   Yahoo ${symbol}: ${barsByMetal[metal].length} daily closes`);
  }
  const rows = await readRows(supabase, args.from, args.to);
  log(`   price_log: ${rows.length} rows read`);

  const plan = planBackfill(rows, barsByMetal);
  describe(plan, log);

  if (!args.apply) {
    log('Dry run, nothing written. Run again with --apply to write these changes.');
    return { plan, written: 0 };
  }
  const written = await applyPlan(supabase, plan, log);
  log(`Done, ${written} values written.`);
  return { plan, written };
}

module.exports = { parseArgs, fetchYahooCloses, closeOn, readRows, planBackfill, applyPlan, main };

if (require.main === module) {
  require('dotenv').config();
  main().catch((err) => {
    console.error(`Backfill failed: ${err.message}`);
    process.exit(1);
  });
}
