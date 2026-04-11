/**
 * Permissive API key middleware.
 *
 * Unlike middleware/auth.js (strict — 401 if no key), this middleware is
 * additive and designed to run globally. It:
 *   - Passes through silently when no key is present (public endpoints still work)
 *   - Validates `x-api-key` header (preferred) or `Authorization: Bearer ts_live_...`
 *   - Ignores non-`ts_live_` Bearer tokens so Supabase JWTs can pass to other routes
 *   - Enforces hourly rate limits via app_state bucket keys
 *   - Attaches { id, user_id, tier, rate_limit } to req.apiKey on success
 *
 * Does NOT replace authenticateApiKey in middleware/auth.js — that one stays
 * in place for strict-auth routes like /v1/portfolio, /v1/analytics, /v1/holdings.
 */

const crypto = require('crypto');
const supabase = require('../lib/supabase');

function hashKey(key) {
  return crypto.createHash('sha256').update(key).digest('hex');
}

function extractKey(req) {
  // Prefer x-api-key header
  const headerKey = req.headers['x-api-key'];
  if (headerKey && typeof headerKey === 'string' && headerKey.trim().length > 0) {
    return headerKey.trim();
  }
  // Fallback to Authorization: Bearer ts_live_...
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7).trim();
    // Only treat as API key if it has our prefix — lets Supabase JWTs through
    if (token.startsWith('ts_live_')) {
      return token;
    }
  }
  return null;
}

async function apiKeyAuth(req, res, next) {
  const key = extractKey(req);

  // No key → pass through (public endpoints still work unauthenticated)
  if (!key) return next();

  try {
    const keyHashed = hashKey(key);
    const { data: keyRow, error } = await supabase
      .from('api_keys')
      .select('id, user_id, tier, rate_limit, request_count')
      .eq('key_hash', keyHashed)
      .single();

    if (error || !keyRow) {
      return res.status(401).json({ error: 'Invalid API key' });
    }

    // Hourly rate limit — bucketed via app_state key with YYYY-MM-DDTHH suffix
    const now = new Date();
    const hourBucket = now.toISOString().slice(0, 13); // e.g. "2026-04-11T18"
    const hourKey = `api_key_hourly_${keyRow.id}_${hourBucket}`;

    const { data: hourlyRow } = await supabase
      .from('app_state')
      .select('value')
      .eq('key', hourKey)
      .single();

    const hourlyCount = hourlyRow ? parseInt(hourlyRow.value, 10) || 0 : 0;
    const limit = keyRow.rate_limit || 100;

    if (hourlyCount >= limit) {
      const nextHour = new Date(now);
      nextHour.setUTCHours(nextHour.getUTCHours() + 1, 0, 0, 0);
      return res.status(429).json({
        error: 'Rate limit exceeded',
        limit,
        reset: nextHour.toISOString(),
      });
    }

    // Increment hourly counter + update lifetime counter (fire-and-forget)
    Promise.all([
      supabase
        .from('app_state')
        .upsert({ key: hourKey, value: String(hourlyCount + 1) }, { onConflict: 'key' }),
      supabase
        .from('api_keys')
        .update({
          last_used_at: now.toISOString(),
          request_count: (keyRow.request_count || 0) + 1,
        })
        .eq('id', keyRow.id),
    ]).catch(err => console.error('[apiKeyAuth] Counter update error:', err.message));

    req.apiKey = {
      id: keyRow.id,
      user_id: keyRow.user_id,
      tier: keyRow.tier,
      rate_limit: keyRow.rate_limit,
    };

    next();
  } catch (err) {
    console.error('[apiKeyAuth] Error:', err.message);
    return res.status(500).json({ error: 'API key validation failed' });
  }
}

module.exports = { apiKeyAuth, hashKey };
