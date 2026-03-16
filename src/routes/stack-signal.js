const express = require('express');
const supabase = require('../lib/supabase');

const router = express.Router();

// GET /v1/stack-signal — List articles
router.get('/', async (req, res) => {
  try {
    let limit = parseInt(req.query.limit) || 20;
    let offset = parseInt(req.query.offset) || 0;
    const category = req.query.category;

    limit = Math.min(Math.max(limit, 1), 50);
    offset = Math.max(offset, 0);

    let query = supabase
      .from('stack_signal_articles')
      .select('id, slug, title, troy_one_liner, troy_commentary, sources, category, image_url, relevance_score, is_stack_signal, published_at, gold_price_at_publish, silver_price_at_publish, view_count, like_count, comment_count')
      .order('published_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (category) {
      query = query.eq('category', category);
    }

    const { data, error } = await query;

    if (error) {
      console.error('[Stack Signal] List error:', error.message);
      return res.status(500).json({ error: 'Failed to fetch articles' });
    }

    return res.json({ success: true, articles: data || [], limit, offset });
  } catch (err) {
    console.error('[Stack Signal] List error:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /v1/stack-signal/latest — Most recent Stack Signal daily synthesis
router.get('/latest', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('stack_signal_articles')
      .select('*')
      .eq('is_stack_signal', true)
      .order('published_at', { ascending: false })
      .limit(1)
      .single();

    if (error || !data) {
      return res.json({ success: true, signal: null });
    }

    return res.json({ success: true, signal: data });
  } catch (err) {
    console.error('[Stack Signal] Latest error:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /v1/stack-signal/:slug — Single article by slug
router.get('/:slug', async (req, res) => {
  try {
    const { slug } = req.params;

    if (!slug || slug.length > 200) {
      return res.status(400).json({ error: 'Invalid slug' });
    }

    const { data, error } = await supabase
      .from('stack_signal_articles')
      .select('*')
      .eq('slug', slug)
      .single();

    if (error || !data) {
      return res.status(404).json({ error: 'Article not found' });
    }

    return res.json({ success: true, article: data });
  } catch (err) {
    console.error('[Stack Signal] Slug error:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
