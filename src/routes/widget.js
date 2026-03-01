const express = require('express');
const router = express.Router();
const supabase = require('../lib/supabase');
const { areMarketsClosed } = require('../services/price-fetcher');

// ============================================
// Shared: filter out market-closed rows
// Markets closed: Friday 5PM ET → Sunday 6PM ET
// ============================================
const etFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  weekday: 'short',
  hour: 'numeric',
  hourCycle: 'h23',
});

function isDuringMarketClose(isoTimestamp) {
  const date = new Date(isoTimestamp);
  const parts = {};
  for (const p of etFmt.formatToParts(date)) parts[p.type] = p.value;

  const dayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const day = dayMap[parts.weekday];
  const hour = parseInt(parts.hour, 10);

  return (
    day === 6 ||                    // Saturday all day
    (day === 0 && hour < 18) ||     // Sunday before 6PM ET
    (day === 5 && hour >= 17)       // Friday at/after 5PM ET
  );
}

/**
 * Remove consecutive rows where the primary price (gold) is identical.
 * Keeps first and last occurrence to preserve time range.
 */
function dedupeConsecutive(rows) {
  if (rows.length <= 2) return rows;
  const result = [rows[0]];
  for (let i = 1; i < rows.length - 1; i++) {
    if (parseFloat(rows[i].gold_price) !== parseFloat(rows[i - 1].gold_price)) {
      result.push(rows[i]);
    }
  }
  result.push(rows[rows.length - 1]);
  return result;
}

/**
 * Remove single-point outlier spikes caused by bad bid/ask bounces.
 * If ANY metal deviates >1.5% from its neighbor average at index i,
 * that entire row is removed (keeps all arrays aligned).
 * Runs up to 3 passes since removing a point changes neighbors.
 */
const PRICE_COLS = ['gold_price', 'silver_price', 'platinum_price', 'palladium_price'];

function removeOutliers(rows) {
  if (rows.length <= 2) return rows;
  let cleaned = rows;
  for (let pass = 0; pass < 3; pass++) {
    if (cleaned.length <= 2) break;
    const keep = [true];
    let removed = 0;
    for (let i = 1; i < cleaned.length - 1; i++) {
      let isOutlier = false;
      for (const col of PRICE_COLS) {
        const prev = parseFloat(cleaned[i - 1][col]);
        const curr = parseFloat(cleaned[i][col]);
        const next = parseFloat(cleaned[i + 1][col]);
        if (!prev || !curr || !next) continue;
        const neighborAvg = (prev + next) / 2;
        if (Math.abs(curr - neighborAvg) / neighborAvg > 0.015) {
          isOutlier = true;
          break;
        }
      }
      keep.push(!isOutlier);
      if (isOutlier) removed++;
    }
    keep.push(true);
    if (removed === 0) break;
    cleaned = cleaned.filter((_, i) => keep[i]);
  }
  return cleaned;
}

/**
 * Get the last trading session's data for weekend sparklines.
 * Queries the most recent 500 price_log rows, filters to trading hours,
 * and removes consecutive duplicate prices for clean charts.
 */
async function getLastTradingSession() {
  // Fetch the most recent 500 rows (DESC), then reverse for chronological order.
  // 500 rows at 15-min intervals ≈ 5 days of data — more than enough for a full session.
  const { data, error } = await supabase
    .from('price_log')
    .select('timestamp, gold_price, silver_price, platinum_price, palladium_price')
    .order('timestamp', { ascending: false })
    .limit(500);

  if (error) throw error;
  if (!data || data.length === 0) return [];

  // Reverse to chronological order and filter to trading hours only
  const trading = data.reverse().filter(row => !isDuringMarketClose(row.timestamp));
  if (trading.length === 0) return [];

  // Find the last trading day's data
  const etDayFmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
  });

  const lastTradingDate = etDayFmt.format(new Date(trading[trading.length - 1].timestamp));

  // Collect last trading day rows + prior evening session
  const lastDayRows = trading.filter(r =>
    etDayFmt.format(new Date(r.timestamp)) === lastTradingDate
  );

  // Include prior evening session (e.g. Thursday 6PM–midnight for Friday's session)
  let sessionRows = lastDayRows;
  if (lastDayRows.length > 0) {
    const sessionStart = new Date(lastDayRows[0].timestamp);
    sessionStart.setHours(sessionStart.getHours() - 12);
    const priorRows = trading.filter(r => {
      const t = new Date(r.timestamp);
      return t >= sessionStart && t < new Date(lastDayRows[0].timestamp);
    });
    sessionRows = [...priorRows, ...lastDayRows];
  }

  // Remove consecutive duplicate prices
  sessionRows = dedupeConsecutive(sessionRows);

  // Fallback: if too few points, use all available trading data
  if (sessionRows.length < 10) {
    sessionRows = dedupeConsecutive(trading);
  }

  return sessionRows;
}

/**
 * Fetch trading-hours-only price_log rows.
 * On weekends: returns the last full trading session (Friday).
 * On weekdays: looks back 72 hours, filters out market-closed rows.
 */
