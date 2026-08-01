-- Podcast v1: episode registry for "The Stack Signal: Daily Gold & Silver Brief".
-- One row per published episode; the /v1/podcast/feed.xml route reads this
-- (never the bucket listing). slug matches stack_signal_articles.slug for the
-- daily flagship (the-stack-signal-YYYY-MM-DD).
-- Apply: scripts/setup-podcast-tables.js (or paste into Supabase SQL Editor).
-- Re-run safe: CREATE IF NOT EXISTS + ALTER ... ENABLE ROW LEVEL SECURITY are
-- both idempotent — if the table was already created from an earlier version
-- of this file (pre-RLS), just run the whole file again.

CREATE TABLE IF NOT EXISTS podcast_episodes (
  slug TEXT PRIMARY KEY,
  audio_url TEXT NOT NULL,        -- public troy-podcast bucket URL (RSS enclosure)
  audio_bytes BIGINT NOT NULL,    -- exact enclosure length
  duration_sec INTEGER NOT NULL,  -- estimated from bytes at 128kbps CBR (bytes/16000)
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  published_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_podcast_episodes_published
  ON podcast_episodes(published_at DESC);

-- RLS with no policies = deny-all for anon/authenticated PostgREST roles.
-- The only intended readers/writers (the feed route and the episode
-- generator) use the service-role client, which bypasses RLS.
ALTER TABLE podcast_episodes ENABLE ROW LEVEL SECURITY;
