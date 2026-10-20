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

    // Each news item carries home_slug like the single article does, so a
    // card can link straight to its anchor on the recap. If that lookup fails
    // the list still answers, with no home on any item.
    const rows = data || [];
    let homes = new Set();
    try {
      homes = await recapsFor(rows);
    } catch (err) {
      console.error('[Stack Signal] Fold error:', err.message);
    }
    const articles = rows.map((r) => {
      if (!isNews(r)) return r;
      const home = recapSlugFor(r);
      return { ...r, home_slug: home && homes.has(home) ? home : null };
    });

    return res.json({ success: true, articles, limit, offset });
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
// Every news item on the day is listed, since troystack.com sends its old URL
// to an anchor on the recap. The busiest ET day so far had 140, so this
// limit is only a guard and a day that reaches it is logged.
const FOLD_LIMIT = 1000;

const etDayFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
});

// YYYY-MM-DD of an instant in New York, or null for a bad date.
function etDay(iso) {
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return null;
  const parts = Object.fromEntries(etDayFormat.formatToParts(t).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

// The UTC instant an ET day starts, midnight in New York under either offset.
function etDayStart(day) {
  const base = Date.parse(`${day}T00:00:00Z`);
  if (Number.isNaN(base)) return null;
  for (const hours of [4, 5]) {
    const t = base + hours * 3600000;
    if (etDay(t) === day && etDay(t - 1) !== day) return new Date(t).toISOString();
  }
  return null;
}

function nextDay(day) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

function isNews(row) {
  return row.is_stack_signal !== true;
}

// The news items of one ET day, oldest first, or null for a date that isn't one.
async function newsOfDay(day) {
  const from = etDayStart(day);
  const to = from && etDayStart(nextDay(day));
  if (!from || !to) return null;
  const { data, error } = await supabase
    .from('stack_signal_articles')
    .select('id, slug, title, troy_one_liner, sources, published_at, is_stack_signal')
    .or('is_stack_signal.is.null,is_stack_signal.eq.false')
    .gte('published_at', from)
    .lt('published_at', to)
    .order('published_at', { ascending: true })
    .order('id', { ascending: true })
    .limit(FOLD_LIMIT);
  if (error) throw new Error(error.message);
  if ((data || []).length >= FOLD_LIMIT) {
    console.error(`[Stack Signal] ${day} has ${FOLD_LIMIT} or more news items, some are left off its recap`);
  }
  return (data || []).filter(isNews).map((r) => {
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

// The slug of the morning recap a news item would fold into, whether or not
// that recap exists yet. The item's own published_at day decides, never
// today's, so a late reader is never sent to a different day.
function recapSlugFor(article) {
  const day = article.published_at ? etDay(article.published_at) : null;
  return day ? `the-stack-signal-${day}` : null;
}

// The morning recaps that exist for a page of list rows, in one query.
async function recapsFor(rows) {
  const wanted = [...new Set(rows.filter(isNews).map(recapSlugFor).filter(Boolean))];
  if (wanted.length === 0) return new Set();
  const { data, error } = await supabase
    .from('stack_signal_articles')
    .select('slug')
    .in('slug', wanted)
    .eq('is_stack_signal', true);
  if (error) throw new Error(error.message);
  return new Set((data || []).map((r) => r.slug));
}

// The morning recap a news item folds into, or null until that recap exists.
async function homeSlug(article) {
  const slug = recapSlugFor(article);
  if (!slug) return null;
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

    // The fold is extra. If its query fails the article still answers, a
    // news item with no home (so troystack.com doesn't redirect) and a recap
    // with no news list.
    const article = { ...data };
    try {
      if (isNews(data)) {
        article.home_slug = await homeSlug(data);
      } else {
        const morning = MORNING_RECAP.exec(data.slug);
        if (morning) {
          const news = await newsOfDay(morning[1]);
          if (news) article.news = news;
        }
      }
    } catch (err) {
      console.error('[Stack Signal] Fold error:', err.message);
      if (isNews(data)) article.home_slug = null;
    }

    return res.json({ success: true, article });
  } catch (err) {
    console.error('[Stack Signal] Slug error:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
module.exports.etDay = etDay;
