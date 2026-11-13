#!/usr/bin/env node
// One-time backfill for price_log. Platinum and palladium were frozen while
// MetalPriceAPI was out of quota, spring 2026 through the 9/26 switch to
// Yahoo: the fetcher kept logging the same fallback numbers, so platinum read
// 2,098.09 and palladium 1,560.02 for months. This puts each frozen value back
// to Yahoo's daily settlement for its day.
//
//   node scripts/backfill-ptpd.js                  dry run, prints what would change
//   node scripts/backfill-ptpd.js --apply          writes the changes and an undo file
//   node scripts/backfill-ptpd.js --undo FILE      puts the old values back from that file
//   node scripts/backfill-ptpd.js --from 2026-04-01 --to 2026-09-27
//
// Reads SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY from .env like the server.
//
// A value counts as frozen when the exact same number sits on five or more
// UTC days in the window. Live quotes don't do that: on 10/2 the only values
// that repeated on more than two days were 2,098.09 (135 days) and 1,560.02
// (136 days), and every other repeat was a real quote on two days. A frozen
// row is replaced only when it's more than 1 percent off Yahoo's close for its
// day. Live rows, nulls, gold and silver are never touched.

const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_FROM = '2026-04-01';
const DEFAULT_TO = '2026-09-27';
const THRESHOLD = 0.01;
const MIN_FROZEN_DAYS = 5;
const PAGE = 1000;
const MAX_PAGES = 500;
const ID_CHUNK = 150;
const METALS = [
  { metal: 'platinum', column: 'platinum_price', symbol: 'PL=F' },
  { metal: 'palladium', column: 'palladium_price', symbol: 'PA=F' },
];
const COLUMNS = new Set(METALS.map((m) => m.column));
const DAY_MS = 24 * 60 * 60 * 1000;

const round2 = (n) => Math.round(n * 100) / 100;
const utcDate = (timestamp) => String(timestamp).split('T')[0];

// YYYY-MM-DD that names a real day. Date.parse would quietly turn 2026-02-31
// into March 3, so the date has to survive a round trip.
function isRealDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

function parseArgs(argv) {
  const args = { apply: false, undo: null, from: DEFAULT_FROM, to: DEFAULT_TO };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--apply') args.apply = true;
    else if (argv[i] === '--undo') args.undo = argv[++i] || '';
    else if (argv[i] === '--from') args.from = argv[++i];
    else if (argv[i] === '--to') args.to = argv[++i];
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  if (args.undo !== null) {
    if (!args.undo) throw new Error('--undo needs the path of the undo file');
    if (args.apply) throw new Error('--undo and --apply can\'t run together');
    return args;
  }
  for (const key of ['from', 'to']) {
    if (!isRealDate(args[key])) throw new Error(`--${key} must be a real date, YYYY-MM-DD`);
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

// Every price_log row in [from, to], paged past Supabase's 1,000-row cap.
// Pages walk the unique id, because timestamps can repeat and a page that
// ends inside a run of equal timestamps would drop the rest of that run.
async function readRows(supabase, from, to) {
  const start = `${from}T00:00:00Z`;
  const end = new Date(Date.parse(`${to}T00:00:00Z`) + DAY_MS).toISOString();
  const rows = [];
  let lastId = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    let query = supabase
      .from('price_log')
      .select('id, timestamp, platinum_price, palladium_price')
      .gte('timestamp', start)
      .lt('timestamp', end);
    if (lastId !== null) query = query.gt('id', lastId);
    const { data, error } = await query.order('id', { ascending: true }).limit(PAGE);
    if (error) throw new Error(`price_log page ${page + 1} failed: ${error.message}`);
    if (!data || data.length === 0) return rows;
    rows.push(...data);
    if (data.length < PAGE) return rows;
    lastId = data[data.length - 1].id;
  }
  throw new Error(`price_log read stopped at ${MAX_PAGES} pages, narrow --from and --to`);
}

// Pure planning step. Returns, per metal, the frozen values found and the
// updates grouped by day.
function planBackfill(rows, barsByMetal, { threshold = THRESHOLD, minDays = MIN_FROZEN_DAYS } = {}) {
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
    const frozen = [...daysByValue.entries()]
      .filter(([, days]) => days.size >= minDays)
      .map(([value, days]) => ({ value, days: days.size }))
      .sort((a, b) => b.days - a.days);
    const frozenValues = new Set(frozen.map((f) => f.value));

    const byDay = new Map();
    for (const row of rows) {
      const value = parseFloat(row[column]);
      if (!frozenValues.has(value)) continue;
      const date = utcDate(row.timestamp);
      const close = closeOn(bars, date);
      if (!close || Math.abs(value - close) / close <= threshold) continue;
      if (!byDay.has(date)) byDay.set(date, { date, close, ids: [], olds: [], oldValues: new Set() });
      const day = byDay.get(date);
      day.ids.push(row.id);
      day.olds.push(value);
      day.oldValues.add(value);
    }

    const days = [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date));
    plan[metal] = {
      column,
      frozen,
      days,
      rowCount: days.reduce((n, d) => n + d.ids.length, 0),
    };
  }
  return plan;
}

