/**
 * Auto-reply service — Troy replies to high-engagement tweets from metals influencers.
 *
 * Monitors 10 accounts, replies to tweets with 100+ likes that haven't
 * been replied to yet. Generates Troy-voiced replies via Gemini Flash.
 *
 * Caps:
 *   - 10 replies/day total (reply_count_${date})
 *   - 1 reply per account per 24h (replied_account_${handle}_${date})
 *   - Dedup by tweet ID (replied_tweet_${tweetId})
 *
 * Cron: every 30 minutes (configured in index.js)
 */

const supabase = require('../lib/supabase');
const { callGemini, MODELS } = require('./ai-router');

const DAILY_REPLY_CAP = 10;
const MIN_LIKES = 100;
const MIN_DELAY_MS = 5 * 60 * 1000;   // 5 minutes
const MAX_DELAY_MS = 30 * 60 * 1000;  // 30 minutes

// Twitter user IDs for monitored accounts
// Resolved via Twitter API v2 users/by endpoint
const MONITORED_ACCOUNTS = [
  { handle: 'DaveHcontrarian', id: '1135564190' },
  { handle: 'PeterSchiff', id: '20aborede' },
  { handle: 'KingWorldNews', id: '380aborede' },
  { handle: 'silverguru22', id: '24011boreda' },
  { handle: 'GoldTelegraph_', id: '96248boreda' },
  { handle: 'WallStreetSilv', id: '136707boreda' },
  { handle: 'RobertKiyosaki', id: '24180boreda' },
  { handle: 'KeithNeumeyer', id: '27437boreda' },
  { handle: 'SchiffGold', id: '24696boreda' },
  { handle: 'MilesFranklinCo', id: '54247boreda' },
];

// We'll resolve real IDs on first run since we can't call the API at build time
let _resolvedAccounts = null;

async function resolveAccountIds() {
  if (_resolvedAccounts) return _resolvedAccounts;

  // Lazy require to avoid circular dependency
  const { getClient } = require('./auto-tweet');
  const client = getClient();
  if (!client) return [];

  try {
    const handles = MONITORED_ACCOUNTS.map(a => a.handle);
    const { data } = await client.v2.usersByUsernames(handles, { 'user.fields': 'id,username' });

    if (data?.length) {
      _resolvedAccounts = data.map(u => ({ handle: u.username, id: u.id }));
      console.log(`[AutoReply] Resolved ${_resolvedAccounts.length} account IDs`);
      return _resolvedAccounts;
    }
  } catch (err) {
    console.log(`[AutoReply] ID resolution failed: ${err.message}`);
  }

  return [];
}

const REPLY_SYSTEM_PROMPT = `You are Troy, a sharp precious metals analyst replying to a tweet. Write a reply that adds value — a specific data point, historical parallel, or purchasing power insight the original tweet didn't mention. Your reply should make people want to click your profile.

RULES:
- 200 characters max
- Add a specific number or data point the original missed
- No self-promotion, no links, no "check out my app"
- No emojis, no exclamation points
- Dry humor welcome
- Never disagree with sound money advocates — build on their point
- Do NOT wrap in quotes
- Return ONLY the reply text`;

