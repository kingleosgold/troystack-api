const express = require('express');
const router = express.Router();
const supabase = require('../lib/supabase');

// GET /v1/analytics - Portfolio analytics
router.get('/', async (req, res) => {
  try {
    const { data: holdings, error: hError } = await supabase
      .from('holdings')
      .select('*')
      .eq('user_id', req.userId)
      .is('deleted_at', null);

    if (hError) throw hError;

    const { data: prices, error: pError } = await supabase
      .from('price_log')
      .select('gold_price, silver_price, platinum_price, palladium_price')
      .order('timestamp', { ascending: false })
      .limit(1)
      .single();

    if (pError) throw pError;

    const priceMap = { gold: prices.gold_price, silver: prices.silver_price, platinum: prices.platinum_price, palladium: prices.palladium_price };
    const analytics = {};
    const metals = ['gold', 'silver', 'platinum', 'palladium'];

    metals.forEach(metal => {
      const metalHoldings = holdings.filter(h => h.metal.toLowerCase() === metal);
      const totalOz = metalHoldings.reduce((sum, h) => sum + (h.weight * h.quantity), 0);
      const totalCost = metalHoldings.reduce((sum, h) => sum + (h.purchase_price * h.quantity), 0);
      const spotPrice = priceMap[metal] || 0;
      const marketValue = totalOz * spotPrice;

      if (totalOz > 0) {
        analytics[metal] = {
          total_oz: totalOz,
          avg_cost_per_oz: Math.round((totalCost / totalOz) * 100) / 100,
          break_even_price: Math.round((totalCost / totalOz) * 100) / 100,
          current_spot: spotPrice,
          market_value: Math.round(marketValue * 100) / 100,
          total_cost: Math.round(totalCost * 100) / 100,
          unrealized_pl: Math.round((marketValue - totalCost) * 100) / 100,
          unrealized_pl_pct: totalCost > 0 ? Math.round(((marketValue - totalCost) / totalCost) * 10000) / 100 : 0,
          is_profitable: marketValue >= totalCost,
          purchase_count: metalHoldings.length,
          first_purchase: metalHoldings.length > 0 ? metalHoldings.reduce((min, h) => h.purchase_date < min ? h.purchase_date : min, metalHoldings[0].purchase_date) : null,
          latest_purchase: metalHoldings.length > 0 ? metalHoldings.reduce((max, h) => h.purchase_date > max ? h.purchase_date : max, metalHoldings[0].purchase_date) : null,
        };
      }
    });

    res.json({ analytics });
  } catch (err) {
    console.error('Analytics error:', err);
    res.status(500).json({ error: 'Failed to fetch analytics' });
  }
});

module.exports = router;
