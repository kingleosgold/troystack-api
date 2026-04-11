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
const MAX_DAILY_IMAGES = 3;

/**
 * Check if we can generate another DALL-E image today (hard cap via app_state).
 * The value column is JSONB — access as object, not string.
 */
async function canGenerateImage() {
  const today = new Date().toISOString().split('T')[0];

  try {
    const { data } = await supabase
      .from('app_state')
      .select('value')
      .eq('key', 'dalle_daily_count')
      .single();

    if (data?.value) {
      // Handle both JSONB (object) and legacy string formats
      const val = typeof data.value === 'string' ? JSON.parse(data.value) : data.value;
      if (val.date === today) {
        return { allowed: val.count < MAX_DAILY_IMAGES, count: val.count };
      }
    }
  } catch (_) { /* no row yet — allow */ }

  return { allowed: true, count: 0 };
}

/**
 * Increment the daily DALL-E image counter in app_state.
 * Stores as plain JSONB object (not JSON.stringify).
 */
async function incrementImageCount() {
  const today = new Date().toISOString().split('T')[0];
  const { count: current } = await canGenerateImage();

  await supabase
    .from('app_state')
    .upsert({
      key: 'dalle_daily_count',
      value: { date: today, count: current + 1 },
    }, { onConflict: 'key' });
}

/**
 * Check how many synthesis articles have been generated today (via app_state).
 * Auto-resets when the date changes.
 */
async function getCommentaryCount() {
  const today = new Date().toISOString().split('T')[0];

  try {
    const { data } = await supabase
      .from('app_state')
      .select('value')
      .eq('key', 'commentary_daily_count')
      .single();

    if (data?.value) {
      const val = typeof data.value === 'string' ? JSON.parse(data.value) : data.value;
      if (val.date === today) {
        return { count: val.count, allowed: val.count < DAILY_CAP };
      }
    }
  } catch (_) { /* no row yet — allow */ }

  return { count: 0, allowed: true };
}

/**
 * Increment the daily synthesis article counter in app_state.
 * Call ONLY after an article is successfully generated.
 */
