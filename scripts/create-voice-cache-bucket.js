/**
 * One-off: create the private troy-voice-cache Supabase Storage bucket for
 * the TTS audio cache (Phase A). Idempotent — safe to re-run; reports the
 * existing bucket's config if it is already there.
 *
 * Config: public:false, 10MB file limit, audio/mpeg only. No RLS policies
 * are added — only the service-role key (server) can touch it, which is the
 * point: cached Troy audio speaks user financial data and must never be
 * publicly reachable. Serving happens exclusively through the authed
 * /v1/troy/speak endpoint (src/services/tts-cache.js).
 *
 * Run: node scripts/create-voice-cache-bucket.js
 */
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const BUCKET = 'troy-voice-cache';

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
    if (existing.public) {
      console.error('⚠️  Bucket is PUBLIC — it must be private. Fix in Supabase dashboard.');
      process.exit(1);
    }
    process.exit(0);
  }

  const { error: createErr } = await supabase.storage.createBucket(BUCKET, {
    public: false,
    fileSizeLimit: 10 * 1024 * 1024, // 10MB — largest observed cache file is 2.4MB; 4000-char gate ceiling ≈ 4.6MB
    allowedMimeTypes: ['audio/mpeg'],
  });
  if (createErr) {
    console.error('❌ createBucket failed:', createErr.message);
    process.exit(1);
  }
  console.log(`✅ Created private bucket "${BUCKET}" (10MB limit, audio/mpeg only)`);
})();
