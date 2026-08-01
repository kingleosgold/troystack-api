/**
 * Display-only: prints the podcast_episodes migration SQL for manual
 * execution in the Supabase SQL Editor.
 *
 * The migration was applied to production on 2026-07-31 — this script is
 * display-only going forward (kept for new-environment setup and as the
 * pointer to the canonical SQL). The previous DATABASE_URL/pg direct-DDL
 * branch was removed per Codex review: pg was never a declared dependency,
 * and no environment here has DATABASE_URL set.
 *
 * Usage: node scripts/setup-podcast-tables.js
 */
const fs = require('fs');
const path = require('path');

const MIGRATIONS = ['004_podcast_episodes.sql', '005_podcast_episode_status.sql'];

console.log('Podcast table setup — paste the following into the Supabase SQL Editor:');
console.log('(re-run safe: CREATE IF NOT EXISTS + idempotent ALTERs)\n');
for (const m of MIGRATIONS) {
  console.log(`-- ─── ${m} ───`);
  console.log(fs.readFileSync(path.join(__dirname, '..', 'migrations', m), 'utf-8'));
}
process.exit(0);
