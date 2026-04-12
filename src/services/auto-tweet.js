/**
 * Auto-tweet service — posts Stack Signal articles to X (@troystack_)
 *
 * Called by stack-signal-processor.js after an article saves successfully.
 * Wrapped in try/catch by the caller — tweet failure must never block saves.
 *
 * Dedup: app_state key `tweeted_signal_${slug}` holds the tweet id once posted.
 * Daily cap: app_state key `tweet_count_${YYYY-MM-DD}` (America/New_York),
 * maximum 5 tweets per day.
 */

const { TwitterApi } = require('twitter-api-v2');
const supabase = require('../lib/supabase');
const { callGemini, MODELS } = require('./ai-router');

const DAILY_TWEET_CAP = 5;

let client = null;
function getClient() {
  if (client) return client;
  const { X_CONSUMER_KEY, X_CONSUMER_SECRET, X_ACCESS_TOKEN, X_ACCESS_SECRET } = process.env;
  if (!X_CONSUMER_KEY || !X_CONSUMER_SECRET || !X_ACCESS_TOKEN || !X_ACCESS_SECRET) {
    return null;
  }
  client = new TwitterApi({
    appKey: X_CONSUMER_KEY,
    appSecret: X_CONSUMER_SECRET,
    accessToken: X_ACCESS_TOKEN,
    accessSecret: X_ACCESS_SECRET,
  });
  return client;
}

/**
 * Post an article to X. Returns the tweet id on success, null on any failure.
 * Never throws — safe to call unguarded.
 */
async function postArticleTweet(article) {
  try {
    if (!article || !article.title || !article.slug) {
      console.log('[AutoTweet] Missing article fields, skipping');
      return null;
    }

    const twitter = getClient();
    if (!twitter) {
      console.log('[AutoTweet] X credentials not configured, skipping');
      return null;
    }

    // Dedup by slug — stable, unique, available pre-insert
    const dedupKey = `tweeted_signal_${article.slug}`;
    const { data: existing } = await supabase
      .from('app_state')
      .select('value')
      .eq('key', dedupKey)
      .single();

    if (existing) {
      console.log(`[AutoTweet] Already tweeted "${article.slug}", skipping`);
      return null;
    }

    // Daily cap (America/New_York boundary to match other daily counters)
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    const capKey = `tweet_count_${today}`;
    const { data: capData } = await supabase
      .from('app_state')
      .select('value')
      .eq('key', capKey)
      .single();

    const count = capData ? parseInt(capData.value) : 0;
    if (count >= DAILY_TWEET_CAP) {
      console.log(`[AutoTweet] Daily cap reached (${count}/${DAILY_TWEET_CAP}), skipping`);
      return null;
    }

    // Generate tweet text via Gemini Flash — Troy's hot take, not a headline repost
    const url = `https://troystack.com/signal/${article.slug}`;

    const tweetPrompt = `You are Troy, a sharp precious metals analyst who posts on X. Write a tweet reacting to this news.

Headline: ${article.title}
Context: ${article.troy_one_liner || article.troy_commentary?.substring(0, 500)}

RULES:
- This is YOUR hot take, not a headline repost. Never repeat the article title.
- Sound like a real person on X — short, punchy, conversational
- One or two sentences max. Under 240 characters.
- Have an opinion. Be provocative. Take a side.
- Examples of good Troy tweets:
  "Gold at $4,750 while the Fed pretends 0.9% monthly CPI is fine. Your stack knows what they won't say."
  "COMEX registered silver just hit a 3-year low. Paper shorts are running out of metal to hide behind."
  "Silver up 200% since 2022 and still nobody on CNBC mentions it. That's how you know it's real."
  "They printed $4.6 trillion in 3 years and wonder why gold keeps climbing. Your stack isn't going up. Their dollar is going down."
- No emojis, no exclamation points, no hashtags, no "not financial advice"
- No meta-commentary, no thinking out loud, no "SILENT THOUGHT" or reasoning
- Output ONLY the tweet text. Nothing else. No quotes around it.`;

    let generatedText;
    try {
      generatedText = await callGemini(MODELS.flash, tweetPrompt, '', { temperature: 0.9, maxOutputTokens: 200 });
    } catch (geminiErr) {
      console.log(`[AutoTweet] Gemini failed, falling back to title: ${geminiErr.message}`);
      generatedText = article.title;
    }

    // Clean up Gemini output — strip quotes, reasoning artifacts, empty lines
    let cleaned = (generatedText || '').trim();
    cleaned = cleaned.replace(/^["']|["']$/g, '');
    cleaned = cleaned.replace(/^(SILENT THOUGHT|THOUGHT|THINKING|REASONING|NOTE|INTERNAL)[:\s].*$/gmi, '').trim();
    const lines = cleaned.split('\n').filter(l => l.trim() && !l.match(/^(SILENT|THOUGHT|THINKING|REASONING|NOTE|INTERNAL)/i));
    cleaned = lines.join(' ').trim();
    if (!cleaned || cleaned.length < 20) cleaned = article.title;

    const fullTweet = `${cleaned}\n\n${url}`;
    const finalText = fullTweet.length > 280
      ? `${cleaned.substring(0, 280 - url.length - 5)}...\n\n${url}`
      : fullTweet;

    // Post
    const result = await twitter.v2.tweet(finalText);
    const tweetId = result?.data?.id;
    if (!tweetId) {
      console.log('[AutoTweet] Tweet succeeded but no id returned');
      return null;
    }

    console.log(`[AutoTweet] Posted tweet ${tweetId} for "${article.slug}"`);

    // Record dedup
    await supabase
      .from('app_state')
      .upsert({ key: dedupKey, value: tweetId }, { onConflict: 'key' });

    // Increment daily cap
    await supabase
      .from('app_state')
      .upsert({ key: capKey, value: String(count + 1) }, { onConflict: 'key' });

    return tweetId;
  } catch (err) {
    console.error('[AutoTweet] Failed:', err.message);
    return null;
  }
}

module.exports = { postArticleTweet, getClient };
