// TTS audio cache (Phase A) — content-addressed MP3 cache in Supabase Storage.
//
// Bucket: troy-voice-cache (private, 10MB/file, audio/mpeg only — created by
// scripts/create-voice-cache-bucket.js; service-role access only, no RLS
// grants to clients). Serving stays inside the authed /v1/troy/speak endpoint;
// nothing here mints URLs.
//
// Key path shape:
//   {SANITIZER_VERSION}/{provider}/{voice}/{model}-{format}/{sha256(sanitizedText)}.mp3
// Identical sanitized text + voice config always maps to the same object, so a
// replay of the same Troy reply serves stored bytes instead of re-billing the
// provider (~36s generation on Grok). Bumping SANITIZER_VERSION in
// troy-chat.js, or changing a provider's cacheKeyParts(), moves the path
// prefix and naturally strands old entries for the TTL cron to evict.
//
// Failure policy: the cache must NEVER break speech. get() resolves null and
// put() resolves false on ANY storage failure — errors are logged and
// swallowed, and the route falls through to live synthesis.

const crypto = require('node:crypto');
const supabase = require('../lib/supabase');

const BUCKET = 'troy-voice-cache';
const TTL_DAYS = 30;

function buildCacheKey({ sanitizedText, version, provider, voice, model, format }) {
  const hash = crypto.createHash('sha256').update(sanitizedText, 'utf8').digest('hex');
  return `${version}/${provider}/${voice}/${model}-${format}/${hash}.mp3`;
}

async function get(key) {
  try {
    const { data, error } = await supabase.storage.from(BUCKET).download(key);
    if (error || !data) return null; // not-found lands here — a miss, not an error
    return Buffer.from(await data.arrayBuffer());
  } catch (err) {
    console.log('🔊 [TTS] cache get error:', err.message);
    return null;
  }
}

async function put(key, buffer) {
  try {
    // upsert: concurrent identical misses double-store the same bytes;
    // last write wins, no locking needed.
    const { error } = await supabase.storage.from(BUCKET).upload(key, buffer, {
      contentType: 'audio/mpeg',
      upsert: true,
    });
    if (error) {
      console.log('🔊 [TTS] cache put error:', error.message);
      return false;
    }
    return true;
  } catch (err) {
    console.log('🔊 [TTS] cache put error:', err.message);
    return false;
  }
}

// Recursively collect file paths under a prefix. Supabase Storage list() is
// one level deep (folders come back with id: null), so we walk. Volume is
// tiny (~5 files/day) — no pagination pressure, but page anyway for safety.
async function listFilesRecursive(prefix) {
  const files = [];
  const PAGE = 100;
  let offset = 0;
  for (;;) {
    const { data, error } = await supabase.storage
      .from(BUCKET)
      .list(prefix, { limit: PAGE, offset });
    if (error) throw new Error(`list("${prefix}") failed: ${error.message}`);
    if (!data || data.length === 0) break;
    for (const entry of data) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.id === null) {
        files.push(...(await listFilesRecursive(path)));
      } else {
        files.push({ path, created_at: entry.created_at });
      }
    }
    if (data.length < PAGE) break;
    offset += PAGE;
  }
  return files;
}

// TTL eviction — called by the daily cron in index.js. Removes cached audio
// older than TTL_DAYS. This both caps bucket growth (~300MB steady state at
// current volume) and bounds retention of spoken user financial data after
// e.g. a conversation deletion.
async function cleanupExpired({ ttlDays = TTL_DAYS } = {}) {
  const cutoff = Date.now() - ttlDays * 86400000;
  const files = await listFilesRecursive('');
  const expired = files.filter((f) => f.created_at && new Date(f.created_at).getTime() < cutoff);
  if (expired.length > 0) {
    const { error } = await supabase.storage
      .from(BUCKET)
      .remove(expired.map((f) => f.path));
    if (error) throw new Error(`remove failed: ${error.message}`);
  }
  return { removed: expired.length, kept: files.length - expired.length };
}

module.exports = { BUCKET, TTL_DAYS, buildCacheKey, get, put, cleanupExpired };
