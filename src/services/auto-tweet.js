// callGemini signature: callGemini(model, systemPrompt, userMessage, options)
// options: { temperature, maxOutputTokens, responseMimeType, timeout }
// Returns: string (raw text response)
const { TwitterApi } = require('twitter-api-v2');
const supabase = require('../lib/supabase');
// Note: generateTweetText + sanitizeTweetText are lazy-required inside
// postArticleTweet() to avoid circular dependency with stack-signal-processor
// (which imports postArticleTweet from this file).

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
    console.log(`[AutoTweet] Daily cap check: ${count} / ${DAILY_TWEET_CAP}`);
    if (count >= DAILY_TWEET_CAP) {
      console.log(`[AutoTweet] Daily cap reached (${count}/${DAILY_TWEET_CAP}), skipping`);
      return null;
    }

    // Lazy require to avoid circular dependency (stack-signal-processor ↔ auto-tweet)
    const { generateTweetText, sanitizeTweetText } = require('./stack-signal-processor');

    // Get tweet text — prefer pre-generated, fall back to Gemini, then title
    const url = `https://troystack.com/signal/${article.slug}`;
    let tweetText;

    if (article.tweet_text) {
      // Use pre-generated tweet from article creation pipeline
      tweetText = sanitizeTweetText(article.tweet_text) || article.tweet_text.trim();
      console.log('[AutoTweet] Using pre-generated tweet:', tweetText);
    } else {
      // Fallback for old articles without tweet_text: generate via Gemini
      console.log('[AutoTweet] No tweet_text on article, generating via Gemini...');
      tweetText = await generateTweetText(article.title, article.troy_commentary);

      if (!tweetText) {
        tweetText = article.title.length > 200 ? article.title.substring(0, 200) + '...' : article.title;
        console.log('[AutoTweet] Gemini fallback failed, using title');
      } else {
        console.log('[AutoTweet] Generated:', tweetText);
      }
    }

    // Assemble final tweet: text + URL, trim text if total exceeds 280
    const maxTextLen = 280 - url.length - 2;  // 2 for "\n\n"
    if (tweetText.length > maxTextLen) {
      tweetText = tweetText.substring(0, maxTextLen - 3) + '...';
    }
    const finalText = `${tweetText}\n\n${url}`;

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
