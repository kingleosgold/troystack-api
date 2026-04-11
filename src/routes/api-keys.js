/**
 * API Key management — users generate/list/delete their own keys.
 *
 * These endpoints authenticate via Supabase session JWT (Authorization: Bearer <jwt>),
 * NOT via the API keys they manage (chicken-and-egg for first-key generation).
 * The mobile app passes the signed-in user's Supabase session token.
 *
 * Service-role supabase client verifies JWT via supabase.auth.getUser(jwt).
 */

const express = require('express');
const crypto = require('crypto');
const supabase = require('../lib/supabase');
const { hashKey } = require('../middleware/api-key-auth');

const router = express.Router();

const MAX_KEYS_PER_USER = 3;
const DEFAULT_TIER = 'free';
const DEFAULT_RATE_LIMIT = 100;

/**
 * Validates Authorization: Bearer <jwt> as a Supabase session token.
 * On failure: writes a 401 response and returns null.
 * On success: returns the Supabase user object.
 */
async function authenticateUser(req, res) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Authentication required' });
    return null;
  }
  const token = authHeader.slice(7).trim();
  if (!token) {
    res.status(401).json({ error: 'Authentication required' });
    return null;
  }
  try {
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data?.user) {
      res.status(401).json({ error: 'Invalid or expired session' });
      return null;
    }
    return data.user;
  } catch (err) {
    console.error('[api-keys] Auth error:', err.message);
    res.status(401).json({ error: 'Authentication failed' });
    return null;
  }
}

// ============================================
// POST /v1/api-keys/generate — create a new key
// ============================================
router.post('/generate', async (req, res) => {
  try {
    const user = await authenticateUser(req, res);
    if (!user) return;

    // Cap at 3 keys per user
    const { count, error: countErr } = await supabase
      .from('api_keys')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', user.id);

    if (countErr) {
      console.error('[API Keys] Count error:', countErr);
      return res.status(500).json({ error: 'Internal server error', detail: countErr.message });
    }

    if ((count || 0) >= MAX_KEYS_PER_USER) {
      return res.status(400).json({ error: `Maximum ${MAX_KEYS_PER_USER} API keys per account` });
    }

    // Generate the key (48-char random portion)
    const rawKey = `ts_live_${crypto.randomBytes(24).toString('hex')}`;
    const keyHash = hashKey(rawKey);

    const { data: inserted, error: insertErr } = await supabase
      .from('api_keys')
      .insert({
        user_id: user.id,
        key_hash: keyHash,
        key_prefix: rawKey.substring(0, 12),
        tier: DEFAULT_TIER,
        rate_limit: DEFAULT_RATE_LIMIT,
        request_count: 0,
      })
      .select('id, tier, rate_limit')
      .single();

    if (insertErr) {
      console.error('[API Keys] Insert error:', insertErr);
      return res.status(500).json({ error: 'Internal server error', detail: insertErr.message });
    }

    // Return raw key ONCE — never retrievable again
    res.status(201).json({
      id: inserted.id,
      api_key: rawKey,
      key: rawKey,
      tier: inserted.tier,
      rate_limit: inserted.rate_limit,
    });
  } catch (err) {
    console.error('[API Keys] Generate error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal server error', detail: err.message });
    }
  }
});

// ============================================
// GET /v1/api-keys — list the user's keys
// ============================================
router.get('/', async (req, res) => {
  try {
    const user = await authenticateUser(req, res);
    if (!user) return;

    const { data, error } = await supabase
      .from('api_keys')
      .select('id, tier, rate_limit, last_used_at, request_count, created_at, key_hash')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('[API Keys] List error:', error);
      return res.status(500).json({ error: 'Internal server error', detail: error.message });
    }

    // key_preview = last 8 chars of the hash (stable identifier, never the raw key)
    const keys = (data || []).map(k => ({
      id: k.id,
      tier: k.tier,
      rate_limit: k.rate_limit,
      last_used_at: k.last_used_at,
      request_count: k.request_count || 0,
      created_at: k.created_at,
      key_preview: `...${(k.key_hash || '').slice(-8)}`,
    }));

    res.json({ keys });
  } catch (err) {
    console.error('[API Keys] List error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal server error', detail: err.message });
    }
  }
});

// ============================================
// DELETE /v1/api-keys/:id — revoke a key
// ============================================
router.delete('/:id', async (req, res) => {
  try {
    const user = await authenticateUser(req, res);
    if (!user) return;

    const { id } = req.params;

    // Verify ownership before delete — 404 if not found or not owned
    const { data: existing, error: fetchErr } = await supabase
      .from('api_keys')
      .select('id')
      .eq('id', id)
      .eq('user_id', user.id)
      .single();

    if (fetchErr || !existing) {
      return res.status(404).json({ error: 'API key not found' });
    }

    const { error: deleteErr } = await supabase
      .from('api_keys')
      .delete()
      .eq('id', id)
      .eq('user_id', user.id);

    if (deleteErr) {
      console.error('[API Keys] Delete error:', deleteErr);
      return res.status(500).json({ error: 'Internal server error', detail: deleteErr.message });
    }

    res.json({ success: true, deleted: id });
  } catch (err) {
    console.error('[API Keys] Delete error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal server error', detail: err.message });
    }
  }
});

module.exports = router;