async function getTradingRows(limit = 96) {
  if (areMarketsClosed()) {
    const session = await getLastTradingSession();
    return removeOutliers(session.slice(-limit));
  }

  const since = new Date();
  since.setHours(since.getHours() - 72);

  const { data, error } = await supabase
    .from('price_log')
    .select('timestamp, gold_price, silver_price, platinum_price, palladium_price')
    .gte('timestamp', since.toISOString())
    .order('timestamp', { ascending: true });

  if (error) throw error;
  if (!data || data.length === 0) return [];

  // Filter out weekend/closed-market rows
  const trading = data.filter(row => !isDuringMarketClose(row.timestamp));

  // Take the most recent `limit` rows
  return removeOutliers(trading.slice(-limit));
}

// GET /v1/widget-data — Widget display data with sparklines
router.get('/widget-data', async (req, res) => {
  try {
    // Get latest price
    const { data: latest, error: latestErr } = await supabase
      .from('price_log')
      .select('timestamp, gold_price, silver_price, platinum_price, palladium_price')
      .order('timestamp', { ascending: false })
      .limit(1)
      .single();

    if (latestErr) throw latestErr;

    // Get price from ~24h of trading ago for change calculation
    const yesterday = new Date(latest.timestamp);
    yesterday.setDate(yesterday.getDate() - 1);

    const { data: prev } = await supabase
      .from('price_log')
      .select('gold_price, silver_price, platinum_price, palladium_price')
      .lte('timestamp', yesterday.toISOString())
      .order('timestamp', { ascending: false })
      .limit(1)
      .single();

    // Get last 24h of trading data (skips weekends)
    const sparklineData = await getTradingRows(96);

    // Sample down to ~24 points
    const sample = (arr, col, targetPoints = 24) => {
      if (!arr || arr.length === 0) return [];
      if (arr.length <= targetPoints) return arr.map(d => d[col]).filter(v => v > 0);
      const step = arr.length / targetPoints;
      const result = [];
      for (let i = 0; i < targetPoints; i++) {
        const idx = Math.min(Math.floor(i * step), arr.length - 1);
        if (arr[idx][col] > 0) result.push(arr[idx][col]);
      }
      return result;
    };

    const calcChange = (current, previous) => {
      if (!previous) return { amount: 0, percent: 0, prevClose: current };
      const amount = Math.round((current - previous) * 100) / 100;
      const percent = Math.round(((current - previous) / previous) * 10000) / 100;
      return { amount, percent, prevClose: previous };
    };

    res.json({
      success: true,
      metals: [
        { symbol: 'Au', price: latest.gold_price, change_pct: calcChange(latest.gold_price, prev?.gold_price).percent, sparkline: sample(sparklineData, 'gold_price') },
        { symbol: 'Ag', price: latest.silver_price, change_pct: calcChange(latest.silver_price, prev?.silver_price).percent, sparkline: sample(sparklineData, 'silver_price') },
        { symbol: 'Pt', price: latest.platinum_price, change_pct: calcChange(latest.platinum_price, prev?.platinum_price).percent, sparkline: sample(sparklineData, 'platinum_price') },
        { symbol: 'Pd', price: latest.palladium_price, change_pct: calcChange(latest.palladium_price, prev?.palladium_price).percent, sparkline: sample(sparklineData, 'palladium_price') },
      ],
      timestamp: latest.timestamp,
      change: {
        gold: calcChange(latest.gold_price, prev?.gold_price),
        silver: calcChange(latest.silver_price, prev?.silver_price),
        platinum: calcChange(latest.platinum_price, prev?.platinum_price),
        palladium: calcChange(latest.palladium_price, prev?.palladium_price),
      },
    });
  } catch (err) {
    console.error('Widget data error:', err);
    res.status(500).json({ error: 'Failed to fetch widget data' });
  }
});

// GET /v1/sparkline-24h — 24-hour sparkline data for all metals (trading hours only)
router.get('/sparkline-24h', async (req, res) => {
  try {
    // Get last 24h of trading data (skips weekends)
    const data = await getTradingRows(96);

    // Sample to ~96 points (one per 15 min over 24h) for smooth sparklines
    const targetPoints = 96;
    const sample = (arr, col) => {
      if (!arr || arr.length === 0) return [];
      if (arr.length <= targetPoints) return arr.map(d => d[col]).filter(v => v > 0);
      const step = arr.length / targetPoints;
      const result = [];
      for (let i = 0; i < targetPoints; i++) {
        const idx = Math.min(Math.floor(i * step), arr.length - 1);
        if (arr[idx][col] > 0) result.push(arr[idx][col]);
      }
      return result;
    };

    const sampleTimestamps = (arr) => {
      if (!arr || arr.length === 0) return [];
      if (arr.length <= targetPoints) return arr.map(d => d.timestamp);
      const step = arr.length / targetPoints;
      const result = [];
      for (let i = 0; i < targetPoints; i++) {
        const idx = Math.min(Math.floor(i * step), arr.length - 1);
        result.push(arr[idx].timestamp);
      }
      return result;
    };

    res.json({
      success: true,
      sparklines: {
        gold: sample(data, 'gold_price'),
        silver: sample(data, 'silver_price'),
        platinum: sample(data, 'platinum_price'),
        palladium: sample(data, 'palladium_price'),
      },
      timestamps: sampleTimestamps(data),
    });
  } catch (err) {
    console.error('Sparkline error:', err);
    res.status(500).json({ error: 'Failed to fetch sparkline data' });
  }
});

module.exports = router;
