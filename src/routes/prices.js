const express = require('express');
const router = express.Router();
const supabase = require('../lib/supabase');
const { getSpotPrices } = require('../services/price-fetcher');

// GET /v1/prices - Live spot prices for all metals
router.get('/', async (req, res) => {
  try {
    const data = await getSpotPrices();
    const { prices, change, timestamp, source, cacheAgeMinutes, marketsClosed } = data;

    res.json({
      success: true,
      timestamp,
      prices: {
        gold: { symbol: 'Au', price: prices.gold, change_pct: change.gold?.percent || 0, unit: 'USD/oz' },
        silver: { symbol: 'Ag', price: prices.silver, change_pct: change.silver?.percent || 0, unit: 'USD/oz' },
        platinum: { symbol: 'Pt', price: prices.platinum, change_pct: change.platinum?.percent || 0, unit: 'USD/oz' },
        palladium: { symbol: 'Pd', price: prices.palladium, change_pct: change.palladium?.percent || 0, unit: 'USD/oz' },
      },
      source,
      cacheAgeMinutes,
      marketsClosed,
      change,
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
