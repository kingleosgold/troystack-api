const axios = require('axios');
const supabase = require('../lib/supabase');
const { callGemini, callClaude, generateImage, MODELS } = require('./ai-router');
const { fetchNewArticles } = require('./rss-fetcher');
const { getCachedPrices } = require('./price-fetcher');

// ============================================
// HELPERS
// ============================================

function generateSlug(title) {
  const date = new Date().toISOString().split('T')[0];
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 80)
    .replace(/-$/, '');
  return `${slug}-${date}`;
}

function cleanJsonResponse(text) {
  const cleaned = text.replace(/^```(?:json)?\s*\n?/g, '').replace(/\n?```\s*$/g, '').trim();
  return JSON.parse(cleaned);
}

const DAILY_CAP = 8;

/**
 * Count how many articles created today (UTC) have a non-null field.
 */
async function getTodayCount(field) {
  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);

  const { count, error } = await supabase
    .from('stack_signal_articles')
    .select('*', { count: 'exact', head: true })
    .not(field, 'is', null)
    .gte('created_at', todayStart.toISOString())
    .eq('is_stack_signal', false);

  if (error) {
    console.log(`[DailyCap] Error checking ${field}: ${error.message}`);
    return 0;
  }
  return count || 0;
}

// ============================================
// PHASE 1: SCORE ARTICLES (Gemini Flash)
// ============================================

/**
 * Batch-score articles for relevance using Gemini Flash.
 * Batches in groups of 25 to avoid oversized prompts.
 * Returns articles with relevance_score and category added.
 */
