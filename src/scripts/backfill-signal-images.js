/**
 * One-time backfill: assign pool images to stack_signal_articles with null image_url.
 * Usage: node src/scripts/backfill-signal-images.js
 */
require('dotenv').config();
const supabase = require('../lib/supabase');

async function backfill() {
  // 1. Fetch articles missing images
  const { data: articles, error } = await supabase
    .from('stack_signal_articles')
    .select('id, slug, title, category')
    .is('image_url', null)
    .order('published_at', { ascending: false });

  if (error) {
    console.error('[Backfill] Error fetching articles:', error.message);
    process.exit(1);
  }

  if (!articles || articles.length === 0) {
    console.log('[Backfill] No articles with null image_url. Nothing to do.');
    process.exit(0);
  }

  console.log(`[Backfill] Found ${articles.length} articles with null image_url\n`);

  // 2. Pre-fetch the image pool (all articles that have images)
  const { data: allWithImages } = await supabase
    .from('stack_signal_articles')
    .select('image_url, category')
    .not('image_url', 'is', null);

  if (!allWithImages || allWithImages.length === 0) {
    console.error('[Backfill] No articles with images exist in the pool. Cannot backfill.');
    process.exit(1);
  }

  // Group by category for fast lookup
  const poolByCategory = {};
  for (const img of allWithImages) {
    const cat = img.category || 'macro';
    if (!poolByCategory[cat]) poolByCategory[cat] = [];
    poolByCategory[cat].push(img.image_url);
  }
  const allImageUrls = allWithImages.map(i => i.image_url);

  console.log(`[Backfill] Image pool: ${allImageUrls.length} total across ${Object.keys(poolByCategory).length} categories\n`);

  // 3. Assign images
  let updated = 0;
  for (const article of articles) {
    const category = article.category || 'macro';
    const categoryPool = poolByCategory[category];

    let imageUrl;
    if (categoryPool && categoryPool.length > 0) {
      imageUrl = categoryPool[Math.floor(Math.random() * categoryPool.length)];
    } else {
      imageUrl = allImageUrls[Math.floor(Math.random() * allImageUrls.length)];
    }

    const { error: updateError } = await supabase
      .from('stack_signal_articles')
      .update({ image_url: imageUrl })
      .eq('id', article.id);

    if (updateError) {
      console.log(`[Backfill] FAILED "${article.title?.slice(0, 50)}" — ${updateError.message}`);
    } else {
      updated++;
      console.log(`[Backfill] "${article.title?.slice(0, 50)}" => ${imageUrl}`);
    }
  }

  console.log(`\n[Backfill] Done. Updated ${updated}/${articles.length} articles.`);
}

backfill().catch(err => {
  console.error('[Backfill] Fatal error:', err);
  process.exit(1);
});
