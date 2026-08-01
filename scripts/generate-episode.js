/**
 * Manual / backfill podcast episode generation (podcast v1).
 *
 * Usage: node scripts/generate-episode.js [YYYY-MM-DD] [--force]
 *   No argument → today's flagship (America/New_York date).
 *   With a date → that day's flagship (backfill).
 *   --force     → regenerate the audio and UPDATE the existing row in place.
 *                 Repairs a crashed reservation stub (audio_bytes=0), and is
 *                 the documented path for regenerating an episode after
 *                 sanitizer changes (e.g. a SANITIZER_VERSION bump).
 *
 * Without --force: reserve-first idempotent — an existing podcast_episodes
 * row (published OR pending) exits before any provider spend.
 * Requires XAI_API_KEY (Grok TTS) — on Railway, or `railway run` locally.
 */
require('dotenv').config();
const { generateEpisode } = require('../src/services/podcast');

(async () => {
  try {
    const args = process.argv.slice(2);
    const force = args.includes('--force');
    const date = args.find((a) => !a.startsWith('--'));
    const result = await generateEpisode({ date, force });
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
