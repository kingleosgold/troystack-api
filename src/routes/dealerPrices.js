const express = require('express');
const router = express.Router();
const supabase = require('../lib/supabase');

// GET /v1/dealer-prices?metal=silver&weight=1
// Returns best current prices per dealer for a product, sorted cheapest first
// Also returns data age so client can show "Prices updated X min ago"
router.get('/', async (req, res) => {
  try {
    const { metal, weight } = req.query;

    if (!metal || !weight) {
      return res.status(400).json({ error: 'metal and weight query params required' });
    }

    const weightOz = parseFloat(weight);
    if (isNaN(weightOz)) {
      return res.status(400).json({ error: 'weight must be a number' });
    }

    // Get latest price per dealer for this metal+weight
    // Get all rows from last 2 hours, dedupe by dealer+product keeping newest
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

    const { data, error } = await supabase
      .from('dealer_prices')
      .select('*')
      .eq('metal', metal.toLowerCase())
      .eq('weight_oz', weightOz)
      .gte('scraped_at', twoHoursAgo)
      .order('scraped_at', { ascending: false });

    if (error) throw error;

    // Dedupe: keep only the most recent row per dealer+product_name combo
    const seen = new Set();
    const deduped = [];
    for (const row of data) {
      const key = `${row.dealer}|${row.product_name}`;
      if (!seen.has(key)) {
        seen.add(key);
        deduped.push(row);
      }
    }

    // Sort by price ascending (cheapest first)
    deduped.sort((a, b) => a.price - b.price);

    // Find oldest scraped_at to show data freshness
    const oldestScrape = deduped.length > 0
      ? deduped.reduce((oldest, row) =>
          row.scraped_at < oldest ? row.scraped_at : oldest,
          deduped[0].scraped_at
        )
      : null;

    res.json({
      metal: metal.toLowerCase(),
      weight_oz: weightOz,
      prices: deduped,
      scraped_at: oldestScrape,
      count: deduped.length,
    });

  } catch (err) {
    console.error('[DealerPrices] Error:', err.message);
    res.status(500).json({ error: 'Failed to fetch dealer prices' });
  }
});

// GET /v1/dealer-prices/products
// Returns the list of tracked products (metal, weight combos available)
router.get('/products', async (req, res) => {
  const { PRODUCTS } = require('../services/dealerScraper');
  res.json({ products: PRODUCTS.map(p => ({
    id: p.id,
    name: p.name,
    metal: p.metal,
    weight_oz: p.weight_oz,
  }))});
});

// POST /v1/dealer-prices/click
// Log an affiliate click
// Body: { dealer, product_name, metal, weight_oz }
// Auth: optional (guest clicks still logged, user_id null)
router.post('/click', async (req, res) => {
  try {
    const { dealer, product_name, metal, weight_oz, user_id } = req.body;

    if (!dealer || !product_name || !metal || !weight_oz) {
      return res.status(400).json({ error: 'dealer, product_name, metal, weight_oz required' });
    }

    const { error } = await supabase
      .from('affiliate_clicks')
      .insert({
        user_id: user_id || null,
        dealer,
        product_name,
        metal,
        weight_oz: parseFloat(weight_oz),
        clicked_at: new Date().toISOString(),
      });

    if (error) throw error;

    res.json({ logged: true });
  } catch (err) {
    console.error('[AffiliateClick] Error:', err.message);
    res.status(500).json({ error: 'Failed to log click' });
  }
});

module.exports = router;
