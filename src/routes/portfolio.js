const express = require('express');
const router = express.Router();
const supabase = require('../lib/supabase');

// GET /v1/portfolio - Full portfolio summary
router.get('/', async (req, res) => {
  try {
    // Fetch user's holdings
    const { data: holdings, error: hError } = await supabase
      .from('holdings')
      .select('*')
      .eq('user_id', req.userId);

    if (hError) throw hError;

    // Fetch current prices
    const { data: prices, error: pError } = await supabase
      .from('spot_prices')
      .select('gold, silver, platinum, palladium, updated_at')
      .order('updated_at', { ascending: false })
      .limit(1)
      .single();

    if (pError) throw pError;

    const metalMap = { gold: 'gold', silver: 'silver', platinum: 'platinum', palladium: 'palladium' };
    let totalValue = 0;
    let totalCost = 0;

    const breakdown = { gold: { oz: 0, value: 0, cost: 0 }, silver: { oz: 0, value: 0, cost: 0 },
                        platinum: { oz: 0, value: 0, cost: 0 }, palladium: { oz: 0, value: 0, cost: 0 } };

    holdings.forEach(h => {
      const metal = h.metal.toLowerCase();
      const spotPrice = prices[metal] || 0;
      const value = h.total_oz * spotPrice;
      const cost = h.total_cost || 0;

      breakdown[metal].oz += h.total_oz;
      breakdown[metal].value += value;
      breakdown[metal].cost += cost;
      totalValue += value;
      totalCost += cost;
    });

    const unrealizedPL = totalValue - totalCost;

    res.json({
      total_value: Math.round(totalValue * 100) / 100,
      total_cost: Math.round(totalCost * 100) / 100,
      unrealized_pl: Math.round(unrealizedPL * 100) / 100,
      unrealized_pl_pct: totalCost > 0 ? Math.round((unrealizedPL / totalCost) * 10000) / 100 : 0,
      prices_as_of: prices.updated_at,
      breakdown: Object.entries(breakdown).reduce((acc, [metal, data]) => {
        acc[metal] = {
          total_oz: data.oz,
          spot_price: prices[metal],
          market_value: Math.round(data.value * 100) / 100,
          cost_basis: Math.round(data.cost * 100) / 100,
          unrealized_pl: Math.round((data.value - data.cost) * 100) / 100,
          allocation_pct: totalValue > 0 ? Math.round((data.value / totalValue) * 10000) / 100 : 0,
        };
        return acc;
      }, {}),
      item_count: holdings.length,
    });
  } catch (err) {
    console.error('Portfolio error:', err);
    res.status(500).json({ error: 'Failed to fetch portfolio' });
  }
});

module.exports = router;
