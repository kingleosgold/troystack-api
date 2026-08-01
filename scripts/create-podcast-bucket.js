/**
 * One-off: create the PUBLIC troy-podcast Supabase Storage bucket (podcast v1).
 * Idempotent — safe to re-run.
 *
 * Config: public:true (RSS enclosures need public URLs), 50MB file limit,
 * audio/mpeg only. Episodes are retained FOREVER — this bucket must stay
 * permanently excluded from every cleanup cron (the tts-cache TTL cron only
 * touches its own troy-voice-cache bucket; keep it that way).
 *
 * Run: node scripts/create-podcast-bucket.js
 */
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const BUCKET = 'troy-podcast';

(async () => {
  const { data: buckets, error: listErr } = await supabase.storage.listBuckets();
  if (listErr) {
    console.error('❌ listBuckets failed:', listErr.message);
    process.exit(1);
  }

  const existing = buckets.find((b) => b.name === BUCKET);
  if (existing) {
    console.log(`✅ Bucket "${BUCKET}" already exists:`);
    console.log(`   public: ${existing.public}, file_size_limit: ${existing.file_size_limit}, allowed_mime_types: ${JSON.stringify(existing.allowed_mime_types)}`);
    if (!existing.public) {
      console.error('⚠️  Bucket is PRIVATE — podcast enclosures need public URLs. Fix in Supabase dashboard.');
      process.exit(1);
    }
    process.exit(0);
  }

  const { error: createErr } = await supabase.storage.createBucket(BUCKET, {
    public: true,
    fileSizeLimit: 50 * 1024 * 1024, // 50MB — episodes are ~4MB today; headroom for longer formats
    allowedMimeTypes: ['audio/mpeg', 'image/png'], // MP3 episodes + artwork.png
  });
  if (createErr) {
    console.error('❌ createBucket failed:', createErr.message);
    process.exit(1);
  }
  console.log(`✅ Created public bucket "${BUCKET}" (50MB limit, audio/mpeg + artwork)`);
})();
