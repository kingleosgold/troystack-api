/**
 * Stack Signal Breaking News Push Service
 *
 * Sends push notifications for high-scoring Stack Signal articles.
 * Troy Score tiers:
 *   85-89  → Market Alert    (max 2/day, paid users only)
 *   90-94  → Breaking News   (max 4/day, paid users only)
 *   95-100 → Critical Alert  (no cap, ALL users including free)
 */

const supabase = require('../lib/supabase');
const { sendBatchPush, isValidExpoPushToken } = require('../routes/push');

const TIER_CONFIG = {
  market_alert:   { minScore: 85, maxScore: 89, dailyCap: 2,    paidOnly: true  },
  breaking_news:  { minScore: 90, maxScore: 94, dailyCap: 4,    paidOnly: true  },
  critical_alert: { minScore: 95, maxScore: 100, dailyCap: null, paidOnly: false },
};

// In-memory daily cap tracker: { 'YYYY-MM-DD:tier': count }
const dailyCounts = {};

function getTodayKey(tier) {
  const today = new Date().toISOString().split('T')[0];
  return `${today}:${tier}`;
}

function getDailyCount(tier) {
  return dailyCounts[getTodayKey(tier)] || 0;
}

function incrementDailyCount(tier) {
  const key = getTodayKey(tier);
  dailyCounts[key] = (dailyCounts[key] || 0) + 1;
}

/**
 * Check if a saved Stack Signal article should trigger a push notification.
 * Call this after an article is saved to Supabase with its relevance_score.
 *
 * @param {Object} article - The saved article row (needs: id, title, relevance_score, troy_one_liner, troy_commentary)
 */
async function maybePushStackSignalAlert(article) {
  const score = article.relevance_score || 0;

  // Determine tier
  let tierName = null;
  if (score >= 95) tierName = 'critical_alert';
  else if (score >= 90) tierName = 'breaking_news';
  else if (score >= 85) tierName = 'market_alert';
  else return; // Below 85 = no push

  const config = TIER_CONFIG[tierName];

  // Check daily cap (skip for critical)
  if (config.dailyCap !== null) {
    const currentCount = getDailyCount(tierName);
    if (currentCount >= config.dailyCap) {
      console.log(`[StackSignalPush] ${tierName} daily cap reached (${currentCount}/${config.dailyCap}), skipping: "${article.title?.slice(0, 50)}"`);
      return;
    }
  }

  // Get push tokens with user info
  let tokens;

  if (config.paidOnly) {
    // Get paid user IDs (silver, gold, lifetime)
    const { data: paidUsers } = await supabase
      .from('profiles')
      .select('id')
      .in('subscription_tier', ['silver', 'gold', 'lifetime']);

    const paidUserIds = (paidUsers || []).map(u => u.id);
    if (paidUserIds.length === 0) {
      console.log(`[StackSignalPush] ${tierName} — no paid users found, skipping`);
      return;
    }

    const { data } = await supabase
      .from('push_tokens')
      .select('expo_push_token, user_id')
      .in('user_id', paidUserIds)
      .order('last_active', { ascending: false });

    tokens = data;
  } else {
    // Critical alert: ALL users
    const { data } = await supabase
      .from('push_tokens')
      .select('expo_push_token, user_id')
      .order('last_active', { ascending: false });

    tokens = data;
  }

  if (!tokens || tokens.length === 0) {
    console.log(`[StackSignalPush] ${tierName} — no push tokens found`);
    return;
  }

  // Filter out users who disabled this tier's notifications
  // market_alert / breaking_news tiers → check market_alerts pref
  // critical_alert tier → check critical_alerts pref
  const prefColumn = tierName === 'critical_alert' ? 'critical_alerts' : 'market_alerts';
  const { data: disabledPrefs } = await supabase
    .from('notification_preferences')
    .select('user_id')
    .eq(prefColumn, false);

  const disabledUserIds = new Set((disabledPrefs || []).map(p => p.user_id));

  // Deduplicate by user (keep most recent token per user)
  const seenUsers = new Set();
  const validTokens = [];
  for (const t of tokens) {
    if (!isValidExpoPushToken(t.expo_push_token)) continue;
    if (t.user_id && disabledUserIds.has(t.user_id)) continue;
    const key = t.user_id || t.expo_push_token;
    if (seenUsers.has(key)) continue;
    seenUsers.add(key);
    validTokens.push(t.expo_push_token);
  }

  if (validTokens.length === 0) {
    console.log(`[StackSignalPush] ${tierName} — all tokens filtered out (prefs/invalid)`);
    return;
  }

  // Build notification
  const pushTitle = tierName === 'critical_alert'
    ? 'Troy: Critical Alert'
    : tierName === 'breaking_news'
    ? 'Troy: Breaking News'
    : 'Troy: Market Alert';

  const pushBody = article.troy_one_liner
    || article.troy_commentary?.slice(0, 120)
    || article.title;

  try {
    const results = await sendBatchPush(validTokens, {
      title: pushTitle,
      body: pushBody,
      data: {
        type: `stack_signal_${tierName}`,
        articleSlug: article.slug || null,
        screen: 'StackSignal',
      },
      sound: 'default',
    });

    const sent = results.filter(r => r.success).length;
    incrementDailyCount(tierName);

    console.log(`[StackSignalPush] ${tierName} sent to ${sent}/${validTokens.length} users (score: ${score}, "${article.title?.slice(0, 50)}")`);
  } catch (pushErr) {
    console.error(`[StackSignalPush] ${tierName} batch push failed: ${pushErr.message}`);
  }
}

module.exports = { maybePushStackSignalAlert };
