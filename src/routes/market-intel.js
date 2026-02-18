const express = require('express');
const router = express.Router();
const supabase = require('../lib/supabase');

// GET /v1/market-intel - Latest news headlines
router.get('/', async (req, res) => {
  try {
    const { limit = 20, category } = req.query;

    let query = supabase
      .from('market_intelligence')
      .select('id, headline, summary, category, sources, published_at, created_at')
      .order('created_at', { ascending: false })
      .limit(Math.min(parseInt(limit), 50));

    if (category) {
      query = query.eq('category', category);
    }

    const { data, error } = await query;
    if (error) throw error;

    res.json({
      count: data.length,
      articles: data.map(a => ({
        id: a.id,
        headline: a.headline,
        summary: a.summary,
        category: a.category,
        sources: a.sources,
        published_at: a.published_at || a.created_at,
      })),
    });
  } catch (err) {
    console.error('Market intel error:', err);
    res.status(500).json({ error: 'Failed to fetch market intelligence' });
  }
});

// GET /v1/market-intel/categories
router.get('/categories', async (req, res) => {
  res.json({
    categories: [
      'BREAKING', 'SUPPLY_DEMAND', 'CENTRAL_BANK', 'POLICY',
      'MINING', 'INVESTMENT', 'GEOPOLITICAL', 'ANALYSIS'
    ]
  });
});

module.exports = router;