async function scoreArticles(articles) {
  if (!articles.length) return [];

  const BATCH_SIZE = 25;
  const allScored = [];

  for (let batchStart = 0; batchStart < articles.length; batchStart += BATCH_SIZE) {
    const batch = articles.slice(batchStart, batchStart + BATCH_SIZE);
    const batchNum = Math.floor(batchStart / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(articles.length / BATCH_SIZE);

    console.log(`[Score] Batch ${batchNum}/${totalBatches} (${batch.length} articles)`);

    const articleList = batch.map((a, i) => `${i + 1}. "${a.title}" — ${a.description}`).join('\n');

    const systemPrompt = `You are a precious metals news relevance scorer. Score each article 0-100 for relevance to physical gold/silver stackers. Assign a category.

Categories: macro, gold, silver, mining, central_banks, geopolitical, market_data

Return a JSON array with objects: { "index": 1, "score": 85, "category": "gold" }
Return ONLY the JSON array, no other text.`;

    const userMessage = `Score these ${batch.length} articles for precious metals stacker relevance:\n\n${articleList}`;

    try {
      const raw = await callGemini(MODELS.flash, systemPrompt, userMessage, {
        temperature: 0.2,
        responseMimeType: 'application/json',
      });

      let scores;
      try {
        scores = cleanJsonResponse(raw);
      } catch (parseErr) {
        // Try extracting JSON array from response
        const match = raw.match(/\[[\s\S]*\]/);
        if (match) {
          scores = JSON.parse(match[0]);
        } else {
          throw parseErr;
        }
      }

      if (!Array.isArray(scores)) {
        console.log(`[Score] Batch ${batchNum}: non-array response, using defaults`);
        allScored.push(...batch.map(a => ({ ...a, relevance_score: 50, category: 'macro' })));
        continue;
      }

      for (let i = 0; i < batch.length; i++) {
        const scoreData = scores.find(s => s.index === i + 1) || {};
        allScored.push({
          ...batch[i],
          relevance_score: Math.min(Math.max(parseInt(scoreData.score) || 50, 0), 100),
          category: scoreData.category || 'macro',
        });
      }

      const above60 = scores.filter(s => (s.score || 0) >= 60).length;
      console.log(`[Score] Batch ${batchNum}: ${above60}/${batch.length} scored 60+`);
    } catch (err) {
      console.log(`[Score] Batch ${batchNum} failed: ${err.message} — using defaults`);
      allScored.push(...batch.map(a => ({ ...a, relevance_score: 50, category: 'macro' })));
    }

    // Small delay between batches
    if (batchStart + BATCH_SIZE < articles.length) {
      await new Promise(r => setTimeout(r, 500));
    }
  }

  const totalAbove60 = allScored.filter(a => a.relevance_score >= 60).length;
  console.log(`[Score] Total: ${totalAbove60}/${allScored.length} scored 60+`);

  return allScored;
}

// ============================================
// PHASE 2: GENERATE COMMENTARY (Claude Sonnet)
// ============================================

/**
 * Generate Troy's original commentary for high-scoring articles.
 * Only processes articles scoring 60+, daily-capped at 8 total.
 */
async function generateCommentary(articles, prices) {
  // Check daily cap before doing any Claude calls
  const commentaryToday = await getTodayCount('troy_commentary');
  const remaining = DAILY_CAP - commentaryToday;

  if (remaining <= 0) {
    console.log(`[Commentary] Daily cap reached (${commentaryToday}/${DAILY_CAP} today) — skipping`);
    return [];
  }

  const eligible = articles
    .filter(a => a.relevance_score >= 60)
    .sort((a, b) => b.relevance_score - a.relevance_score)
    .slice(0, remaining);

  if (!eligible.length) {
    console.log('[Commentary] No articles scored 60+');
    return [];
  }

  console.log(`[Commentary] Generating for ${eligible.length} articles (${commentaryToday} already today, cap ${DAILY_CAP})`);

  const systemPrompt = `You are Troy, the precious metals stack analyst from Stack Tracker Gold. You write original commentary on metals news — not summaries, but your take as a stacker who's been in the game since 2008.

Your voice: Direct, data-driven, conversational. Short sentences. You track COMEX physical flows, central bank buying, the gold/silver ratio. You never recommend selling. Dips are entry points. No emojis. No exclamation points.

Current spot: Gold $${prices.gold || 'N/A'}, Silver $${prices.silver || 'N/A'}.

For each article, provide:
1. A one-liner (max 15 words) — Troy's punchy take
2. A commentary paragraph (80-150 words) — original analysis connecting the news to what it means for stackers

Return JSON: { "one_liner": "...", "commentary": "..." }
Return ONLY valid JSON.`;

  const results = [];

  for (const article of eligible) {
    try {
      const userMessage = `Article: "${article.title}"\nSource: ${article.source}\nSummary: ${article.description}\nCategory: ${article.category}\n\nWrite Troy's take.`;

      const raw = await callClaude(systemPrompt, userMessage, { maxTokens: 1024 });
      const parsed = cleanJsonResponse(raw);

      results.push({
        ...article,
        troy_commentary: parsed.commentary || '',
        troy_one_liner: parsed.one_liner || '',
      });

      console.log(`[Commentary] Done: "${article.title.slice(0, 50)}..."`);

      // Small delay between Claude calls
      await new Promise(r => setTimeout(r, 500));
    } catch (err) {
      console.log(`[Commentary] Failed for "${article.title.slice(0, 40)}": ${err.message}`);
      // Still include article without commentary
      results.push({ ...article, troy_commentary: '', troy_one_liner: '' });
    }
  }

  return results;
}

// ============================================
// PHASE 3: GENERATE IMAGES (DALL-E 3)
// ============================================

const CATEGORY_STYLE = {
  macro: 'sweeping financial landscape with gold bars and currency symbols',
  gold: 'gleaming gold bars and coins in dramatic lighting',
  silver: 'polished silver bars and coins with industrial elements',
  mining: 'underground mine with precious metal ore veins',
  central_banks: 'grand vault interior with gold reserves',
  geopolitical: 'world map with gold flow arrows and geopolitical symbols',
  market_data: 'financial charts and precious metals data visualization',
};

/**
 * Generate hero images for articles with commentary.
 * Daily-capped at 8 total DALL-E images (~$0.08/image = ~$0.64/day max).
 * Uploads to Supabase Storage bucket 'stack-signal-images'.
 */
async function generateArticleImages(articles) {
  const withCommentary = articles.filter(a => a.troy_commentary);

  if (!withCommentary.length) {
    console.log('[Images] No articles with commentary');
    return articles;
  }

  // Check daily cap before doing any DALL-E calls
  const imagesToday = await getTodayCount('image_url');
  const remaining = DAILY_CAP - imagesToday;

  if (remaining <= 0) {
    console.log(`[Images] Daily cap reached (${imagesToday}/${DAILY_CAP} today) — skipping`);
    return articles;
  }

  const toGenerate = withCommentary
    .sort((a, b) => b.relevance_score - a.relevance_score)
    .slice(0, remaining);

  console.log(`[Images] Generating ${toGenerate.length} images (${imagesToday} already today, cap ${DAILY_CAP})`);

  for (const article of toGenerate) {
    try {
      const categoryStyle = CATEGORY_STYLE[article.category] || CATEGORY_STYLE.macro;
      const imagePrompt = `Editorial illustration for precious metals news article: "${article.title}". Style: ${categoryStyle}. Photorealistic, moody lighting, cinematic composition, no text or watermarks.`;

      const tempUrl = await generateImage(imagePrompt, { size: '1792x1024' });

      // Download image and upload to Supabase Storage
      const imageResp = await axios.get(tempUrl, { responseType: 'arraybuffer', timeout: 30000 });
      const buffer = Buffer.from(imageResp.data);
      const fileName = `${generateSlug(article.title)}.png`;

      const { error: uploadError } = await supabase.storage
        .from('stack-signal-images')
        .upload(fileName, buffer, {
          contentType: 'image/png',
          upsert: true,
        });

      if (uploadError) {
        console.log(`[Images] Upload failed for "${article.title.slice(0, 40)}": ${uploadError.message}`);
        article.image_url = tempUrl; // fallback to temp URL
      } else {
        const { data: publicUrl } = supabase.storage
          .from('stack-signal-images')
          .getPublicUrl(fileName);
        article.image_url = publicUrl.publicUrl;
      }

      article.image_prompt = imagePrompt;
      console.log(`[Images] Done: "${article.title.slice(0, 50)}..."`);

      // Delay between DALL-E calls
      await new Promise(r => setTimeout(r, 1000));
    } catch (err) {
      console.log(`[Images] Failed for "${article.title.slice(0, 40)}": ${err.message}`);
    }
  }

  return articles;
}

// ============================================
// PHASE 4: SAVE ARTICLES
// ============================================

/**
 * Save processed articles to stack_signal_articles table.
 */
async function saveArticles(articles) {
  if (!articles.length) {
    console.log('[Save] No articles to save');
    return 0;
  }

  const prices = getCachedPrices();
  let saved = 0;

  for (const article of articles) {
    try {
      const slug = generateSlug(article.title);
      const row = {
        slug,
        title: article.title,
        troy_commentary: article.troy_commentary || null,
        troy_one_liner: article.troy_one_liner || null,
        category: article.category || 'macro',
        sources: [{ url: article.link, name: article.source, description: article.description }],
        image_url: article.image_url || null,
        image_prompt: article.image_prompt || null,
        gold_price_at_publish: prices.gold || null,
        silver_price_at_publish: prices.silver || null,
        relevance_score: article.relevance_score || 0,
        is_stack_signal: false,
        published_at: article.pubDate ? article.pubDate.toISOString() : new Date().toISOString(),
      };

      const { error } = await supabase
        .from('stack_signal_articles')
        .upsert(row, { onConflict: 'slug' });

      if (error) {
        console.log(`[Save] Failed: "${article.title.slice(0, 40)}": ${error.message}`);
      } else {
        saved++;
      }
    } catch (err) {
      console.log(`[Save] Error: "${article.title.slice(0, 40)}": ${err.message}`);
    }
  }

  console.log(`[Save] Saved ${saved}/${articles.length} articles`);
  return saved;
}

// ============================================
// PHASE 5: DAILY STACK SIGNAL SYNTHESIS
// ============================================

/**
 * Generate the daily "Stack Signal" synthesis narrative.
 * Pulls last 24h articles and writes a comprehensive daily digest.
 */
async function generateStackSignal() {
  console.log('\n[Stack Signal] Generating daily synthesis...');

  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const { data: recentArticles, error } = await supabase
    .from('stack_signal_articles')
    .select('title, troy_commentary, troy_one_liner, category, sources, relevance_score')
    .eq('is_stack_signal', false)
    .gte('published_at', cutoff)
    .order('relevance_score', { ascending: false })
    .limit(20);

  if (error) {
    console.log(`[Stack Signal] DB error: ${error.message}`);
    return null;
  }

  if (!recentArticles || recentArticles.length === 0) {
    console.log('[Stack Signal] No recent articles to synthesize');
    return null;
  }

  const prices = getCachedPrices();

  const articleSummaries = recentArticles.map((a, i) =>
    `${i + 1}. [${a.category}] "${a.title}" (Score: ${a.relevance_score})\n   Troy's take: ${a.troy_one_liner || 'N/A'}\n   ${a.troy_commentary || 'No commentary'}`
  ).join('\n\n');

  const systemPrompt = `You are Troy, writing "The Stack Signal" — your daily precious metals intelligence briefing for Stack Tracker Gold users. This is a comprehensive synthesis, not a summary. Connect the dots between stories, identify the signal from the noise, and tell stackers what actually matters today.

Your voice: Direct, analytical, conversational. You've been stacking since 2008. You track COMEX flows, central bank buying, the gold/silver ratio. No emojis. No exclamation points. No corporate jargon.

Structure your synthesis as flowing prose in 3-4 paragraphs:
1. The headline — what's the single most important thing today
2. The context — how other stories connect and what the pattern means
3. What it means for your stack — concrete implications for physical stackers
4. One thing to watch — a forward-looking signal

Current spot: Gold $${prices.gold || 'N/A'}, Silver $${prices.silver || 'N/A'}.
Gold/Silver Ratio: ${prices.silver > 0 ? (prices.gold / prices.silver).toFixed(1) : 'N/A'}.

Return JSON: { "title": "The Stack Signal — [date]", "commentary": "...", "one_liner": "..." }
The one_liner is the headline summary (max 20 words).
Return ONLY valid JSON.`;

  const today = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/New_York' });
  const userMessage = `Write today's Stack Signal for ${today}.\n\nToday's articles (${recentArticles.length}):\n\n${articleSummaries}`;

  try {
    const raw = await callClaude(systemPrompt, userMessage, { maxTokens: 2048 });
    const parsed = cleanJsonResponse(raw);

    // Generate hero image for the daily signal
    let imageUrl = null;
    let imagePrompt = null;
    try {
      imagePrompt = `Editorial illustration for "The Stack Signal" daily precious metals intelligence brief. Gold and silver bars with financial data overlays, moody cinematic lighting, newspaper editorial style. No text or watermarks.`;
      const tempUrl = await generateImage(imagePrompt, { size: '1792x1024' });

      const imageResp = await axios.get(tempUrl, { responseType: 'arraybuffer', timeout: 30000 });
      const buffer = Buffer.from(imageResp.data);
      const fileName = `stack-signal-${new Date().toISOString().split('T')[0]}.png`;

      const { error: uploadError } = await supabase.storage
        .from('stack-signal-images')
        .upload(fileName, buffer, { contentType: 'image/png', upsert: true });

      if (!uploadError) {
        const { data: publicUrl } = supabase.storage
          .from('stack-signal-images')
          .getPublicUrl(fileName);
        imageUrl = publicUrl.publicUrl;
      } else {
        imageUrl = tempUrl;
      }
    } catch (imgErr) {
      console.log(`[Stack Signal] Image generation failed: ${imgErr.message}`);
    }

    // Save as stack signal article
    const slug = `the-stack-signal-${new Date().toISOString().split('T')[0]}`;
    const row = {
      slug,
      title: parsed.title || `The Stack Signal — ${today}`,
      troy_commentary: parsed.commentary || '',
      troy_one_liner: parsed.one_liner || '',
      category: 'macro',
      sources: [...new Map(
        recentArticles
          .flatMap(a => a.sources || [])
          .filter(s => s && s.name)
          .map(s => [s.name, s])
      ).values()],
      image_url: imageUrl,
      image_prompt: imagePrompt,
      gold_price_at_publish: prices.gold || null,
      silver_price_at_publish: prices.silver || null,
      relevance_score: 100,
      is_stack_signal: true,
      published_at: new Date().toISOString(),
    };

    const { error: saveError } = await supabase
      .from('stack_signal_articles')
      .upsert(row, { onConflict: 'slug' });

    if (saveError) {
      console.log(`[Stack Signal] Save failed: ${saveError.message}`);
      return null;
    }

    console.log(`[Stack Signal] Daily synthesis saved: "${parsed.title || slug}"`);
    return row;
  } catch (err) {
    console.log(`[Stack Signal] Synthesis failed: ${err.message}`);
    return null;
  }
}

// ============================================
// ORCHESTRATOR
// ============================================

/**
 * Run the full Stack Signal pipeline (phases 1-4).
 * Phase 5 (daily synthesis) runs on its own schedule.
 */
async function runStackSignalPipeline() {
  const startTime = Date.now();
  console.log(`\n${'━'.repeat(50)}`);
  console.log(`  Stack Signal Pipeline — ${new Date().toISOString()}`);
  console.log(`${'━'.repeat(50)}`);

  try {
    // Fetch RSS articles
    console.log('\n[Pipeline] Phase 0: Fetching RSS feeds...');
    const rawArticles = await fetchNewArticles();

    if (!rawArticles.length) {
      console.log('[Pipeline] No new articles found. Pipeline complete.');
      return { articles: 0, scored: 0, commentary: 0, saved: 0 };
    }

    // Phase 1: Score
    console.log('\n[Pipeline] Phase 1: Scoring articles...');
    const scoredArticles = await scoreArticles(rawArticles);

    // Phase 2: Commentary
    console.log('\n[Pipeline] Phase 2: Generating commentary...');
    const prices = getCachedPrices();
    const withCommentary = await generateCommentary(scoredArticles, prices);

    // Phase 3: Images
    console.log('\n[Pipeline] Phase 3: Generating images...');
    const withImages = await generateArticleImages(withCommentary);

    // Phase 4: Save
    console.log('\n[Pipeline] Phase 4: Saving to database...');
    const saved = await saveArticles(withImages);

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\n${'━'.repeat(50)}`);
    console.log(`  Pipeline Complete`);
    console.log(`  Articles: ${rawArticles.length} fetched, ${withCommentary.length} with commentary, ${saved} saved`);
    console.log(`  Runtime: ${elapsed}s`);
    console.log(`${'━'.repeat(50)}\n`);

    return { articles: rawArticles.length, scored: scoredArticles.length, commentary: withCommentary.length, saved };
  } catch (err) {
    console.error(`[Pipeline] Fatal error: ${err.message}`);
    return { articles: 0, scored: 0, commentary: 0, saved: 0, error: err.message };
  }
}

module.exports = {
  scoreArticles,
  generateCommentary,
  generateArticleImages,
  saveArticles,
  generateStackSignal,
  runStackSignalPipeline,
};
