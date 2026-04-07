/**
 * Social Features — Views, Likes, Comments for Stack Signal articles
 *
 * Mounted at /v1/stack-signal (alongside stack-signal.js routes).
 * All endpoints use /articles/:id/... paths.
 *
 * Auth pattern: mobile app passes userId via body/query (same as push, troy-chat).
 */

const express = require('express');
const supabase = require('../lib/supabase');

const router = express.Router();

function isUUID(str) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str);
}

// ── Helper: extract userId from request (body or query), returns null for non-UUIDs ──
function getUserId(req) {
  const id = req.body?.userId || req.query?.userId || null;
  if (id && !isUUID(id)) return null;
  return id;
}

// ════════════════════════════════════════════════════════════
// VIEWS
// ════════════════════════════════════════════════════════════

// POST /v1/stack-signal/articles/:id/view
// Records a view. Deduplicates by user_id (or device_id for anonymous).
router.post('/articles/:id/view', async (req, res) => {
  const { id } = req.params;
  const userId = getUserId(req);
  const deviceId = req.body?.deviceId || null;

  try {
    // Check if already viewed by this user/device
    let existingQuery = supabase
      .from('article_views')
      .select('id')
      .eq('article_id', id);

    if (userId) {
      existingQuery = existingQuery.eq('user_id', userId);
    } else if (deviceId) {
      existingQuery = existingQuery.eq('device_id', deviceId);
    } else {
      // Anonymous with no device_id — always count (no dedup possible)
      existingQuery = null;
    }

    let alreadyViewed = false;
    if (existingQuery) {
      const { data: existing } = await existingQuery.limit(1).single();
      alreadyViewed = !!existing;
    }

    if (!alreadyViewed) {
      await supabase
        .from('article_views')
        .insert({ article_id: id, user_id: userId, device_id: deviceId });

      // Increment view_count
      const { data: article } = await supabase
        .from('stack_signal_articles')
        .select('view_count')
        .eq('id', id)
        .single();

      if (article) {
        await supabase
          .from('stack_signal_articles')
          .update({ view_count: (article.view_count || 0) + 1 })
          .eq('id', id);
      }
    }

    res.json({ success: true });
  } catch (err) {
    console.error('[Social] View error:', err.message);
    res.status(500).json({ error: 'Failed to record view' });
  }
});

// ════════════════════════════════════════════════════════════
// LIKES
// ════════════════════════════════════════════════════════════

// POST /v1/stack-signal/articles/:id/like
// Toggles a like. Requires userId. Returns new like state.
router.post('/articles/:id/like', async (req, res) => {
  const { id } = req.params;
  const userId = getUserId(req);

  if (!userId) {
    return res.status(401).json({ error: 'userId required to like articles' });
  }

  try {
    // Check if already liked
    const { data: existing } = await supabase
      .from('article_likes')
      .select('id')
      .eq('article_id', id)
      .eq('user_id', userId)
      .single();

    // Get current count
    const { data: article } = await supabase
      .from('stack_signal_articles')
      .select('like_count')
      .eq('id', id)
      .single();

    if (!article) {
      return res.status(404).json({ error: 'Article not found' });
    }

    const currentCount = article.like_count || 0;

    if (existing) {
      // Unlike
      await supabase.from('article_likes').delete().eq('id', existing.id);
      await supabase
        .from('stack_signal_articles')
        .update({ like_count: Math.max(0, currentCount - 1) })
        .eq('id', id);
      res.json({ success: true, liked: false, like_count: Math.max(0, currentCount - 1) });
    } else {
      // Like
      await supabase.from('article_likes').insert({ article_id: id, user_id: userId });
      await supabase
        .from('stack_signal_articles')
        .update({ like_count: currentCount + 1 })
        .eq('id', id);
      res.json({ success: true, liked: true, like_count: currentCount + 1 });
    }
  } catch (err) {
    console.error('[Social] Like error:', err.message);
    res.status(500).json({ error: 'Failed to toggle like' });
  }
});

