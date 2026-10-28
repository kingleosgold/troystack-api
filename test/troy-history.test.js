// Troy's records and long-range history: services/troy-history.js. No network.
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildHistoryBlock, readHistory, confirmedHigh, allTimeHigh, seriesFor, PRIOR_RECORDS,
} = require('../src/services/troy-history');
const { buildMarketBlock, createMarketContext } = require('../src/services/troy-context');

const MONTHLY = {
  '1915-01': { gold: 19.25, silver: 0.51 },
  '1980-01': { gold: 675.3, silver: 38.8 },
  '2011-04': { gold: 1473.8, silver: 42.7 },
  '2020-10': { gold: 1900.3, silver: 24.3 },
  '2021-10': { gold: 1776.9, silver: 23.4 },
  '2024-10': { gold: 2690.1, silver: 32.6 },
  '2025-05': { gold: 3280.4, silver: 32.9 },
};

// A daily series from June 2025, with silver's peak on Jan 29, 2026 and the
// last 30 days topping out at $61.15, the case Troy got wrong on the phone.
function dailySeries() {
  const daily = {};
  const start = new Date('2025-06-02T12:00:00Z');
  for (let d = new Date(start); d <= new Date('2026-10-28T12:00:00Z'); d.setUTCDate(d.getUTCDate() + 1)) {
    const key = d.toISOString().slice(0, 10);
    let silver = 36;
    if (key >= '2025-10-01') silver = 50;
    if (key >= '2026-01-10' && key <= '2026-01-31') silver = 95;
    if (key >= '2026-02-01') silver = 70;
    if (key >= '2026-09-28') silver = 59;
    if (key === '2026-10-15') silver = 61.15;
    if (key === '2026-10-28') silver = 60.2;
    daily[key] = { gold: key >= '2026-01-01' ? 4400 : 3400, silver, platinum: 1500, palladium: 1100 };
  }
  return daily;
}

const SINCE = { gold: '2025-06-02', silver: '2025-06-02', platinum: '2025-06-02', palladium: '2025-06-02' };

function rowsAround(iso, prices) {
  const at = new Date(iso).getTime();
  return prices.map((price, i) => ({ timestamp: new Date(at + i * 3600000).toISOString(), price }));
}

test('the record needs company, so one bad reading is skipped', () => {
  const rows = [
    { timestamp: '2026-03-01T15:00:00Z', price: 140 },
    ...rowsAround('2026-01-29T15:00:00Z', [121.4, 119.8, 118.2]),
  ];
  assert.deepEqual(confirmedHigh(rows, 'silver'), { price: 121.4, date: '2026-01-29' });
  assert.equal(confirmedHigh([{ timestamp: '2026-01-29T15:00:00Z', price: 121.4 }], 'silver'), null);
});

test('the old platinum placeholder never becomes a record', () => {
  const rows = [...rowsAround('2025-07-01T15:00:00Z', [2700, 2700, 2700]), ...rowsAround('2026-01-20T15:00:00Z', [2450, 2440, 2430])];
  assert.deepEqual(confirmedHigh(rows, 'platinum'), { price: 2450, date: '2026-01-20' });
});

test('a recorded high beats the old monthly averages by a clear margin to count', () => {
  const ath = allTimeHigh({ metal: 'silver', recorded: { price: 121.4, date: '2026-01-29' }, since: '2025-06-02', monthly: MONTHLY });
  assert.equal(ath.known, true);
  assert.equal(ath.price, 121.4);
  // $45 recorded against April 2011's $42.70 average could lose to that month's intraday peak.
  const close = allTimeHigh({ metal: 'silver', recorded: { price: 45, date: '2025-07-01' }, since: '2025-06-02', monthly: MONTHLY });
  assert.equal(close.known, false);
  assert.equal(close.before.month, '2011-04');
});

test('platinum and palladium are set against their published records', () => {
  const pd = allTimeHigh({ metal: 'palladium', recorded: { price: 1900, date: '2026-01-20' }, since: '2025-06-02', monthly: MONTHLY });
  assert.equal(pd.prior, true);
  assert.equal(pd.price, PRIOR_RECORDS.palladium.price);
  const pt = allTimeHigh({ metal: 'platinum', recorded: { price: 2450, date: '2026-01-20' }, since: '2025-06-02', monthly: MONTHLY });
  assert.equal(pt.prior, undefined);
  assert.equal(pt.price, 2450);
});

test('live spot over the record is a new record today', () => {
  const ath = allTimeHigh({ metal: 'gold', recorded: { price: 4600, date: '2026-01-26' }, since: '2025-06-02', monthly: MONTHLY, live: 4650.5, today: '2026-10-28' });
  assert.deepEqual([ath.known, ath.price, ath.live], [true, 4650.5, true]);
  const block = buildHistoryBlock({
    data: { highs: { gold: { price: 4600, date: '2026-01-26' } }, monthly: MONTHLY, daily: dailySeries(), since: SINCE },
    live: { gold: 4650.5 },
    today: '2026-10-28',
  });
  assert.match(block, /Gold all-time high: \$4,650\.50, set today by current spot/);
});

