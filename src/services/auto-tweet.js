/**
 * Auto-tweet service — queue-based tweet posting for Stack Signal articles.
 *
 * Two functions:
 *   - enqueueTweet(article): called by the pipeline after saving an article.
 *     Inserts into tweet_queue with scheduled_for time (urgent = now, else 20-90m).
 *   - processTweetQueue(): called by cron every 5 minutes. Picks one ready tweet,
 *     posts it, marks as posted. Urgent tweets go first.
 *
 * Daily cap: 15 tweets/day via app_state `tweet_count_${YYYY-MM-DD}`.
 * Dedup: article_id FK ensures one queue entry per article.
 */

const { TwitterApi } = require('twitter-api-v2');
const supabase = require('../lib/supabase');

const DAILY_TWEET_CAP = 15;

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

// ============================================
// ENQUEUE — called from the pipeline after saving an article
// ============================================

/**
 * Insert a tweet into the queue with a scheduled_for time.
 * @param {object} article - { id (UUID from DB), slug, title, tweet_text, signal_score }
 * @param {number} batchIndex - position in current batch (0-based), for spacing
 */
async function enqueueTweet(article, batchIndex = 0) {
  try {
    if (!article?.tweet_text || !article?.slug) {
      console.log('[Tweet Queue] Missing tweet_text or slug, skipping enqueue');
      return;
    }

    const isUrgent = (article.signal_score || 0) >= 90;
    const url = `https://troystack.com/signal/${article.slug}`;

    // Scheduling: urgent = now, otherwise 20-90 min out, spaced 15 min apart within a batch
    let scheduledFor;
    if (isUrgent) {
      scheduledFor = new Date();
    } else {
      const baseDelay = 20 * 60 * 1000 + Math.random() * 70 * 60 * 1000; // 20-90 min
      const batchSpacing = batchIndex * 15 * 60 * 1000; // +15 min per batch position
      scheduledFor = new Date(Date.now() + baseDelay + batchSpacing);
    }

    const { error } = await supabase
      .from('tweet_queue')
      .insert({
        article_id: article.id || null,
        tweet_text: article.tweet_text,
        article_url: url,
        signal_score: article.signal_score || 50,
        urgent: isUrgent,
        scheduled_for: scheduledFor.toISOString(),
      });

    if (error) {
      console.log(`[Tweet Queue] Enqueue error: ${error.message}`);
    } else {
      const delayMin = Math.round((scheduledFor.getTime() - Date.now()) / 60000);
      console.log(`[Tweet Queue] Enqueued: "${article.title?.substring(0, 50)}..." → ${isUrgent ? 'URGENT (now)' : `in ${delayMin}m`}`);
    }
  } catch (err) {
    console.log(`[Tweet Queue] Enqueue failed (non-fatal): ${err.message}`);
  }
}

// ============================================
// PROCESS QUEUE — called by cron every 5 minutes
// ============================================

async function processTweetQueue() {
  try {
    const twitter = getClient();
    if (!twitter) {
      return { posted: false, reason: 'no_credentials' };
    }

    // Daily cap
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    const capKey = `tweet_count_${today}`;
    const { data: capData } = await supabase
      .from('app_state')
      .select('value')
      .eq('key', capKey)
      .single();

    const count = capData ? parseInt(capData.value) : 0;
    if (count >= DAILY_TWEET_CAP) {
      return { posted: false, reason: 'daily_cap', count, cap: DAILY_TWEET_CAP };
    }

    // Fetch one ready tweet (urgent first, then by scheduled_for)
    const { data: pending, error: fetchErr } = await supabase
      .from('tweet_queue')
      .select('*')
      .eq('posted', false)
      .lte('scheduled_for', new Date().toISOString())
      .order('urgent', { ascending: false })
      .order('scheduled_for', { ascending: true })
      .limit(1)
      .single();

    if (fetchErr || !pending) {
      return { posted: false, reason: 'queue_empty' };
    }

    // Sanitize tweet text
    const { sanitizeTweetText } = require('./stack-signal-processor');
    let tweetText = sanitizeTweetText(pending.tweet_text) || pending.tweet_text.trim();

    // Assemble final tweet
    const url = pending.article_url || '';
    const maxTextLen = 280 - 23 - 2; // 23 = t.co, 2 = \n\n
    if (tweetText.length > maxTextLen) {
      tweetText = tweetText.substring(0, maxTextLen - 3) + '...';
    }
    const finalText = url ? `${tweetText}\n\n${url}` : tweetText;

    // Post
    const result = await twitter.v2.tweet(finalText);
    const tweetId = result?.data?.id;

    if (!tweetId) {
      console.log('[Tweet Queue] Tweet posted but no ID returned');
      return { posted: false, reason: 'no_tweet_id' };
    }

    // Mark as posted
    await supabase
      .from('tweet_queue')
      .update({ posted: true, posted_at: new Date().toISOString(), tweet_id: tweetId })
      .eq('id', pending.id);

    // Increment daily cap
    await supabase
      .from('app_state')
      .upsert({ key: capKey, value: String(count + 1) }, { onConflict: 'key' });

    const scheduledAge = Math.round((Date.now() - new Date(pending.scheduled_for).getTime()) / 60000);
    console.log(`[Tweet Queue] Posted: "${tweetText.substring(0, 80)}..." [urgent: ${pending.urgent}, scheduled ${scheduledAge}m ago, daily: ${count + 1}/${DAILY_TWEET_CAP}]`);

    return { posted: true, tweet_id: tweetId, urgent: pending.urgent };
  } catch (err) {
    console.error('[Tweet Queue] Process error:', err.message);
    return { posted: false, reason: 'error', error: err.message };
  }
}

module.exports = { enqueueTweet, processTweetQueue, getClient };
