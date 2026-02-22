const express = require('express');
const router = express.Router();
const supabase = require('../lib/supabase');

// ============================================
// Shared: filter out market-closed rows
// Markets closed: Friday 5PM ET → Sunday 6PM ET
// ============================================
function isDuringMarketClose(isoTimestamp) {
  const date = new Date(isoTimestamp);
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour12: false,
    weekday: 'short',
    hour: 'numeric',
    minute: 'numeric',
  });
  const parts = {};
  for (const p of fmt.formatToParts(date)) parts[p.type] = p.value;

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
 * Fetch trading-hours-only price_log rows.
 * Looks back 72 hours, filters out market-closed rows,
 * then takes the most recent `limit` rows.
 */
async function getTradingRows(limit = 96) {
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
  return trading.slice(-limit);
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