function sanitizeReply(raw) {
  if (!raw) return null;
  let text = raw.trim();
  text = text.replace(/^["']|["']$/g, '');
  text = text.replace(/^(SILENT THOUGHT|THOUGHT|THINKING|REASONING|NOTE|INTERNAL)[:\s].*$/gmi, '').trim();
  const lines = text.split('\n').filter(l => l.trim() && !l.match(/^(SILENT|THOUGHT|THINKING|REASONING|NOTE|INTERNAL)/i));
  text = lines.join(' ').trim();
  text = text.replace(/(?<!\w)"(?!\w)/g, '').replace(/(?<!\w)'(?!\w)/g, '').trim();
  text = text.replace(/\s{2,}/g, ' ');
  return text || null;
}

async function checkForReplyOpportunities() {
  // Lazy require to avoid circular dependency
  const { getClient } = require('./auto-tweet');
  const client = getClient();
  if (!client) {
    console.log('[AutoReply] X credentials not configured, skipping');
    return { replied: 0 };
  }

  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

  // Check daily cap
  const capKey = `reply_count_${today}`;
  const { data: capData } = await supabase.from('app_state').select('value').eq('key', capKey).single();
  const dailyCount = capData ? parseInt(capData.value) : 0;
  if (dailyCount >= DAILY_REPLY_CAP) {
    console.log(`[AutoReply] Daily cap reached (${dailyCount}/${DAILY_REPLY_CAP})`);
    return { replied: 0 };
  }

  const accounts = await resolveAccountIds();
  if (!accounts.length) {
    console.log('[AutoReply] No accounts resolved, skipping');
    return { replied: 0 };
  }

  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
  let replied = 0;

  for (const account of accounts) {
    if (dailyCount + replied >= DAILY_REPLY_CAP) break;

    // Per-account cap: 1 reply per 24h
    const accountCapKey = `replied_account_${account.handle}_${today}`;
    const { data: accountCap } = await supabase.from('app_state').select('value').eq('key', accountCapKey).single();
    if (accountCap) continue;

    try {
      const timeline = await client.v2.userTimeline(account.id, {
        max_results: 10,
        start_time: twoHoursAgo.toISOString(),
        'tweet.fields': 'created_at,public_metrics',
        exclude: 'retweets,replies',
      });

      for (const tweet of (timeline.data?.data || [])) {
        if (dailyCount + replied >= DAILY_REPLY_CAP) break;

        const likes = tweet.public_metrics?.like_count || 0;
        if (likes < MIN_LIKES) continue;

        // Dedup by tweet ID
        const dedupKey = `replied_tweet_${tweet.id}`;
        const { data: existing } = await supabase.from('app_state').select('value').eq('key', dedupKey).single();
        if (existing) continue;

        // Generate reply
        let replyText;
        try {
          const raw = await callGemini(MODELS.flash, REPLY_SYSTEM_PROMPT,
            `Reply to this tweet by @${account.handle}:\n\n${tweet.text}`,
            { temperature: 0.9, maxOutputTokens: 256 });
          replyText = sanitizeReply(raw);
        } catch (geminiErr) {
          console.log(`[AutoReply] Gemini failed for @${account.handle}: ${geminiErr.message}`);
          continue;
        }

        if (!replyText || replyText.length < 10) {
          console.log(`[AutoReply] Generated reply too short, skipping`);
          continue;
        }

        // Trim to 280 chars
        if (replyText.length > 280) {
          replyText = replyText.substring(0, 277) + '...';
        }

        // Post reply with random delay (5-30 minutes)
        const delay = MIN_DELAY_MS + Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS);
        const delayMin = Math.round(delay / 60000);

        console.log(`[AutoReply] Scheduling reply to @${account.handle} (${likes} likes) in ${delayMin}m: "${replyText.substring(0, 60)}..."`);

        // Schedule the delayed reply
        const tweetId = tweet.id;
        const handle = account.handle;
        setTimeout(async () => {
          try {
            await client.v2.reply(replyText, tweetId);
            console.log(`[AutoReply] Replied to @${handle} tweet ${tweetId}`);

            // Record dedup
            await supabase.from('app_state').upsert({ key: dedupKey, value: new Date().toISOString() }, { onConflict: 'key' });

            // Record per-account cap
            await supabase.from('app_state').upsert({ key: accountCapKey, value: tweetId }, { onConflict: 'key' });

            // Increment daily cap
            const { data: latestCap } = await supabase.from('app_state').select('value').eq('key', capKey).single();
            const currentCount = latestCap ? parseInt(latestCap.value) : 0;
            await supabase.from('app_state').upsert({ key: capKey, value: String(currentCount + 1) }, { onConflict: 'key' });
          } catch (postErr) {
            console.error(`[AutoReply] Failed to post reply to @${handle}: ${postErr.message}`);
          }
        }, delay);

        replied++;
        break; // One reply per account per cycle
      }

      // Rate limit between accounts
      await new Promise(r => setTimeout(r, 1000));
    } catch (accErr) {
      console.error(`[AutoReply] Error for @${account.handle}: ${accErr.message}`);
    }
  }

  console.log(`[AutoReply] Scheduled ${replied} replies (daily total: ${dailyCount + replied}/${DAILY_REPLY_CAP})`);
  return { replied };
}

module.exports = { checkForReplyOpportunities };
