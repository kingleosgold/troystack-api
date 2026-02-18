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
      .from('spot_prices')
      .select('gold, silver, platinum, palladium')
      .order('updated_at', { ascending: false })
      .limit(1)
      .single();

    if (error) throw error;

    const targets = {
      gold: gold ? parseFloat(gold) : current.gold,
      silver: silver ? parseFloat(silver) : current.silver,
      platinum: platinum ? parseFloat(platinum) : current.platinum,
      palladium: palladium ? parseFloat(palladium) : current.palladium,
    };

    const multipliers = {
      gold: targets.gold / current.gold,
      silver: targets.silver / current.silver,
      platinum: targets.platinum / current.platinum,
      palladium: targets.palladium / current.palladium,
    };

    res.json({
      current_prices: current,
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