// GET /v1/stack-signal/articles/:id/likes
// Returns like count and whether the requesting user liked it.
router.get('/articles/:id/likes', async (req, res) => {
  const { id } = req.params;
  const userId = getUserId(req);

  try {
    const { data: article } = await supabase
      .from('stack_signal_articles')
      .select('like_count')
      .eq('id', id)
      .single();

    let userLiked = false;
    if (userId) {
      const { data } = await supabase
        .from('article_likes')
        .select('id')
        .eq('article_id', id)
        .eq('user_id', userId)
        .single();
      userLiked = !!data;
    }

    res.json({ like_count: article?.like_count || 0, user_liked: userLiked });
  } catch (err) {
    console.error('[Social] Get likes error:', err.message);
    res.status(500).json({ error: 'Failed to fetch likes' });
  }
});

// ════════════════════════════════════════════════════════════
// COMMENTS
// ════════════════════════════════════════════════════════════

// POST /v1/stack-signal/articles/:id/comments
// Add a comment. Requires userId.
router.post('/articles/:id/comments', async (req, res) => {
  const { id } = req.params;
  const userId = getUserId(req);
  const { content } = req.body;

  if (!userId) {
    return res.status(401).json({ error: 'userId required to post comments' });
  }

  if (!content || content.trim().length === 0) {
    return res.status(400).json({ error: 'Comment cannot be empty' });
  }

  if (content.length > 1000) {
    return res.status(400).json({ error: 'Comment too long (max 1000 chars)' });
  }

  try {
    const { data, error } = await supabase
      .from('article_comments')
      .insert({ article_id: id, user_id: userId, content: content.trim() })
      .select()
      .single();

    if (error) throw error;

    // Increment comment_count
    const { data: article } = await supabase
      .from('stack_signal_articles')
      .select('comment_count')
      .eq('id', id)
      .single();

    if (article) {
      await supabase
        .from('stack_signal_articles')
        .update({ comment_count: (article.comment_count || 0) + 1 })
        .eq('id', id);
    }

    res.json({ success: true, comment: data });
  } catch (err) {
    console.error('[Social] Comment error:', err.message);
    res.status(500).json({ error: 'Failed to post comment' });
  }
});

// GET /v1/stack-signal/articles/:id/comments
// Returns comments for an article, newest first. No auth required.
router.get('/articles/:id/comments', async (req, res) => {
  const { id } = req.params;
  const limit = Math.min(Math.max(parseInt(req.query.limit) || 50, 1), 100);
  const offset = Math.max(parseInt(req.query.offset) || 0, 0);

  try {
    const { data, error } = await supabase
      .from('article_comments')
      .select('id, user_id, content, created_at')
      .eq('article_id', id)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) throw error;

    res.json({ success: true, comments: data || [] });
  } catch (err) {
    console.error('[Social] Get comments error:', err.message);
    res.status(500).json({ error: 'Failed to fetch comments' });
  }
});

// DELETE /v1/stack-signal/articles/:id/comments/:commentId
// Delete own comment. Requires userId matching the comment's user_id.
router.delete('/articles/:id/comments/:commentId', async (req, res) => {
  const { id, commentId } = req.params;
  const userId = getUserId(req);

  if (!userId) {
    return res.status(401).json({ error: 'userId required to delete comments' });
  }

  try {
    // Verify ownership
    const { data: comment } = await supabase
      .from('article_comments')
      .select('id, user_id')
      .eq('id', commentId)
      .eq('article_id', id)
      .single();

    if (!comment) {
      return res.status(404).json({ error: 'Comment not found' });
    }

    if (comment.user_id !== userId) {
      return res.status(403).json({ error: 'Cannot delete another user\'s comment' });
    }

    await supabase.from('article_comments').delete().eq('id', commentId);

    // Decrement comment_count
    const { data: article } = await supabase
      .from('stack_signal_articles')
      .select('comment_count')
      .eq('id', id)
      .single();

    if (article) {
      await supabase
        .from('stack_signal_articles')
        .update({ comment_count: Math.max(0, (article.comment_count || 0) - 1) })
        .eq('id', id);
    }

    res.json({ success: true });
  } catch (err) {
    console.error('[Social] Delete comment error:', err.message);
    res.status(500).json({ error: 'Failed to delete comment' });
  }
});

module.exports = router;
