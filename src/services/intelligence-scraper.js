/**
 * Intelligence Scraper — monitors YouTube, X (Twitter), and Reddit for
 * precious metals community discussions. Extracts claims, price targets,
 * sentiment, and key figures via Gemini Flash. Saves to troy_intelligence
 * table for injection into Troy's system prompt and Stack Signal articles.
 *
 * Crons (configured in index.js):
 *   YouTube: every 4 hours
 *   Twitter: every 2 hours
 *   Reddit:  every 3 hours
 */

const axios = require('axios');
const supabase = require('../lib/supabase');
const { callGemini, MODELS } = require('./ai-router');

// ============================================
// CHANNEL / ACCOUNT / SUBREDDIT LISTS
// ============================================

const YOUTUBE_CHANNELS = [
  { name: 'Arcadia Economics', id: 'UC7_8-CkHc3QUMqxIyolW9RA' },
  { name: 'Lynette Zang', id: 'UCQMFBO5aHwIBStCkEuAkPfg' },
  { name: 'Mike Maloney', id: 'UCThv5tYUVaG4ZPA3p6EXZbQ' },
  { name: 'Kitco News', id: 'UCa4LyQ-xDjzSEUOM3sMjUIA' },
  { name: 'Peter Schiff', id: 'UCIjuLiLhfBIcGQHjxcFanzA' },
  { name: 'Robert Kiyosaki', id: 'UCdKmOrjWOsLazeuxhPhaoQg' },
  { name: 'Wall Street Silver', id: 'UCvteX8qNZS8GVFO31xrJhFw' },
  { name: 'Andy Schectman', id: 'UC4dmpd-3NL2QBdglPQAZlQw' },
  { name: 'Rick Rule', id: 'UCfO11d1J1M3o2MrFUGu0R_A' },
  { name: 'The Asian Guy', id: 'UCjdiy7b9T1gR9jfoYAmx0dg' },
  { name: 'The Metals Insights', id: 'UChpzhUzHkpl_FvM0bUgiI_Q' },
  { name: 'Silver Dragons', id: 'UCucqfNRyBkieAop_LDUqHEg' },
  { name: 'Silver Slayer', id: 'UCHSk08tGQasDxb-PpYPowVg' },
];

const TWITTER_ACCOUNTS = [
  'DaveHcontrarian', 'PeterSchiff', 'KingWorldNews', 'silverguru22',
  'GoldTelegraph', 'WallStreetSilv', 'RobertKiyosaki', 'KeithNeumeyer',
  'SchiffGold', 'SilverSqueeze',
];

const REDDIT_SUBREDDITS = ['WallStreetSilver', 'Gold', 'Silverbugs', 'PreciousMetals'];

// ============================================
// GEMINI EXTRACTION PROMPT
// ============================================

const EXTRACTION_PROMPT = `Extract key claims, price targets, specific numbers, and sentiment from this precious metals content. Return ONLY valid JSON:

{
  "claims": ["string array of key claims or predictions"],
  "price_targets": [{"metal": "gold|silver", "target": 5000, "timeframe": "by end of 2026"}],
  "key_figures": [{"label": "COMEX registered silver", "value": "120 million oz"}],
  "sentiment": "bullish|bearish|neutral",
  "topics": ["fed", "comex", "central-banks", "silver-squeeze", "inflation"],
  "summary": "One-sentence summary of the main point"
}

If no precious metals content is found, return {"claims":[],"price_targets":[],"key_figures":[],"sentiment":"neutral","topics":[],"summary":"Not relevant to precious metals"}`;

/**
 * Parse Gemini JSON extraction response with fallback.
 */
function parseExtraction(raw) {
  try {
    const cleaned = raw.replace(/^```(?:json)?\s*\n?/g, '').replace(/\n?```\s*$/g, '').trim();
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
  } catch { /* fall through */ }
  return { claims: [], price_targets: [], key_figures: [], sentiment: 'neutral', topics: [], summary: '' };
}

/**
 * Check if a source_url already exists in troy_intelligence (dedup).
 */
async function alreadyProcessed(sourceUrl) {
  const { data } = await supabase
    .from('troy_intelligence')
    .select('id')
    .eq('source_url', sourceUrl)
    .limit(1);
  return data && data.length > 0;
}

/**
 * Save extracted intelligence to the troy_intelligence table.
 */