test("Jon's question: silver's record, its date and how far spot is below it", () => {
  const block = buildHistoryBlock({
    data: {
      highs: { silver: { price: 121.4, date: '2026-01-29' }, gold: { price: 4600, date: '2026-01-26' } },
      monthly: MONTHLY,
      daily: dailySeries(),
      since: SINCE,
    },
    live: { silver: 60.2, gold: 4400 },
    today: '2026-10-28',
  });
  assert.match(block, /Silver all-time high: \$121\.40 on Jan 29, 2026\. Spot is 50\.4% below it\./);
  assert.match(block, /Silver, 1 year: started at \$50\.00 \(Oct 28, 2025\), up 20\.4% to now\. Low \$50\.00 \(Oct 28, 2025\), high \$121\.40 \(Jan 29, 2026, the all-time high\)\./);
  assert.match(block, /Silver, 5 years: started at \$23\.40 \(Oct 2021 monthly average\)/);
  assert.match(block, /Silver, all time: TroyStack's records start Jan 1915 monthly average at \$0\.51\./);
  assert.match(block, /Never call a recent or 30 day high the all-time high/);
  assert.match(block, /say plainly that you don't have it before anything else/);
  assert.ok(!/[—–]/.test(block), 'no long dashes reach Troy');
});

test('a range the records do not reach says so instead of guessing', () => {
  const block = buildHistoryBlock({
    data: { highs: {}, monthly: MONTHLY, daily: dailySeries(), since: SINCE },
    live: {},
    today: '2026-10-28',
  });
  assert.match(block, /Platinum, 5 years: not in TroyStack's records, which start Jun 2, 2025 for platinum\./);
  assert.match(block, /Gold all-time high: you don't have it\. TroyStack's gold records start Jun 2, 2025\./);
  assert.match(block, /Palladium all-time high: \$3,440\.00, set in March 2022, before TroyStack's records\./);
});

test('monthly averages fill only the months before the daily records', () => {
  const series = seriesFor('silver', { monthly: MONTHLY, daily: { '2025-06-02': { silver: 36 } }, since: '2025-06-02' });
  assert.deepEqual(series.map((p) => p.date), ['1915-01-15', '1980-01-15', '2011-04-15', '2020-10-15', '2021-10-15', '2024-10-15', '2025-05-15', '2025-06-02']);
  assert.equal(seriesFor('platinum', { monthly: MONTHLY, daily: {}, since: null }).length, 0);
});

test('readHistory asks price_log for each metal highest first and takes the daily series as given', async () => {
  const asked = [];
  const db = {
    from(table) {
      const q = { table, filters: [] };
      const chain = {
        select(cols) { q.cols = cols; return chain; },
        gt(col, v) { q.filters.push([col, v]); return chain; },
        order(col, opts) { q.order = [col, opts.ascending]; return chain; },
        limit(n) {
          q.limit = n;
          asked.push(q);
          const col = q.order[0];
          const rows = col === 'silver_price'
            ? rowsAround('2026-01-29T15:00:00Z', [121.4, 119.8, 118.2]).map((r) => ({ timestamp: r.timestamp, silver_price: r.price }))
            : [];
          return Promise.resolve({ data: rows, error: null });
        },
      };
      return chain;
    },
  };
  const data = await readHistory({ db, getDailyPriceLog: async () => ({ '2025-06-02': { gold: 3400, silver: 36, platinum: 0, palladium: 0 } }) });
  assert.equal(asked.length, 4);
  assert.ok(asked.every((q) => q.table === 'price_log' && q.order[1] === false && q.limit === 50));
  assert.deepEqual(data.highs.silver, { price: 121.4, date: '2026-01-29' });
  assert.equal(data.highs.gold, null);
  assert.deepEqual(data.since, { gold: '2025-06-02', silver: '2025-06-02', platinum: null, palladium: null });
  assert.ok(Object.keys(data.monthly).length > 1000, 'the monthly file is read');
});

test('the market block carries the history and sets only live spot against the record', () => {
  const history = { highs: { silver: { price: 121.4, date: '2026-01-29' } }, monthly: MONTHLY, daily: dailySeries(), since: SINCE };
  const now = Date.parse('2026-10-28T20:00:00Z');
  const live = buildMarketBlock({ spot: { prices: { silver: 60.2 }, change: {}, source: 'yahoo_finance' }, history, now });
  assert.match(live, /PRICE HISTORY AND RECORDS/);
  assert.match(live, /Spot is 50\.4% below it/);
  const stale = buildMarketBlock({ spot: { prices: { silver: 200 }, change: {}, source: 'cached-fallback' }, history, now });
  assert.match(stale, /Silver all-time high: \$121\.40 on Jan 29, 2026\.\n/);
  assert.doesNotMatch(stale, /set today/);
});

test('the shared context reads history once and keeps it', async () => {
  let reads = 0;
  const db = { from: () => ({ select: () => ({ eq: () => ({ order: () => ({ limit: async () => ({ data: [] }) }) }), or: () => ({ order: () => ({ limit: async () => ({ data: [] }) }) }) }) }) };
  const ctx = createMarketContext({
    fetchSpot: async () => ({ prices: { silver: 60.2 }, change: {}, source: 'yahoo_finance' }),
    db,
    readHistory: async () => { reads++; return { highs: { silver: { price: 121.4, date: '2026-01-29' } }, monthly: MONTHLY, daily: dailySeries(), since: SINCE }; },
    now: () => Date.parse('2026-10-28T20:00:00Z'),
  });
  const first = await ctx();
  await ctx();
  assert.equal(reads, 1);
  assert.match(first, /Silver all-time high: \$121\.40/);
});