async function incrementCommentaryCount() {
  const today = new Date().toISOString().split('T')[0];
  const { count: current } = await getCommentaryCount();

  await supabase
    .from('app_state')
    .upsert({
      key: 'commentary_daily_count',
      value: { date: today, count: current + 1 },
    }, { onConflict: 'key' });

  return current + 1;
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
// PHASE 2: CLUSTER BY THEME (Gemini Flash)
// ============================================

/**
 * Group scored articles into thematic clusters using Gemini Flash.
 * Each cluster becomes one original synthesis article.
 * Returns 2-5 clusters sorted by importance.
 */
async function clusterArticles(scoredArticles) {
  const worthy = scoredArticles.filter(a => a.relevance_score >= 50);

  if (worthy.length < 3) {
    console.log(`[Clustering] Only ${worthy.length} articles scored 50+ — using as individual clusters`);
    return worthy.slice(0, 3).map(a => ({
      theme: a.title,
      importance: a.relevance_score,
      articles: [a],
      suggested_angle: 'Analyze the key developments',
      category: a.category || 'macro',
    }));
  }

  const articleSummaries = worthy.map((a, i) =>
    `[${i}] (score: ${a.relevance_score}, category: ${a.category}) ${a.title}\n${a.description || ''}`
  ).join('\n\n');

  const systemPrompt = `You are an editor at a precious metals intelligence publication. Group these articles by THEME into clusters. Each cluster represents ONE original article that a metals journalist would write today, synthesizing all sources in that cluster.`;

  const userMessage = `ARTICLES:
${articleSummaries}

Return ONLY valid JSON — no markdown, no backticks, no preamble:
[
  {
    "theme": "Compelling article title a journalist would write",
    "importance": 95,
    "article_indices": [0, 3, 7],
    "suggested_angle": "One sentence describing the unique angle Troy should take",
    "category": "gold"
  }
]

RULES:
- Maximum 5 clusters. Minimum 2.
- Each cluster must reference at least 2 source articles (by index number).
- Rank clusters by importance to precious metals stackers (0-100).
- KILL duplicate narratives — if 8 articles say "gold hits record", that's ONE cluster, not eight.
- Prioritize: physical market stories > COMEX/vault data > geopolitical impact > equities/mining stocks
- The "theme" should be a compelling original article title, NOT a copy of any source title.
- importance score should reflect the cluster's overall significance, not just the highest individual score.
- category must be one of: gold, silver, platinum, palladium, market_data, geopolitical, comex, macro, mining, central_banks

CRITICAL: Return ONLY the JSON array. No markdown, no code fences, no explanation, no text before or after the array. Start with [ and end with ]. Use double quotes for all strings. No trailing commas.`;

  try {
    const raw = await callGemini(MODELS.flash, systemPrompt, userMessage, {
      temperature: 0.3,
      responseMimeType: 'application/json',
    });

    let clusters;
    try {
      clusters = cleanJsonResponse(raw);
    } catch (e) {
      // Robust fallback: extract and clean the JSON array
      let cleaned = raw;
      cleaned = cleaned.replace(/```json\s*/gi, '').replace(/```\s*/g, '');
      const firstBracket = cleaned.indexOf('[');
      const lastBracket = cleaned.lastIndexOf(']');
      if (firstBracket !== -1 && lastBracket > firstBracket) {
        cleaned = cleaned.substring(firstBracket, lastBracket + 1);
      }
      cleaned = cleaned.replace(/,\s*([\]}])/g, '$1');
      cleaned = cleaned.replace(/\/\/.*$/gm, '');
      cleaned = cleaned.trim();

      try {
        clusters = JSON.parse(cleaned);
      } catch (e2) {
        // Last resort: replace single quotes with double quotes
        try {
          clusters = JSON.parse(cleaned.replace(/'/g, '"'));
        } catch (e3) {
          console.error(`[Clustering] Failed to parse after cleaning: ${e3.message}`);
          console.error(`[Clustering] Raw response (first 500 chars): ${raw.substring(0, 500)}`);
          throw e3;
        }
      }
    }

    if (!Array.isArray(clusters)) throw new Error('Non-array response');

    const mapped = clusters
      .map(c => ({
        ...c,
        articles: (c.article_indices || []).map(i => worthy[i]).filter(Boolean),
      }))
      .filter(c => c.articles.length > 0)
      .sort((a, b) => b.importance - a.importance)
      .slice(0, 5);

    if (mapped.length === 0) throw new Error('No valid clusters after mapping');

    console.log(`[Clustering] ${mapped.length} clusters: ${mapped.map(c => `"${c.theme.slice(0, 40)}..." (${c.articles.length} sources, importance ${c.importance})`).join(', ')}`);
    return mapped;
  } catch (err) {
    console.error(`[Clustering] Failed: ${err.message} — falling back to top articles`);
    return worthy
      .sort((a, b) => b.relevance_score - a.relevance_score)
      .slice(0, 5)
      .map(a => ({
        theme: a.title,
        importance: a.relevance_score,
        articles: [a],
        suggested_angle: 'Analyze the key developments',
        category: a.category || 'macro',
      }));
  }
}

// ============================================
// PHASE 3: WRITE SYNTHESIS ARTICLES (Claude)
// ============================================

/**
 * Write an original long-form article synthesizing all sources in a cluster.
 * Uses Claude Sonnet via the existing callClaude function.
 * Returns the article text (1500-2500 words, 6-8 paragraphs) or null on failure.
 */
async function writeSynthesisArticle(cluster, currentPrices) {
  const sourceMaterial = cluster.articles.map(a =>
    `SOURCE: ${a.source || 'Unknown'}\nTITLE: ${a.title}\nCONTENT: ${a.description || 'No content available'}`
  ).join('\n\n---\n\n');

  const goldPrice = currentPrices?.gold || 'N/A';
  const silverPrice = currentPrices?.silver || 'N/A';
  const ratio = (silverPrice && silverPrice > 0) ? (goldPrice / silverPrice).toFixed(1) : 'N/A';

  const systemPrompt = `You are Troy, a precious metals market analyst and journalist writing for TroyStack's Stack Signal publication. You are writing an ORIGINAL article that synthesizes multiple source materials into a cohesive, insightful piece.

You are NOT summarizing a single article. You are a journalist who has read everything and is writing YOUR analysis. Cite sources naturally: "According to Reuters..." / "Kitco reports..." / "COMEX data shows..."

VOICE RULES (apply to ALL output):
- Direct, opinionated, stacker worldview. No corporate speak, no hedging.
- Say "your stack" not "your portfolio"
- Say "spot" not "spot price"
- Say "oz" not "troy ounces"
- Use **bold** for key numbers and data points
- No headers, no bullet points, no numbered lists — flowing prose paragraphs only
- No emojis, no exclamation points
- Dry humor welcome but rare
- Never recommend selling. Dips are buying opportunities.
- Respects physical metal over paper markets
- Aware of COMEX manipulation, silver derivatives, central bank accumulation

STRUCTURE — Write 6-8 paragraphs. Total length: 1500-2500 words.

PARAGRAPH 1 — THE STORY (250-350 words)
Lead with the most important development. Hook the reader. Include specific numbers in **bold**. This should read like the opening of a Reuters wire story but with Troy's stacker perspective. Immediately expand into WHY it matters for physical metal holders.

PARAGRAPH 2 — THE CONTEXT (250-350 words)
Why does this matter historically? When did we last see this pattern? What followed? Reference specific dates and price levels. Include at least one historical parallel with specific dates and data (e.g., "The last time monthly CPI exceeded 0.8% for three consecutive months was 1981, and gold tripled within 18 months").

PARAGRAPH 3 — THE PHYSICAL MARKET (250-350 words)
What's happening in physical vs paper? COMEX inventory, dealer premiums, delivery demand, vault drawdowns, mine supply. This is Troy's edge — the physical market intelligence nobody else synthesizes. Address the paper vs physical disconnect when relevant: what is spot doing vs what are dealers actually charging? What does the premium environment suggest about real demand?

PARAGRAPH 4 — CONNECTING THE DOTS (250-350 words)
Cross-reference data from multiple sources. Show patterns the individual articles miss. "Reuters reports X, while COMEX data shows Y — together these suggest..." Include COMEX/supply context when relevant: registered inventory trends, delivery volumes, mining output pressures.

PARAGRAPH 5 — PURCHASING POWER (200-300 words)
What does this data mean in terms of barrels of oil, months of rent, or hours of labor that gold/silver can buy? Frame the price action in real-world purchasing power terms, not just dollars. The dollars change. The metal's purchasing power holds.

PARAGRAPH 6 — WHAT TO WATCH (200-300 words)
Specific dates, price levels, thresholds, upcoming events. Be precise: "Watch the March 5 COMEX delivery report" not "watch upcoming data." What triggers would escalate the situation? What would de-escalate it?

PARAGRAPH 7 (optional) — THE STACKER'S EDGE (150-200 words)
Direct take on what this means for someone building a physical stack.

CRITICAL FORMAT RULES:
- Separate each paragraph with a blank line (two newlines: \\n\\n)
- DO NOT write one long block of text
- DO NOT use headers, labels, or section titles before paragraphs
- Each paragraph must be a distinct block separated by a blank line
- This is non-negotiable

ARTICLE DEPTH REQUIREMENTS:
- Open with the core story, then immediately expand into WHY it matters for physical metal holders
- Include at least one historical parallel with specific dates and data (e.g., "The last time monthly CPI exceeded 0.8% for three consecutive months was 1981, and gold tripled within 18 months")
- Include purchasing power context: what does this data mean in terms of barrels of oil, months of rent, or hours of labor that gold/silver can buy?
- Address the paper vs physical disconnect when relevant: what is spot doing vs what are dealers actually charging? What does the premium environment suggest about real demand?
- Include a COMEX/supply context paragraph when relevant: registered inventory trends, delivery volumes, mining output pressures
- End with a forward-looking paragraph: what to watch next, what triggers would escalate or de-escalate the situation
- Write with Troy's voice: direct, opinionated, no hedging, no "not financial advice", no emojis, no exclamation points
- Use "your stack" not "your portfolio"
- Bold key numbers and figures using markdown bold
- No bullet points or lists — write in flowing paragraphs
- Reference specific metals data: spot price, ratio, percentage moves, historical comparisons with specific dates
- The tone is confident and informed, like a seasoned analyst writing a private briefing for serious investors`;

  const userMessage = `ARTICLE THEME: ${cluster.theme}
SUGGESTED ANGLE: ${cluster.suggested_angle}
CURRENT PRICES: Gold $${goldPrice}, Silver $${silverPrice}, G/S Ratio: ${ratio}:1

SOURCE MATERIAL (${cluster.articles.length} sources):

${sourceMaterial}

Write the article. Remember: 6-8 paragraphs, 1500-2500 words total, separated by blank lines.`;

  try {
    return await callClaude(systemPrompt, userMessage, { maxTokens: 4000 });
  } catch (err) {
    console.error(`[Synthesis] Claude error for "${cluster.theme}": ${err.message}`);
    return null;
  }
}

async function writeFeedReaction(cluster, prices) {
  const sourceText = cluster.articles
    .map(a => `HEADLINE: ${a.title}\nSOURCE: ${a.source || 'Unknown'}\nEXCERPT: ${(a.content || a.description || '').slice(0, 300)}`)
    .join('\n\n---\n\n');

  const systemPrompt = `You are Troy, a sharp precious metals analyst who posts reactions to market news for your followers. You're the knowledgeable guy at the coin shop who's been stacking since 2008.

VOICE:
- Direct, opinionated, data-driven
- You REACT to news, you don't summarize it
- Tell your followers what the real story is and what everyone else is missing
- Use specific numbers — spot levels, COMEX data, percentages
- Say "your stack" not "your portfolio", "spot" not "spot price", "oz" not "troy ounces"
- No hedging, no "on the other hand", no corporate speak
- No emojis, no exclamation points
- Use **bold** for key numbers only
- Stacker worldview: dips are buying opportunities, never recommend selling

FORMAT:
- 2-3 tight paragraphs, like a social media post
- First paragraph: your hot take on what this actually means
- Second paragraph: the data or context that supports your view
- Optional third paragraph: what stackers should watch next
- Total length: 150-250 words. No more.

Current spot: Gold ${prices.gold || 'N/A'}, Silver ${prices.silver || 'N/A'}, Ratio ${prices.gold && prices.silver ? (prices.gold / prices.silver).toFixed(1) : 'N/A'}:1`;

  const userPrompt = `React to this market news:\n\n${sourceText}`;

  const response = await callGemini(MODELS.flash, systemPrompt, userPrompt, { temperature: 0.9 });
  return response;
}

/**
 * Generate one-liner and metadata for a synthesis article.
 * Uses Gemini Flash for the one-liner (cheap).
 */
async function generateArticleMetadata(cluster, articleText) {
  const systemPrompt = `You are a precious metals news editor. Write a single punchy headline one-liner (max 100 characters) for this article. The author is Troy, a metals analyst with a stacker worldview. No emojis, no exclamation points.`;

  const userMessage = `Article title: ${cluster.theme}\nArticle excerpt: ${articleText.substring(0, 500)}\n\nReturn ONLY the one-liner, nothing else.`;

  let oneLiner;
  try {
    const raw = await callGemini(MODELS.flash, systemPrompt, userMessage, {
      temperature: 0.5,
      maxOutputTokens: 100,
    });
    oneLiner = raw.trim().replace(/^["']|["']$/g, '');
  } catch (err) {
    console.log(`[Metadata] One-liner generation failed: ${err.message}`);
    oneLiner = cluster.theme;
  }

  return {
    title: cluster.theme,
    troy_one_liner: oneLiner,
    category: cluster.category || 'macro',
    relevance_score: cluster.importance,
    sources: cluster.articles.map(a => ({
      name: a.source || 'Unknown',
      url: a.link || null,
      title: a.title,
    })),
  };
}

// ============================================
// PHASE 4: ARTICLE IMAGES
// ============================================

const USE_DALLE = false; // Set to true to re-enable DALL-E image generation

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
 * Assign an existing image from the database pool, matched by category.
 * Zero cost — reuses the 800+ DALL-E images already generated.
 */
async function assignExistingImage(article) {
  const category = article.category || 'gold';

  // Try category match first
  let { data: images } = await supabase
    .from('stack_signal_articles')
    .select('image_url')
    .eq('category', category)
    .not('image_url', 'is', null)
    .limit(50);

  // Fallback to any image if no category match
  if (!images || images.length === 0) {
    const { data: fallback } = await supabase
      .from('stack_signal_articles')
      .select('image_url')
      .not('image_url', 'is', null)
      .limit(50);
    images = fallback;
  }

  if (!images || images.length === 0) {
    return null;
  }

  const randomIndex = Math.floor(Math.random() * images.length);
  return images[randomIndex].image_url;
}

/**
 * DALL-E image generation (disabled by default — USE_DALLE flag).
 * Generates hero images via OpenAI DALL-E 3, daily-capped at MAX_DAILY_IMAGES.
 */
async function generateDalleImages(articles) {
  const eligible = articles.filter(a => a.troy_commentary && (a.relevance_score || 0) >= 85);

  if (!eligible.length) {
    console.log('[Images] No synthesis articles scoring 85+');
    return articles;
  }

  const { allowed, count: imagesSoFar } = await canGenerateImage();
  if (!allowed) {
    console.log(`[Images] DALL-E daily cap reached (${imagesSoFar}/${MAX_DAILY_IMAGES}) — skipping all`);
    return articles;
  }

  const toGenerate = eligible
    .sort((a, b) => b.relevance_score - a.relevance_score)
    .slice(0, MAX_DAILY_IMAGES - imagesSoFar);

  console.log(`[Images] Generating ${toGenerate.length} DALL-E images (${imagesSoFar} already today, cap ${MAX_DAILY_IMAGES})`);

  for (const article of toGenerate) {
    const { allowed: stillAllowed, count: currentCount } = await canGenerateImage();
    if (!stillAllowed) {
      console.log(`[Images] DALL-E daily cap reached (${currentCount}/${MAX_DAILY_IMAGES}) — stopping`);
      break;
    }

    try {
      console.log(`[Images] DALL-E daily count: ${currentCount}/${MAX_DAILY_IMAGES} — generating for "${article.title.slice(0, 50)}"`);

      const categoryStyle = CATEGORY_STYLE[article.category] || CATEGORY_STYLE.macro;
      const articleSnippet = article.troy_commentary ? article.troy_commentary.substring(0, 200) : '';
      const imagePrompt = `Editorial illustration for precious metals article: "${article.title}". Context: ${articleSnippet}. Style: ${categoryStyle}. Photorealistic, moody lighting, cinematic composition, no text or watermarks.`;

      const tempUrl = await generateImage(imagePrompt, { size: '1792x1024' });
      await incrementImageCount();

      const imageResp = await axios.get(tempUrl, { responseType: 'arraybuffer', timeout: 30000 });
      const buffer = Buffer.from(imageResp.data);
      const fileName = `${article.slug || generateSlug(article.title)}.png`;

      const { error: uploadError } = await supabase.storage
        .from('stack-signal-images')
        .upload(fileName, buffer, {
          contentType: 'image/png',
          upsert: true,
        });

      if (uploadError) {
        console.log(`[Images] Upload failed for "${article.title.slice(0, 40)}": ${uploadError.message}`);
        article.image_url = tempUrl;
      } else {
        const { data: publicUrl } = supabase.storage
          .from('stack-signal-images')
          .getPublicUrl(fileName);
        article.image_url = publicUrl.publicUrl;
      }

      article.image_prompt = imagePrompt;
      console.log(`[Images] Done: "${article.title.slice(0, 50)}..."`);

      await new Promise(r => setTimeout(r, 1000));
    } catch (err) {
      console.log(`[Images] Failed for "${article.title.slice(0, 40)}": ${err.message}`);
    }
  }

  return articles;
}

/**
 * Assign images to articles.
 * When USE_DALLE is false: assigns from existing image pool (all articles, zero cost).
 * When USE_DALLE is true: generates via DALL-E (top 3 by score, daily-capped).
 */
async function generateArticleImages(articles) {
  if (USE_DALLE) {
    return generateDalleImages(articles);
  }

  // Pool mode: assign existing images to ALL articles missing an image
  const eligible = articles.filter(a => !a.image_url);
  if (!eligible.length) {
    console.log('[Images] All articles already have images');
    return articles;
  }

  console.log(`[Images] Assigning images from pool for ${eligible.length} articles`);

  for (const article of eligible) {
    try {
      const imageUrl = await assignExistingImage(article);
      if (imageUrl) {
        article.image_url = imageUrl;
      } else {
        console.log(`[Images] No pool image found for "${article.title.slice(0, 40)}"`);
      }
    } catch (err) {
      console.log(`[Images] Pool assignment failed for "${article.title.slice(0, 40)}": ${err.message}`);
    }
  }

  console.log(`[Images] Assigned ${eligible.filter(a => a.image_url).length}/${eligible.length} images from pool`);
  return articles;
}

// ============================================
// PHASE 5: SAVE ARTICLES
// ============================================

/**
 * Save synthesized articles to stack_signal_articles table.
 */
async function saveArticles(articles) {
  if (!articles.length) {
    console.log('[Save] No articles to save');
    return 0;
  }

  const validArticles = articles.filter(a => {
    if (!a.troy_commentary || a.troy_commentary.length < 2500) {
      console.log(`[Save] Filtered out short article: "${a.title?.substring(0, 50)}" (${a.troy_commentary?.length || 0} chars)`);
      return false;
    }
    return true;
  });

  if (!validArticles.length) {
    console.log(`[Save] All ${articles.length} articles filtered out (< 2500 chars)`);
    return 0;
  }

  const prices = getCachedPrices();
  let saved = 0;

  for (const article of validArticles) {
    try {
      const row = {
        slug: article.slug || generateSlug(article.title),
        title: article.title,
        troy_commentary: article.troy_commentary || null,
        troy_one_liner: article.troy_one_liner || null,
        category: article.category || 'macro',
        sources: article.sources || [],
        image_url: article.image_url || null,
        image_prompt: article.image_prompt || null,
        gold_price_at_publish: prices.gold || null,
        silver_price_at_publish: prices.silver || null,
        relevance_score: article.relevance_score || 0,
        is_stack_signal: false,
        published_at: new Date().toISOString(),
      };

      // Safety net: assign image from pool if missing
      console.log(`[SaveArticles] Checking image for ${row.slug}: image_url = ${row.image_url ? 'present' : 'NULL'}`);
      if (!row.image_url) {
        try {
          // Try category match first
          let { data: poolImages } = await supabase
            .from('stack_signal_articles')
            .select('image_url')
            .eq('category', row.category)
            .not('image_url', 'is', null)
            .limit(50);

          console.log(`[SaveArticles] Pool query returned ${poolImages?.length || 0} images for category ${row.category}`);
          // Fallback to any category if no match
          if (!poolImages || poolImages.length === 0) {
            const fallback = await supabase
              .from('stack_signal_articles')
              .select('image_url')
              .not('image_url', 'is', null)
              .limit(50);
            poolImages = fallback.data;
          }

          if (poolImages && poolImages.length > 0) {
            row.image_url = poolImages[Math.floor(Math.random() * poolImages.length)].image_url;
            console.log(`[SaveArticles] Assigned fallback pool image (${row.category}) to: ${row.slug}`);
          }
        } catch (err) {
          console.error('[SaveArticles] Fallback image assignment failed:', err.message);
        }
      }

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

  console.log(`[Save] Saved ${saved}/${validArticles.length} articles (${articles.length - validArticles.length} filtered out)`);
  return saved;
}

// ============================================
// DAILY STACK SIGNAL SYNTHESIS
// ============================================

/**
 * Generate the daily "Stack Signal" synthesis narrative.
 * Pulls last 24h synthesis articles and writes a comprehensive daily digest.
 */
async function generateStackSignal(timeOfDay = 'morning') {
  console.log(`\n[Stack Signal] Generating ${timeOfDay} synthesis...`);

  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const { data: recentArticles, error } = await supabase
    .from('stack_signal_articles')
    .select('title, troy_commentary, troy_one_liner, category, sources, relevance_score')
    .eq('is_stack_signal', false)
    .gte('published_at', cutoff)
    .order('relevance_score', { ascending: false })
    .limit(10);

  if (error) {
    console.log(`[Stack Signal] DB error: ${error.message}`);
    return null;
  }

  if (!recentArticles || recentArticles.length === 0) {
    console.log('[Stack Signal] No recent articles to synthesize');
    return null;
  }

  const prices = getCachedPrices();

  // Use one-liners + first 500 chars of each article (full text is now 1500-2500 words)
  const articleSummaries = recentArticles.map((a, i) =>
    `${i + 1}. [${a.category}] "${a.title}" (Score: ${a.relevance_score})\n   Troy's take: ${a.troy_one_liner || 'N/A'}\n   ${(a.troy_commentary || 'No commentary').substring(0, 500)}`
  ).join('\n\n');

  const systemPrompt = `You are Troy, writing "The Stack Signal" — your daily precious metals intelligence briefing for TroyStack users. Today's source material is your own long-form synthesis articles from the day. Distill the key themes into a cohesive morning overview — connect the dots between your articles and tell stackers what the overall picture looks like today.

Your voice: Direct, analytical, conversational. You've been stacking since 2008. You track COMEX flows, central bank buying, the gold/silver ratio. No emojis. No exclamation points. No corporate jargon.

Structure your synthesis as flowing prose in 3-4 paragraphs:
1. The headline — what's the single most important thing today
2. The context — how your articles connect and what the pattern means
3. What it means for your stack — concrete implications for physical stackers
4. One thing to watch — a forward-looking signal

Current spot: Gold $${prices.gold || 'N/A'}, Silver $${prices.silver || 'N/A'}.
Gold/Silver Ratio: ${prices.silver > 0 ? (prices.gold / prices.silver).toFixed(1) : 'N/A'}.

Return JSON: { "title": "The Stack Signal — [date]", "commentary": "...", "one_liner": "..." }
The one_liner is the headline summary (max 20 words).
Return ONLY valid JSON.`;

  const today = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/New_York' });
  const preambleMap = {
    evening: 'This is the EVENING post-market-close edition. Focus on: how the trading day played out, notable price action and volume, what moved markets today, and what to watch overnight. Frame this as a market close recap, not a morning preview.',
    weekly_recap: 'This is the FRIDAY WEEKLY RECAP. Summarize the entire week in precious metals: key price moves day by day, biggest stories, COMEX activity, and what shifted for stackers this week. End with what to watch next week.',
    weekly_preview: 'This is the MONDAY WEEKLY PREVIEW. Look ahead at the week: scheduled economic data releases, Fed speakers, geopolitical developments, and technical levels to watch for gold and silver. Frame this as what stackers should have on their radar this week.',
    monthly_recap: 'This is the MONTH-END REVIEW. Summarize the entire month in precious metals: opening vs closing prices, percentage changes, biggest stories and themes, COMEX trends, central bank activity, and how the month shaped up for stackers. Provide monthly context — was this a good month to stack?',
    yearly_recap: 'This is the YEAR-END REVIEW. Summarize the entire year in precious metals: January opening vs December closing prices for gold, silver, platinum, and palladium. Percentage changes for the year. The biggest stories, themes, and turning points. COMEX trends across the year. Central bank buying patterns. How the gold-silver ratio evolved. What stackers who bought consistently this year gained. Frame this as the definitive year-end retrospective for precious metals stackers.'
  };
  const preamble = preambleMap[timeOfDay] || '';
  const userMessage = `${preamble ? preamble + '\n\n' : ''}Write today's Stack Signal for ${today}.\n\nToday's articles (${recentArticles.length}):\n\n${articleSummaries}`;

  try {
    const raw = await callClaude(systemPrompt, userMessage, { maxTokens: 2048 });
    const parsed = cleanJsonResponse(raw);

    // Generate hero image for the daily signal (subject to daily DALL-E cap)
    let imageUrl = null;
    let imagePrompt = null;
    if (USE_DALLE) {
      const { allowed: canGenImg, count: imgCount } = await canGenerateImage();
      if (canGenImg) {
        try {
          console.log(`[Stack Signal] DALL-E daily count: ${imgCount}/${MAX_DAILY_IMAGES} — generating synthesis image`);
          imagePrompt = `Editorial illustration for "The Stack Signal" daily precious metals intelligence brief. Gold and silver bars with financial data overlays, moody cinematic lighting, newspaper editorial style. No text or watermarks.`;
          const tempUrl = await generateImage(imagePrompt, { size: '1792x1024' });
          await incrementImageCount();

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
      } else {
        console.log(`[Stack Signal] DALL-E daily cap reached (${imgCount}/${MAX_DAILY_IMAGES}) — skipping synthesis image`);
      }
    } else {
      // Pool mode: assign existing image
      imageUrl = await assignExistingImage({ category: 'macro' });
      if (imageUrl) {
        console.log('[Stack Signal] Assigned image from pool for daily synthesis');
      }
    }

    if (!imageUrl) {
      try {
        let { data: poolImages } = await supabase
          .from('stack_signal_articles')
          .select('image_url')
          .eq('category', 'macro')
          .not('image_url', 'is', null)
          .limit(50);

        if (!poolImages || poolImages.length === 0) {
          const fallback = await supabase
            .from('stack_signal_articles')
            .select('image_url')
            .not('image_url', 'is', null)
            .limit(50);
          poolImages = fallback.data;
        }

        if (poolImages && poolImages.length > 0) {
          imageUrl = poolImages[Math.floor(Math.random() * poolImages.length)].image_url;
          console.log('[Stack Signal] Assigned fallback pool image to daily digest');
        }
      } catch (err) {
        console.error('[Stack Signal] Fallback image failed:', err.message);
      }
    }

    // Save as stack signal article
    const dateStr = new Date().toISOString().split('T')[0];
    const titleMap = {
      morning: 'The Stack Signal',
      evening: 'Evening Signal',
      weekly_recap: 'Weekly Recap',
      weekly_preview: 'The Week Ahead',
      monthly_recap: 'Monthly Review',
      yearly_recap: 'Year in Review'
    };
    const titlePrefix = titleMap[timeOfDay] || 'The Stack Signal';
    const slugPrefixMap = {
      morning: 'the-stack-signal',
      evening: 'evening-signal',
      weekly_recap: 'weekly-recap',
      weekly_preview: 'week-ahead',
      monthly_recap: 'monthly-review',
      yearly_recap: 'year-in-review'
    };
    const slug = `${slugPrefixMap[timeOfDay] || 'the-stack-signal'}-${dateStr}`;
    const row = {
      slug,
      title: parsed.title || `${titlePrefix} — ${today}`,
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
 * Run the full Stack Signal v2 pipeline.
 *
 * Phase 0: Fetch RSS feeds
 * Phase 1: Score articles individually (Gemini Flash)
 * Phase 2: Cluster scored articles by theme (Gemini Flash)
 * Phase 3: Write synthesis article per cluster (Claude Sonnet)
 * Phase 4: Generate images (DALL-E 3)
 * Phase 5: Save to database
 * Phase 6: Push notification for top article
 */
async function runStackSignalPipeline() {
  const startTime = Date.now();
  console.log(`\n${'━'.repeat(50)}`);
  console.log(`  Stack Signal v2 Pipeline — ${new Date().toISOString()}`);
  console.log(`${'━'.repeat(50)}`);

  try {
    // Phase 0: Fetch RSS articles
    console.log('\n[Pipeline] Phase 0: Fetching RSS feeds...');
    const rawArticles = await fetchNewArticles();

    if (!rawArticles.length) {
      console.log('[Pipeline] No new articles found. Pipeline complete.');
      return { articles: 0, scored: 0, clusters: 0, synthesized: 0, saved: 0 };
    }

    // Phase 1: Score
    console.log('\n[Pipeline] Phase 1: Scoring articles...');
    const scoredArticles = await scoreArticles(rawArticles);

    // Phase 2: Cluster by theme
    console.log('\n[Pipeline] Phase 2: Clustering articles by theme...');
    const clusters = await clusterArticles(scoredArticles);
    console.log(`[Pipeline] ${clusters.length} clusters identified`);

    // Phase 3: Write synthesis articles (daily-capped)
    const today = new Date().toISOString().split('T')[0];
    const { count: commentaryToday, allowed } = await getCommentaryCount();

    if (!allowed) {
      console.log(`[Pipeline] Daily synthesis cap reached: ${commentaryToday}/${DAILY_CAP} (${today}) — skipping entire cycle`);
      return { articles: rawArticles.length, scored: scoredArticles.length, clusters: clusters.length, synthesized: 0, saved: 0, skipped: true };
    }

    const remainingSlots = DAILY_CAP - commentaryToday;
    const clustersToWrite = clusters.slice(0, remainingSlots);

    console.log(`\n[Pipeline] Phase 3: Writing ${clustersToWrite.length} synthesis articles (${commentaryToday} already today, cap ${DAILY_CAP})...`);

    const prices = getCachedPrices();
    const synthesizedArticles = [];

    for (let i = 0; i < clustersToWrite.length; i++) {
      // Re-check cap before each article
      const { count: currentCount, allowed: stillAllowed } = await getCommentaryCount();
      if (!stillAllowed) {
        console.log(`[Synthesis] Daily cap reached: ${currentCount}/${DAILY_CAP} — stopping`);
        break;
      }

      const cluster = clustersToWrite[i];
      console.log(`[Synthesis] Writing article ${i + 1}/${clustersToWrite.length}: "${cluster.theme.slice(0, 50)}" (${cluster.articles.length} sources, importance: ${cluster.importance})`);

      const articleText = await writeFeedReaction(cluster, prices);
      if (!articleText) {
        console.log(`[Synthesis] Skipped: "${cluster.theme.slice(0, 50)}" — no output from Claude`);
        continue;
      }

      const metadata = await generateArticleMetadata(cluster, articleText);
      const newCount = await incrementCommentaryCount();

      const article = {
        ...metadata,
        troy_commentary: articleText,
        slug: generateSlug(metadata.title),
      };

      synthesizedArticles.push(article);

      const paragraphs = articleText.split('\n\n').filter(p => p.trim().length > 0);
      console.log(`[Synthesis] Done: "${cluster.theme.slice(0, 50)}" — ${articleText.length} chars, ${paragraphs.length} paragraphs (daily: ${newCount}/${DAILY_CAP})`);

      // Small delay between Claude calls
      await new Promise(r => setTimeout(r, 500));
    }

    if (!synthesizedArticles.length) {
      console.log('[Pipeline] No synthesis articles generated');
      return { articles: rawArticles.length, scored: scoredArticles.length, clusters: clusters.length, synthesized: 0, saved: 0 };
    }

    // Phase 4: Images
    console.log(`\n[Pipeline] Phase 4: Generating images for ${synthesizedArticles.length} articles...`);
    const withImages = await generateArticleImages(synthesizedArticles);

    // Phase 5: Save
    console.log('\n[Pipeline] Phase 5: Saving to database...');
    const saved = await saveArticles(withImages);

    // Phase 6: Push notification for the HIGHEST-scoring article only (1 per cycle)
    console.log('\n[Pipeline] Phase 6: Checking for breaking news push...');
    try {
      const { maybePushStackSignalAlert } = require('./stack-signal-push');
      const pushCandidates = withImages
        .filter(a => (a.relevance_score || 0) >= 85)
        .sort((a, b) => (b.relevance_score || 0) - (a.relevance_score || 0));

      if (pushCandidates.length > 0) {
        const top = pushCandidates[0];
        console.log(`[Pipeline] Top article for push: score=${top.relevance_score}, "${top.title?.slice(0, 50)}" (${pushCandidates.length} candidates)`);
        await maybePushStackSignalAlert({
          slug: top.slug || generateSlug(top.title),
          title: top.title,
          relevance_score: top.relevance_score,
          troy_one_liner: top.troy_one_liner,
          troy_commentary: top.troy_commentary,
        });
      } else {
        console.log('[Pipeline] No articles scored 85+ for push');
      }
    } catch (err) {
      console.log(`[Pipeline] Push phase error: ${err.message}`);
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\n${'━'.repeat(50)}`);
    console.log(`  Pipeline Complete`);
    console.log(`  RSS: ${rawArticles.length} fetched, ${scoredArticles.length} scored`);
    console.log(`  Clusters: ${clusters.length} identified, ${synthesizedArticles.length} written`);
    console.log(`  Saved: ${saved} | Runtime: ${elapsed}s`);
    console.log(`${'━'.repeat(50)}\n`);

    return { articles: rawArticles.length, scored: scoredArticles.length, clusters: clusters.length, synthesized: synthesizedArticles.length, saved };
  } catch (err) {
    console.error(`[Pipeline] Fatal error: ${err.message}`);
    return { articles: 0, scored: 0, clusters: 0, synthesized: 0, saved: 0, error: err.message };
  }
}

module.exports = {
  scoreArticles,
  clusterArticles,
  writeSynthesisArticle,
  generateArticleImages,
  saveArticles,
  generateStackSignal,
  runStackSignalPipeline,
};
