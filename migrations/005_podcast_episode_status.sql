-- Podcast v1.1: explicit episode lifecycle state machine.
-- Replaces the implicit audio_bytes=0 stub convention with a declared state:
--   'pending'  — an attempt owns the row; attempt_started_at is its lease
--                start (lease = 10 min, enforced in the claim UPDATE in
--                src/services/podcast.js, not in the schema).
--   'complete' — audio uploaded and finalized; served by the feed.
-- DEFAULT 'complete' intentionally grandfathers any pre-existing rows
-- (they were only ever written fully-formed before this migration).
-- Paste into the Supabase SQL Editor. Re-run safe: ADD COLUMN IF NOT EXISTS.

-- attempt_token binds ownership to a specific attempt: every acquisition
-- (NEW insert, stale claim, force demote) writes a fresh token the caller
-- keeps, and finalize only lands WHERE attempt_token matches — a caller
-- whose lease was stolen can never finalize over the new owner's attempt.
ALTER TABLE podcast_episodes
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'complete' CHECK (status IN ('pending','complete')),
  ADD COLUMN IF NOT EXISTS attempt_started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS attempt_token UUID NOT NULL DEFAULT gen_random_uuid();
