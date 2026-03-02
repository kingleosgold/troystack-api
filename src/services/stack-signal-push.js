/**
 * Stack Signal Breaking News Push Service
 *
 * Sends push notifications for high-scoring Stack Signal articles.
 * Only the HIGHEST-scoring article per cron cycle triggers a push.
 * Daily cap: 3 breaking news pushes total (persisted in app_state).
 *
 * Troy Score tiers:
 *   85-89  → Market Alert    (paid users only)
 *   90-94  → Breaking News   (paid users only)
 *   95-100 → Critical Alert  (ALL users including free)
 */

const supabase = require('../lib/supabase');
const { sendBatchPush, isValidExpoPushToken } = require('../routes/push');

const MAX_DAILY_PUSHES = 3;

/**
 * Get today's breaking news push count from app_state (persists across restarts).
 */
async function getBreakingPushCount() {
  const today = new Date().toISOString().split('T')[0];
  try {
    const { data } = await supabase
      .from('app_state')
      .select('value')
      .eq('key', 'breaking_push_count')
      .single();
    if (data?.value?.date === today) return data.value.count || 0;
    return 0; // Different day = reset
  } catch {
    return 0;
  }
}

/**
 * Increment today's breaking news push count in app_state.
 */
async function incrementBreakingPushCount() {
  const today = new Date().toISOString().split('T')[0];
  const current = await getBreakingPushCount();
  await supabase
    .from('app_state')
    .upsert({ key: 'breaking_push_count', value: { date: today, count: current + 1 } });
}

/**
 * Send a push notification for a single Stack Signal article.
 * Called from the pipeline with the top-scoring article only.
 *
 * @param {Object} article - Needs: title, relevance_score, troy_one_liner, troy_commentary, slug
 */
async function maybePushStackSignalAlert(article) {
  const score = article.relevance_score || 0;
  if (score < 85) return;

  // Check daily cap
  const dailyCount = await getBreakingPushCount();
  if (dailyCount >= MAX_DAILY_PUSHES) {
    console.log(`[StackSignalPush] Daily cap reached (${dailyCount}/${MAX_DAILY_PUSHES}), skipping: "${article.title?.slice(0, 50)}"`);
    return;
  }

  // Determine tier
  let tierName, paidOnly;
  if (score >= 95) { tierName = 'critical_alert'; paidOnly = false; }
  else if (score >= 90) { tierName = 'breaking_news'; paidOnly = true; }
  else { tierName = 'market_alert'; paidOnly = true; }

  // Get push tokens
  let tokens;
  if (paidOnly) {
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
    await incrementBreakingPushCount();

    console.log(`[StackSignalPush] ${tierName} sent to ${sent}/${validTokens.length} users (score: ${score}, daily: ${dailyCount + 1}/${MAX_DAILY_PUSHES}, "${article.title?.slice(0, 50)}")`);
  } catch (pushErr) {
    console.error(`[StackSignalPush] ${tierName} batch push failed: ${pushErr.message}`);
  }
}

module.exports = { maybePushStackSignalAlert };
