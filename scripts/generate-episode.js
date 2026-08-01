/**
 * Manual / backfill podcast episode generation (podcast v1).
 *
 * Usage: node scripts/generate-episode.js [YYYY-MM-DD]
 *   No argument → today's flagship (America/New_York date).
 *   With a date → that day's flagship (backfill).
 *
 * Idempotent: an existing podcast_episodes row for the slug is a no-op.
 * Requires XAI_API_KEY (Grok TTS) — on Railway, or `railway run` locally.
 */
require('dotenv').config();
const { generateEpisode } = require('../src/services/podcast');

(async () => {
  try {
    const result = await generateEpisode({ date: process.argv[2] });
    if (result.created) {
      console.log(`✅ Episode published: ${result.slug}`);
      console.log(`   ${result.audioUrl}`);
      console.log(`   ${result.audioBytes} bytes, ~${result.durationSec}s`);
    } else {
      console.log(`⏭️  Skipped: ${result.reason}`);
    }
    process.exit(0);
  } catch (err) {
    console.error('❌ Episode generation failed:', err.message);
    process.exit(1);
  }
})();