// What --undo needs to put every planned row back: per column and old value,
// the row ids.
function undoRecord(plan, args) {
  const entries = [];
  for (const { column, days } of Object.values(plan)) {
    const byOld = new Map();
    for (const day of days) {
      day.ids.forEach((id, i) => {
        const old = day.olds[i];
        if (!byOld.has(old)) byOld.set(old, []);
        byOld.get(old).push(id);
      });
    }
    for (const [value, ids] of byOld) entries.push({ column, value, ids });
  }
  return { script: 'backfill-ptpd', from: args.from, to: args.to, writtenAt: new Date().toISOString(), entries };
}

async function updateIds(supabase, column, value, ids) {
  let written = 0;
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const chunk = ids.slice(i, i + ID_CHUNK);
    const { error } = await supabase.from('price_log').update({ [column]: value }).in('id', chunk);
    if (error) throw new Error(`update of ${column} failed after ${written} rows: ${error.message}`);
    written += chunk.length;
  }
  return written;
}

async function applyPlan(supabase, plan, log = console.log) {
  let written = 0;
  for (const { column, days } of Object.values(plan)) {
    let forColumn = 0;
    for (const day of days) {
      try {
        forColumn += await updateIds(supabase, column, day.close, day.ids);
      } catch (err) {
        throw new Error(`${err.message} (${day.date}, ${written + forColumn} rows written before it)`);
      }
    }
    written += forColumn;
    log(`   ${column}: ${forColumn} rows written`);
  }
  return written;
}

async function undo(supabase, record, log = console.log) {
  if (record?.script !== 'backfill-ptpd' || !Array.isArray(record.entries)) throw new Error('that file is not a backfill-ptpd undo file');
  let written = 0;
  for (const { column, value, ids } of record.entries) {
    if (!COLUMNS.has(column)) throw new Error(`undo file names an unexpected column ${column}`);
    if (!(value > 0) || !Array.isArray(ids)) throw new Error(`undo entry for ${column} is malformed`);
    written += await updateIds(supabase, column, value, ids);
    log(`   ${column}: ${ids.length} rows back to ${value}`);
  }
  return written;
}

function describe(plan, log = console.log) {
  for (const [metal, { rowCount, days, frozen }] of Object.entries(plan)) {
    const found = frozen.map((f) => `${f.value} on ${f.days} days`).join(', ') || 'none';
    log(`${metal}: frozen values ${found}`);
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
  const files = deps.fs || fs;

  if (args.undo !== null) {
    const record = JSON.parse(files.readFileSync(args.undo, 'utf8'));
    log(`price_log platinum and palladium backfill, UNDO from ${args.undo}`);
    const written = await undo(supabase, record, log);
    log(`Done, ${written} values put back.`);
    return { written };
  }

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
  const record = undoRecord(plan, args);
  const undoPath = path.join(deps.undoDir || os.tmpdir(), `backfill-ptpd-undo-${record.writtenAt.replace(/[:.]/g, '-')}.json`);
  files.writeFileSync(undoPath, JSON.stringify(record));
  log(`   undo file: ${undoPath}`);
  const written = await applyPlan(supabase, plan, log);
  log(`Done, ${written} values written. To put them back: node scripts/backfill-ptpd.js --undo "${undoPath}"`);
  return { plan, written, undoPath };
}

module.exports = { parseArgs, fetchYahooCloses, closeOn, readRows, planBackfill, undoRecord, applyPlan, undo, main, MIN_FROZEN_DAYS };

if (require.main === module) {
  require('dotenv').config();
  main().catch((err) => {
    console.error(`Backfill failed: ${err.message}`);
    process.exit(1);
  });
}
