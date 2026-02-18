const express = require('express');
const router = express.Router();
const supabase = require('../lib/supabase');

// GET /v1/speculation?silver=1000&gold=25000
// Public endpoint - uses provided holdings or sample data
router.get('/', async (req, res) => {
  try {
    const { silver, gold, platinum, palladium } = req.query;

    if (!silver && !gold && !platinum && !palladium) {
      return res.status(400).json({
        error: 'Provide at least one target price',
        example: '/v1/speculation?silver=1000&gold=25000',
        presets: {
          bull: { gold: 7500, silver: 100, platinum: 3000, palladium: 3000 },
          moon: { gold: 15000, silver: 350, platinum: 5000, palladium: 5000 },
          hyper: { gold: 50000, silver: 1000, platinum: 10000, palladium: 10000 },
        }
      });
    }

    // Fetch current prices
    const { data: current, error } = await supabase
      .from('price_log')
      .select('gold_price, silver_price, platinum_price, palladium_price')
      .order('timestamp', { ascending: false })
      .limit(1)
      .single();

    if (error) throw error;

    const targets = {
      gold: gold ? parseFloat(gold) : current.gold_price,
      silver: silver ? parseFloat(silver) : current.silver_price,
      platinum: platinum ? parseFloat(platinum) : current.platinum_price,
      palladium: palladium ? parseFloat(palladium) : current.palladium_price,
    };

    const multipliers = {
      gold: targets.gold / current.gold_price,
      silver: targets.silver / current.silver_price,
      platinum: targets.platinum / current.platinum_price,
      palladium: targets.palladium / current.palladium_price,
    };

    res.json({
      current_prices: {
        gold: current.gold_price,
        silver: current.silver_price,
        platinum: current.platinum_price,
        palladium: current.palladium_price,
      },
      target_prices: targets,
      multipliers,
      note: 'Authenticate with an API key to see projections for your actual portfolio',
    });
  } catch (err) {
    console.error('Speculation error:', err);
    res.status(500).json({ error: 'Failed to calculate speculation' });
  }
});

module.exports = router;
