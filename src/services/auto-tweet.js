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

    const systemPrompt = `You are Troy, a sharp precious metals analyst on X. You write short, punchy, opinionated tweets about gold and silver news. You sound like the smartest guy at the coin shop, not a news aggregator.

RULES:
- Write ONE tweet, 240 characters max
- Be opinionated and provocative — take a position
- Reference specific numbers when available (spot price, percentage moves, ratios)
- No emojis, no exclamation points, no hashtags
- No "not financial advice" or hedging language
- Never recommend selling
- Say "stack" not "portfolio"
- Dry humor welcome
- Do NOT restate the headline — give your REACTION to it
- Do NOT wrap your response in quotes
- Do NOT include any meta-commentary, reasoning, or thinking
- Return ONLY the tweet text, nothing else

EXAMPLES OF GOOD TROY TWEETS:
"CPI prints 3.3% and the Fed is still pretending rate cuts are on the table. Gold at $4,780 says the market isn't buying it either."
"Silver down 37% from January highs while industrial demand hits records. Paper market gift-wrapping physical for anyone paying attention."
"Gold/silver ratio at 63. Last time it compressed below 50, silver ran 40% in 8 weeks. The ratio doesn't lie."
"Central banks bought 19 metric tons of gold in February. They're not buying it because it's a barbarous relic."
"$88 billion a month in debt interest. That's not a number you fix with a ceasefire. That's a number you hedge with metal."`;

    const userPrompt = `Write a Troy tweet reacting to this article:
Title: ${article.title}
Summary: ${article.troy_one_liner || article.troy_commentary?.substring(0, 300) || ''}`;

    let generatedText;
    try {
      generatedText = await callGemini(MODELS.flash, systemPrompt, userPrompt, { temperature: 0.9, maxOutputTokens: 200 });
    } catch (geminiErr) {
      console.log(`[AutoTweet] Gemini failed, falling back to title: ${geminiErr.message}`);
      generatedText = null;
    }

    // Clean up Gemini output — strip quotes, reasoning artifacts, dangling quotes, empty lines
    let tweetText = (generatedText || '').trim();
    tweetText = tweetText.replace(/^["']|["']$/g, '');                           // wrapping quotes
    tweetText = tweetText.replace(/^(SILENT THOUGHT|THOUGHT|THINKING|REASONING|NOTE|INTERNAL)[:\s].*$/gmi, '').trim();
    const lines = tweetText.split('\n').filter(l => l.trim() && !l.match(/^(SILENT|THOUGHT|THINKING|REASONING|NOTE|INTERNAL)/i));
    tweetText = lines.join(' ').trim();
    tweetText = tweetText.replace(/(?<!\w)"(?!\w)/g, '').replace(/(?<!\w)'(?!\w)/g, '').trim();  // dangling stray quotes
    tweetText = tweetText.replace(/\s{2,}/g, ' ');                               // collapse double spaces

    // Fallback: if Gemini gave us nothing usable, truncate the title
    if (!tweetText || tweetText.length < 20) {
      tweetText = article.title.length > 200 ? article.title.substring(0, 200) + '...' : article.title;
    }

    console.log('[AutoTweet] Generated:', tweetText);

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