async function saveIntelligence(entry) {
  const { error } = await supabase.from('troy_intelligence').insert(entry);
  if (error) console.error(`[Intelligence] Save error: ${error.message}`);
}

// ============================================
// YOUTUBE SCRAPER
// ============================================

async function scrapeYouTubeChannels() {
  const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;
  if (!YOUTUBE_API_KEY) {
    console.log('📡 [Intelligence Scraper] YouTube API key not configured, skipping');
    return { scraped: 0, errors: 0 };
  }

  const { fetchTranscript } = require('youtube-transcript');
  let scraped = 0;
  let errors = 0;

  for (const channel of YOUTUBE_CHANNELS) {
    try {
      // Get latest videos from channel
      const searchUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&channelId=${channel.id}&order=date&maxResults=3&type=video&key=${YOUTUBE_API_KEY}`;
      const { data } = await axios.get(searchUrl, { timeout: 10000 });

      for (const item of (data.items || [])) {
        const videoId = item.id?.videoId;
        if (!videoId) continue;

        const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
        if (await alreadyProcessed(videoUrl)) continue;

        try {
          // Fetch auto-generated transcript
          const segments = await fetchTranscript(videoId);
          const transcript = segments.map(s => s.text).join(' ').substring(0, 3000);

          if (transcript.length < 50) continue; // too short to be useful

          // Extract via Gemini
          const raw = await callGemini(MODELS.flash, EXTRACTION_PROMPT,
            `Source: ${channel.name} (YouTube)\nTitle: ${item.snippet?.title}\nTranscript:\n${transcript}`,
            { temperature: 0.2, maxOutputTokens: 1024 });

          const extracted = parseExtraction(raw);

          await saveIntelligence({
            source_type: 'youtube',
            source_name: channel.name,
            source_url: videoUrl,
            raw_content: transcript,
            extracted_claims: extracted.claims || [],
            key_figures: extracted.key_figures || [],
            sentiment: extracted.sentiment || 'neutral',
            relevance_score: extracted.claims.length > 0 ? 70 : 30,
            topics: extracted.topics || [],
            processed: true,
          });

          scraped++;
          console.log(`📡 [YouTube] Processed: "${item.snippet?.title?.substring(0, 50)}" (${channel.name})`);
        } catch (vidErr) {
          // Transcript not available is common — don't log as error
          if (vidErr.message?.includes('Transcript') || vidErr.message?.includes('captcha')) {
            console.log(`📡 [YouTube] No transcript: ${videoId} (${channel.name})`);
          } else {
            console.error(`📡 [YouTube] Video error ${videoId}: ${vidErr.message}`);
            errors++;
          }
        }

        // Rate limit: 1 second between videos
        await new Promise(r => setTimeout(r, 1000));
      }
    } catch (chErr) {
      console.error(`📡 [YouTube] Channel error (${channel.name}): ${chErr.message}`);
      errors++;
    }
  }

  console.log(`📡 [YouTube] Done: ${scraped} scraped, ${errors} errors`);
  return { scraped, errors };
}

// ============================================
// TWITTER SCRAPER
// ============================================

async function scrapeTwitterAccounts() {
  // Lazy require to avoid circular dependency
  const { getClient } = require('./auto-tweet');
  const twitter = getClient();

  if (!twitter) {
    console.log('📡 [Intelligence Scraper] X credentials not configured, skipping Twitter');
    return { scraped: 0, errors: 0 };
  }

  let scraped = 0;
  let errors = 0;

  for (const handle of TWITTER_ACCOUNTS) {
    try {
      // Get user ID by username
      const user = await twitter.v2.userByUsername(handle);
      if (!user?.data?.id) {
        console.log(`📡 [Twitter] User not found: @${handle}`);
        continue;
      }

      // Get last 5 tweets
      const timeline = await twitter.v2.userTimeline(user.data.id, {
        max_results: 5,
        'tweet.fields': 'created_at,text',
        exclude: 'retweets,replies',
      });

      for (const tweet of (timeline.data?.data || [])) {
        const tweetUrl = `https://x.com/${handle}/status/${tweet.id}`;
        if (await alreadyProcessed(tweetUrl)) continue;

        // Extract via Gemini
        const raw = await callGemini(MODELS.flash, EXTRACTION_PROMPT,
          `Source: @${handle} (X/Twitter)\nTweet: ${tweet.text}`,
          { temperature: 0.2, maxOutputTokens: 512 });

        const extracted = parseExtraction(raw);

        // Skip if not relevant to precious metals
        if (extracted.summary?.includes('Not relevant')) continue;

        await saveIntelligence({
          source_type: 'twitter',
          source_name: `@${handle}`,
          source_url: tweetUrl,
          raw_content: tweet.text,
          extracted_claims: extracted.claims || [],
          key_figures: extracted.key_figures || [],
          sentiment: extracted.sentiment || 'neutral',
          relevance_score: extracted.claims.length > 0 ? 60 : 20,
          topics: extracted.topics || [],
          processed: true,
        });

        scraped++;
      }

      // Rate limit between accounts
      await new Promise(r => setTimeout(r, 1000));
    } catch (accErr) {
      console.error(`📡 [Twitter] Error for @${handle}: ${accErr.message}`);
      errors++;
    }
  }

  console.log(`📡 [Twitter] Done: ${scraped} scraped, ${errors} errors`);
  return { scraped, errors };
}

