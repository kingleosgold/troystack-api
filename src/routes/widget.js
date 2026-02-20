const express = require('express');
const router = express.Router();
const supabase = require('../lib/supabase');

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

    // Get price from ~24h ago for change calculation
    const yesterday = new Date(latest.timestamp);
    yesterday.setDate(yesterday.getDate() - 1);

    const { data: prev } = await supabase
      .from('price_log')
      .select('gold_price, silver_price, platinum_price, palladium_price')
      .lte('timestamp', yesterday.toISOString())
      .order('timestamp', { ascending: false })
      .limit(1)
      .single();

    // Get last 24 hours of prices for sparklines (~96 entries at 15-min intervals)
    const sparklineSince = new Date(latest.timestamp);
    sparklineSince.setHours(sparklineSince.getHours() - 24);

    const { data: sparklineData } = await supabase
      .from('price_log')
      .select('gold_price, silver_price, platinum_price, palladium_price')
      .gte('timestamp', sparklineSince.toISOString())
      .order('timestamp', { ascending: true });

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

// GET /v1/sparkline-24h — 24-hour sparkline data for all metals
router.get('/sparkline-24h', async (req, res) => {
  try {
    const since = new Date();
    since.setHours(since.getHours() - 24);

    const { data, error } = await supabase
      .from('price_log')
      .select('timestamp, gold_price, silver_price, platinum_price, palladium_price')
      .gte('timestamp', since.toISOString())
      .order('timestamp', { ascending: true });

    if (error) throw error;

    // Sample to ~24 points
    const targetPoints = 24;
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
