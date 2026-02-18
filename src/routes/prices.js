const express = require('express');
const router = express.Router();
const supabase = require('../lib/supabase');

// GET /v1/prices - Live spot prices for all metals
router.get('/', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('spot_prices')
      .select('*')
      .order('updated_at', { ascending: false })
      .limit(1)
      .single();

    if (error) throw error;

    res.json({
      timestamp: data.updated_at,
      prices: {
        gold: { symbol: 'Au', price: data.gold, change_pct: data.gold_change_pct, unit: 'USD/oz' },
        silver: { symbol: 'Ag', price: data.silver, change_pct: data.silver_change_pct, unit: 'USD/oz' },
        platinum: { symbol: 'Pt', price: data.platinum, change_pct: data.platinum_change_pct, unit: 'USD/oz' },
        palladium: { symbol: 'Pd', price: data.palladium, change_pct: data.palladium_change_pct, unit: 'USD/oz' },
      },
      source: 'Stack Tracker Gold',
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

    if (!validMetals.includes(metal)) {
      return res.status(400).json({ error: `Invalid metal. Use: ${validMetals.join(', ')}` });
    }
    if (!validRanges[range]) {
      return res.status(400).json({ error: `Invalid range. Use: ${Object.keys(validRanges).join(', ')}` });
    }

    const days = validRanges[range];
    const since = new Date();
    since.setDate(since.getDate() - days);

    const { data, error } = await supabase
      .from('price_history')
      .select(`date, ${metal}`)
      .gte('date', since.toISOString().split('T')[0])
      .order('date', { ascending: true });

    if (error) throw error;

    res.json({
      metal,
      range,
      unit: 'USD/oz',
      data_points: data.length,
      prices: data.map(d => ({ date: d.date, price: d[metal] })),
    });
  } catch (err) {
    console.error('Price history error:', err);
    res.status(500).json({ error: 'Failed to fetch price history' });
  }
});

module.exports = router;