// ============================================
// REDDIT SCRAPER
// ============================================

async function scrapeReddit() {
  let scraped = 0;
  let errors = 0;

  for (const sub of REDDIT_SUBREDDITS) {
    try {
      const url = `https://www.reddit.com/r/${sub}/hot.json?limit=10`;
      const { data } = await axios.get(url, {
        headers: { 'User-Agent': 'TroyStack/1.0 (precious metals intelligence)' },
        timeout: 10000,
      });

      const posts = data?.data?.children || [];

      for (const post of posts) {
        const d = post.data;
        if (!d || d.stickied) continue; // skip stickied posts

        const postUrl = `https://reddit.com${d.permalink}`;
        if (await alreadyProcessed(postUrl)) continue;

        const postContent = `${d.title}\n\n${(d.selftext || '').substring(0, 500)}`;
        if (postContent.length < 20) continue;

        // Extract via Gemini
        const raw = await callGemini(MODELS.flash, EXTRACTION_PROMPT,
          `Source: r/${sub} (Reddit)\nPost: ${postContent}`,
          { temperature: 0.2, maxOutputTokens: 512 });

        const extracted = parseExtraction(raw);

        // Skip if not relevant
        if (extracted.summary?.includes('Not relevant')) continue;

        await saveIntelligence({
          source_type: 'reddit',
          source_name: `r/${sub}`,
          source_url: postUrl,
          raw_content: postContent,
          extracted_claims: extracted.claims || [],
          key_figures: extracted.key_figures || [],
          sentiment: extracted.sentiment || 'neutral',
          relevance_score: Math.min(30 + (d.score > 100 ? 20 : 0) + (extracted.claims.length * 10), 90),
          topics: extracted.topics || [],
          processed: true,
        });

        scraped++;
      }

      // Rate limit between subreddits
      await new Promise(r => setTimeout(r, 1500));
    } catch (subErr) {
      console.error(`📡 [Reddit] Error for r/${sub}: ${subErr.message}`);
      errors++;
    }
  }

  console.log(`📡 [Reddit] Done: ${scraped} scraped, ${errors} errors`);
  return { scraped, errors };
}

// ============================================
// INTELLIGENCE QUERY — for injection into Troy prompts
// ============================================

/**
 * Get the top intelligence items from the last 24 hours as a formatted
 * string suitable for injection into Troy's system prompt or Stack Signal context.
 */
async function getTopIntelligence(limit = 10) {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from('troy_intelligence')
    .select('source_type, source_name, extracted_claims, key_figures, sentiment, topics')
    .gte('created_at', cutoff)
    .order('relevance_score', { ascending: false })
    .limit(limit);

  if (error || !data || data.length === 0) return '';

  const lines = data.map(item => {
    const claims = (item.extracted_claims || []).slice(0, 2).join('; ');
    const figures = (item.key_figures || []).slice(0, 2).map(f => `${f.label}: ${f.value}`).join(', ');
    const parts = [`[${item.source_type}] ${item.source_name} (${item.sentiment})`];
    if (claims) parts.push(claims);
    if (figures) parts.push(figures);
    return '- ' + parts.join(' — ');
  });

  return lines.join('\n');
}

module.exports = {
  scrapeYouTubeChannels,
  scrapeTwitterAccounts,
  scrapeReddit,
  getTopIntelligence,
  YOUTUBE_CHANNELS,
  TWITTER_ACCOUNTS,
  REDDIT_SUBREDDITS,
};
