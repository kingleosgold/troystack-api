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

    // Build tweet body
    const url = `https://troystack.com/signal/${article.slug}`;
    const title = article.title.trim();
    const oneLiner = (article.troy_one_liner || '').trim();

    // 280 char budget: title + "\n\n" + summary + "\n\n" + url
    const fixedLen = title.length + url.length + 4; // 4 for the two "\n\n"
    const summaryBudget = 280 - fixedLen;

    let summary = oneLiner;
    if (summary && summary.length > summaryBudget) {
      summary = summaryBudget > 3 ? summary.substring(0, summaryBudget - 3) + '...' : '';
    }

    const tweetText = summary
      ? `${title}\n\n${summary}\n\n${url}`
      : `${title}\n\n${url}`;

    const finalText = tweetText.length > 280 ? tweetText.substring(0, 277) + '...' : tweetText;

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
