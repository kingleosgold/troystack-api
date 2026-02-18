const express = require('express');
const router = express.Router();
const supabase = require('../lib/supabase');

// GET /v1/prices - Live spot prices for all metals
router.get('/', async (req, res) => {
  try {
    // Get latest price entry
    const { data: latest, error: latestErr } = await supabase
      .from('price_log')
      .select('id, timestamp, gold_price, silver_price, platinum_price, palladium_price, source, created_at')
      .order('timestamp', { ascending: false })
      .limit(1)
      .single();

    if (latestErr) throw latestErr;

    // Get price from ~24h ago for daily change
    const yesterday = new Date(latest.timestamp);
    yesterday.setDate(yesterday.getDate() - 1);

    const { data: prev } = await supabase
      .from('price_log')
      .select('gold_price, silver_price, platinum_price, palladium_price')
      .lte('timestamp', yesterday.toISOString())
      .order('timestamp', { ascending: false })
      .limit(1)
      .single();

    const calcChange = (current, previous) => previous ? Math.round(((current - previous) / previous) * 10000) / 100 : 0;

    res.json({
      timestamp: latest.timestamp,
      prices: {
        gold: { symbol: 'Au', price: latest.gold_price, change_pct: calcChange(latest.gold_price, prev?.gold_price), unit: 'USD/oz' },
        silver: { symbol: 'Ag', price: latest.silver_price, change_pct: calcChange(latest.silver_price, prev?.silver_price), unit: 'USD/oz' },
        platinum: { symbol: 'Pt', price: latest.platinum_price, change_pct: calcChange(latest.platinum_price, prev?.platinum_price), unit: 'USD/oz' },
        palladium: { symbol: 'Pd', price: latest.palladium_price, change_pct: calcChange(latest.palladium_price, prev?.palladium_price), unit: 'USD/oz' },
      },
      source: latest.source,
    });
  } catch (err) {
    console.error('Prices error:', err);
    res.status(500).json({ error: 'Failed to fetch prices' });
  }
});

// GET /v1/prices/history?metal=silver&range=1M
router.get('/history', async (req, res) => {
  try {
    const { metal = 'gold', range = '1M' } = req.query;
    const validMetals = ['gold', 'silver', 'platinum', 'palladium'];
    const validRanges = { '1M': 30, '3M': 90, '6M': 180, '1Y': 365, '5Y': 1825, 'ALL': 3650 };
    const metalCol = { gold: 'gold_price', silver: 'silver_price', platinum: 'platinum_price', palladium: 'palladium_price' };

    if (!validMetals.includes(metal)) {
      return res.status(400).json({ error: `Invalid metal. Use: ${validMetals.join(', ')}` });
    }
    if (!validRanges[range]) {
      return res.status(400).json({ error: `Invalid range. Use: ${Object.keys(validRanges).join(', ')}` });
    }

    const days = validRanges[range];
    const since = new Date();
    since.setDate(since.getDate() - days);

    const col = metalCol[metal];
    const { data, error } = await supabase
      .from('price_log')
      .select(`timestamp, ${col}`)
      .gte('timestamp', since.toISOString())
      .order('timestamp', { ascending: true });

    if (error) throw error;

    res.json({
      metal,
      range,
      unit: 'USD/oz',
      data_points: data.length,
      prices: data.map(d => ({ date: d.timestamp, price: d[col] })),
    });
  } catch (err) {
    console.error('Price history error:', err);
    res.status(500).json({ error: 'Failed to fetch price history' });
  }
});

module.exports = router;
