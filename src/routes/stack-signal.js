const express = require('express');
const supabase = require('../lib/supabase');
const { usableOneLiner } = require('../services/troy-context');

const router = express.Router();

// GET /v1/stack-signal — List articles
router.get('/', async (req, res) => {
  try {
    let limit = parseInt(req.query.limit) || 20;
    let offset = parseInt(req.query.offset) || 0;
    const category = req.query.category;
    // type=signal lists only Troy's recaps (daily, evening, weekly, week
    // ahead), type=news only the feed items, so troystack.com's sitemap can
    // list every recap without paging through thousands of news items.
    const type = req.query.type;
    if (type !== undefined && type !== 'signal' && type !== 'news') {
      return res.status(400).json({ error: 'type must be signal or news' });
    }

    limit = Math.min(Math.max(limit, 1), 50);
    offset = Math.max(offset, 0);

    let query = supabase
      .from('stack_signal_articles')
      .select('id, slug, title, troy_one_liner, troy_commentary, sources, category, image_url, relevance_score, is_stack_signal, published_at, gold_price_at_publish, silver_price_at_publish, view_count, like_count, comment_count')
      .order('published_at', { ascending: false })
      // Hundreds of articles share a published_at with another, so id breaks
      // the tie and a row can't skip or repeat across offset pages.
      .order('id', { ascending: false })
      .range(offset, offset + limit - 1);

    if (category) {
      query = query.eq('category', category);
    }
    // A feed row's flag can be null, and troy-context.js counts those as
    // news too, so news is anything that isn't a recap.
    if (type === 'signal') {
      query = query.eq('is_stack_signal', true);
    } else if (type === 'news') {
      query = query.or('is_stack_signal.is.null,is_stack_signal.eq.false');
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

// Each ET day's news folds into that day's morning recap on troystack.com.
const MORNING_RECAP = /^the-stack-signal-(\d{4}-\d{2}-\d{2})$/;
// The busiest ET day so far had 140 news items. Every item on the day has to
// be listed, since troystack.com sends its old URL to an anchor on the recap.
const FOLD_LIMIT = 200;

const etDayFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
});

// YYYY-MM-DD of an instant in New York.
function etDay(iso) {
  return etDayFormat.format(new Date(iso));
}

function isNews(row) {
  return row.is_stack_signal !== true;
}

// The news items of one ET day, oldest first. An ET day sits inside UTC
// 00:00 of that date to 06:00 the next, whatever the DST offset, so the query
// takes that window and etDay() trims it to the day.
async function newsOfDay(day) {
  const next = new Date(`${day}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  const { data, error } = await supabase
    .from('stack_signal_articles')
    .select('id, slug, title, troy_one_liner, sources, published_at, is_stack_signal')
    .or('is_stack_signal.is.null,is_stack_signal.eq.false')
    .gte('published_at', `${day}T00:00:00Z`)
    .lt('published_at', `${next.toISOString().slice(0, 10)}T06:00:00Z`)
    .order('published_at', { ascending: true })
    .order('id', { ascending: true })
    .limit(FOLD_LIMIT * 2);
  if (error) throw new Error(error.message);
  return (data || [])
    .filter((r) => isNews(r) && etDay(r.published_at) === day)
    .slice(0, FOLD_LIMIT)
    .map((r) => {
      const source = Array.isArray(r.sources) ? r.sources[0] : null;
      return {
        title: r.title,
        slug: r.slug,
        one_liner: usableOneLiner(r.troy_one_liner) || null,
        source: source?.name || null,
        source_url: source?.url || null,
      };
    });
}

// The morning recap a news item folds into, or null until that recap exists.
// The item's own published_at day decides, never today's, so a late reader
// is never sent to a different day.
async function homeSlug(article) {
  if (!article.published_at) return null;
  const slug = `the-stack-signal-${etDay(article.published_at)}`;
  const { data, error } = await supabase
    .from('stack_signal_articles')
    .select('slug')
    .eq('slug', slug)
    .eq('is_stack_signal', true)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data ? data.slug : null;
}

// GET /v1/stack-signal/:slug — Single article by slug. A news item carries
// home_slug, and a morning recap carries its day's news.
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

    const article = { ...data };
    if (isNews(data)) {
      article.home_slug = await homeSlug(data);
    } else {
      const morning = MORNING_RECAP.exec(data.slug);
      if (morning) article.news = await newsOfDay(morning[1]);
    }

    return res.json({ success: true, article });
  } catch (err) {
    console.error('[Stack Signal] Slug error:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
module.exports.etDay = etDay;
