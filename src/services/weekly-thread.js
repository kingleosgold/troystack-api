/**
 * Weekly X Thread Generator
 *
 * Fires every Sunday 6 PM ET via cron in index.js. Generates a 5-7 tweet
 * thread summarizing the week in precious metals and posts to @troystack_.
 *
 * - Reuses auto-tweet.js Twitter client
 * - Uses Gemini Flash for thread generation (cheap)
 * - Deduped by ISO week via app_state key `weekly_thread_${YYYY-WW}`
 */

const supabase = require('../lib/supabase');
const { callGemini, MODELS } = require('./ai-router');
const { getSpotPrices } = require('./price-fetcher');
const { getClient } = require('./auto-tweet');

/**
 * ISO week number for a date. Returns string like "2026-15".
 */
function isoWeekKey(date = new Date()) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNum = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-${String(weekNum).padStart(2, '0')}`;
}

function cleanJsonResponse(text) {
  const cleaned = text.replace(/^```(?:json)?\s*\n?/g, '').replace(/\n?```\s*$/g, '').trim();
  return JSON.parse(cleaned);
}

/**
 * Fetch the oldest price_log row from the last 7-8 days so we can compute
 * a weekly change. Falls back to null if no row exists.
 */
async function getWeekAgoPrices() {
  const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString();
  const eightDaysAgo = new Date(Date.now() - 8 * 86400000).toISOString();

  const { data } = await supabase
    .from('price_log')
    .select('timestamp, gold, silver')
    .gte('timestamp', eightDaysAgo)
    .lte('timestamp', sevenDaysAgo)
    .order('timestamp', { ascending: true })
    .limit(1);

  return data && data.length > 0 ? data[0] : null;
}

function pctChange(current, previous) {
  if (!previous || previous === 0) return null;
  return ((current - previous) / previous) * 100;
}

function fmtPct(n) {
  if (n === null || !Number.isFinite(n)) return 'flat';
  const sign = n >= 0 ? '+' : '';
  return `${sign}${n.toFixed(1)}%`;
}

async function generateAndPostWeeklyThread() {
  console.log('\n[WeeklyThread] Starting weekly thread generation...');

  // Dedup by ISO week
  const weekKey = `weekly_thread_${isoWeekKey()}`;
  const { data: existing } = await supabase
    .from('app_state')
    .select('value')
    .eq('key', weekKey)
    .single();

  if (existing) {
    console.log(`[WeeklyThread] Already posted for week ${weekKey}, skipping`);
    return null;
  }

  // Fetch this week's Stack Signal articles
  const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString();
  const { data: articles, error: articlesErr } = await supabase
    .from('stack_signal_articles')
    .select('title, troy_one_liner, relevance_score, category, published_at')
    .gte('published_at', sevenDaysAgo)
    .order('relevance_score', { ascending: false })
    .limit(10);

  if (articlesErr) {
    console.error(`[WeeklyThread] Article fetch error: ${articlesErr.message}`);
    return null;
  }

  if (!articles || articles.length === 0) {
    console.log('[WeeklyThread] No Stack Signal articles this week, skipping');
    return null;
  }

  // Current spot + weekly change
  const spotData = await getSpotPrices();
  const prices = spotData?.prices;
  if (!prices?.gold || !prices?.silver) {
    console.log('[WeeklyThread] Spot prices unavailable, skipping');
    return null;
  }

  const weekAgo = await getWeekAgoPrices();
  const goldChange = weekAgo ? pctChange(prices.gold, weekAgo.gold) : null;
  const silverChange = weekAgo ? pctChange(prices.silver, weekAgo.silver) : null;
  const ratio = prices.silver > 0 ? (prices.gold / prices.silver).toFixed(1) : 'N/A';

  const topStories = articles.slice(0, 5).map((a, i) => `${i + 1}. ${a.title}`).join('\n');

  // Build prompt for Gemini
  const systemPrompt = `You are Troy, the TroyStack AI precious metals analyst. Write a Twitter thread (5-7 tweets) summarizing this week in precious metals.

Thread rules:
- Tweet 1: Hook — the single most important thing that happened this week for stackers. Bold claim, no hedging.
- Tweets 2-4: Key developments with specific numbers. Connect each to what it means for physical metal holders.
- Tweet 5: Purchasing power update — what 1 oz of gold and 1 oz of silver buy this week in real terms (barrels of oil, gallons of gas).
- Tweet 6: What to watch next week.
- Final tweet: "Track your stack → troystack.com | Read the full analysis → troystack.com/signal"

Each tweet under 280 characters.
No emojis, no exclamation points, no "not financial advice".
Troy's voice: direct, opinionated, data-driven.
Use "your stack" not "your portfolio".
Bold key numbers with caps or emphasis (e.g., "Gold closed at $4,751").

Return as a JSON array of strings, one per tweet. No markdown, no backticks, just the JSON array.`;

  const userPrompt = `Data:
- Gold: $${prices.gold} (${fmtPct(goldChange)} this week)
- Silver: $${prices.silver} (${fmtPct(silverChange)} this week)
- Gold/Silver ratio: ${ratio}
- Key stories this week:
${topStories}

Write the thread. Return only the JSON array of tweet strings.`;

  let tweets;
  try {
    const raw = await callGemini(MODELS.flash, systemPrompt, userPrompt, {
      temperature: 0.8,
      maxOutputTokens: 2000,
      responseMimeType: 'application/json',
    });
    tweets = cleanJsonResponse(raw);
  } catch (err) {
    console.error(`[WeeklyThread] Gemini error: ${err.message}`);
    return null;
  }

  if (!Array.isArray(tweets) || tweets.length < 3) {
    console.error(`[WeeklyThread] Invalid tweet array: ${tweets?.length || 0} tweets`);
    return null;
  }

  // Enforce 280-char cap per tweet
  const cleanTweets = tweets
    .map(t => (typeof t === 'string' ? t.trim() : ''))
    .filter(t => t.length > 0)
    .map(t => (t.length > 280 ? t.substring(0, 277) + '...' : t));

  if (cleanTweets.length < 3) {
    console.error('[WeeklyThread] Too few valid tweets after cleaning');
    return null;
  }

  console.log(`[WeeklyThread] Generated ${cleanTweets.length} tweets, posting thread...`);

  // Post thread — first tweet standalone, rest as replies
  const client = getClient();
  if (!client) {
    console.error('[WeeklyThread] X credentials not configured, skipping post');
    return null;
  }

  const postedIds = [];
  let previousId = null;

  for (let i = 0; i < cleanTweets.length; i++) {
    try {
      const tweetOptions = previousId
        ? { reply: { in_reply_to_tweet_id: previousId } }
        : {};
      const result = await client.v2.tweet(cleanTweets[i], tweetOptions);
      const tweetId = result?.data?.id;
      if (!tweetId) {
        console.error(`[WeeklyThread] Tweet ${i + 1}/${cleanTweets.length} returned no id`);
        break;
      }
      postedIds.push(tweetId);
      previousId = tweetId;
      console.log(`[WeeklyThread] Posted ${i + 1}/${cleanTweets.length}: ${tweetId}`);
      // Brief delay between tweets to avoid rate limits
      await new Promise(r => setTimeout(r, 1000));
    } catch (err) {
      console.error(`[WeeklyThread] Failed to post tweet ${i + 1}/${cleanTweets.length}: ${err.message}`);
      break;
    }
  }

  if (postedIds.length === 0) {
    console.error('[WeeklyThread] No tweets posted, not marking week as done');
    return null;
  }

  // Mark week as done
  try {
    await supabase
      .from('app_state')
      .upsert({
        key: weekKey,
        value: JSON.stringify({
          posted_at: new Date().toISOString(),
          root_tweet_id: postedIds[0],
          tweet_count: postedIds.length,
        }),
      }, { onConflict: 'key' });
  } catch (err) {
    console.error(`[WeeklyThread] Failed to save dedup key: ${err.message}`);
  }

  console.log(`[WeeklyThread] Thread complete: ${postedIds.length} tweets, root ${postedIds[0]}`);
  return { rootTweetId: postedIds[0], tweetCount: postedIds.length };
}

module.exports = { generateAndPostWeeklyThread, isoWeekKey };
