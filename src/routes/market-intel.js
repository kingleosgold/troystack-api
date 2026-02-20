const express = require('express');
const router = express.Router();
const supabase = require('../lib/supabase');

// GET /v1/market-intel - Latest news headlines (from both intelligence_briefs and breaking_news)
router.get('/', async (req, res) => {
  try {
    const { limit = 20, metal, category } = req.query;
    const maxResults = Math.min(parseInt(limit) || 20, 50);

    const articles = [];

    // Fetch from intelligence_briefs (Gemini-generated news)
    try {
      let briefsQuery = supabase
        .from('intelligence_briefs')
        .select('id, date, category, title, summary, source, source_url, relevance_score, created_at')
        .order('created_at', { ascending: false })
        .limit(maxResults);

      if (category) {
        briefsQuery = briefsQuery.eq('category', category);
      }

      const { data: briefs, error: briefsErr } = await briefsQuery;

      if (!briefsErr && briefs) {
        for (const b of briefs) {
          articles.push({
            id: b.id,
            title: b.title,
            summary: b.summary,
            category: b.category,
            source: b.source || null,
            source_url: b.source_url || null,
            relevance_score: b.relevance_score || 50,
            type: 'intelligence',
            published_at: b.created_at,
          });
        }
      }
    } catch (err) {
      console.error('Intelligence briefs fetch error:', err.message);
    }

    // Fetch from breaking_news (COMEX alerts, manual alerts)
    try {
      let newsQuery = supabase
        .from('breaking_news')
        .select('id, title, body, metal, severity, created_at')
        .order('created_at', { ascending: false })
        .limit(maxResults);

      if (metal) {
        newsQuery = newsQuery.eq('metal', metal);
      }

      const { data: news, error: newsErr } = await newsQuery;

      if (!newsErr && news) {
        for (const n of news) {
          articles.push({
            id: n.id,
            title: n.title,
            summary: n.body,
            category: 'breaking_news',
            metal: n.metal || null,
            severity: n.severity || null,
            type: 'alert',
            published_at: n.created_at,
          });
        }
      }
    } catch (err) {
      console.error('Breaking news fetch error:', err.message);
    }

    // Sort combined results by date, newest first, and cap
    articles.sort((a, b) => new Date(b.published_at) - new Date(a.published_at));
    const capped = articles.slice(0, maxResults);

    res.json({
      count: capped.length,
      articles: capped,
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
      'market_brief', 'breaking_news', 'policy', 'supply_demand', 'analysis',
    ]
  });
});

module.exports = router;
