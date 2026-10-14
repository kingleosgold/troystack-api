const express = require('express');

// Account routes that Google Play's review asks for.
//
// POST /v1/troy/report keeps a report someone files on one of Troy's replies,
// for a person to review. Play's AI-generated content policy wants a way to
// report a reply from inside the app. Anyone can file one, signed in or not.
//
// DELETE /v1/account deletes the signed-in account and everything kept for
// it. Play's Data safety form wants account deletion inside the app and on
// the web. The session token says whose account it is, never the body.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REPORT_CONTENT_MAX = 4000;
const REPORT_REASON_MAX = 500;

// A table some databases built from older files don't have. Deletion goes
// on past it, since there's nothing in it to delete.
const MISSING_TABLE_CODES = new Set(['42P01', 'PGRST205']);

// Every table with rows keyed by the account's id, and the column that holds
// it. troy_messages goes first through its conversations, and profiles and
// the sign-in itself go last, so a deletion that stops partway can be asked
// again and finish.
const USER_TABLES = [
  ['troy_conversations', 'user_id'],
  ['troy_question_usage', 'user_id'],
  ['daily_briefs', 'user_id'],
  ['push_tokens', 'user_id'],
  ['notification_preferences', 'user_id'],
  ['price_alerts', 'user_id'],
  ['notification_log', 'user_id'],
  ['portfolio_snapshots', 'user_id'],
  ['scan_usage', 'user_id'],
  ['api_keys', 'user_id'],
  ['article_likes', 'user_id'],
  ['article_comments', 'user_id'],
  ['article_views', 'user_id'],
  ['affiliate_clicks', 'user_id'],
  ['holdings', 'user_id'],
];

// app_state rows that carry the account's id in their key.
function appStatePrefixes(userId) {
  return [`daily_brief_lock_${userId}_`, `daily_push_${userId}_`, `voice_usage_${userId}_`];
}
function appStateKeys(userId) {
  return [`revenuecat_grant:${userId}`, `revenuecat_turn:${userId}`, `checkout_turn:${userId}`];
}

// A Stripe plan that will charge again. Deleting the account wouldn't stop
// Stripe billing the card, so the plan is cancelled first.
const LIVE_STRIPE_STATUSES = new Set(['active', 'trialing', 'past_due', 'unpaid']);

function cleanText(value, max) {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, max);
}

function optionalId(value) {
  if (value === undefined || value === null || value === '') return { ok: true, id: null };
  if (typeof value === 'string' && UUID_RE.test(value)) return { ok: true, id: value };
  return { ok: false };
}

async function signedInUser(supabase, req) {
  const header = req.headers?.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) return null;
  try {
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data?.user?.id) return null;
    return data.user;
  } catch (err) {
    console.error('[Account] Session check failed:', err.message);
    return null;
  }
}

function failed(error) {
  return error && !MISSING_TABLE_CODES.has(error.code);
}

function createTroyReportHandler({ supabase }) {
  return async (req, res) => {
    const body = req.body || {};
    const content = cleanText(body.content, REPORT_CONTENT_MAX);
    const reason = cleanText(body.reason, REPORT_REASON_MAX);
    if (!content || !reason) {
      return res.status(400).json({ error: 'reason and content are required' });
    }
    const user = optionalId(body.userId);
    const conversation = optionalId(body.conversationId);
    const message = optionalId(body.messageId);
    if (!user.ok || !conversation.ok || !message.ok) {
      return res.status(400).json({ error: 'userId, conversationId and messageId must be ids when sent' });
    }
    try {
      const { data, error } = await supabase
        .from('troy_reports')
        .insert({
          user_id: user.id,
          conversation_id: conversation.id,
          message_id: message.id,
          reason,
          content,
        })
        .select('id')
        .single();
      if (error) throw new Error(error.message);
      return res.status(201).json({ id: data?.id ?? null });
    } catch (err) {
      console.error('[Troy Report] Could not keep a report:', err.message);
      return res.status(500).json({ error: 'The report could not be saved. Email support@troystack.com instead.' });
    }
  };
}

function createAccountRouter({ supabase }) {
  const router = express.Router();

  router.delete('/', async (req, res) => {
    const user = await signedInUser(supabase, req);
    if (!user) return res.status(401).json({ error: 'Sign in to delete your account' });
    const userId = user.id;

    try {
      const { data: profile, error: profileError } = await supabase
        .from('profiles')
        .select('subscription_tier, subscription_status, stripe_customer_id')
        .eq('id', userId)
        .maybeSingle();
      if (failed(profileError)) throw new Error(`profiles: ${profileError.message}`);
      if (profile?.stripe_customer_id && profile.subscription_tier !== 'lifetime'
          && LIVE_STRIPE_STATUSES.has(profile.subscription_status)) {
        return res.status(409).json({
          error: 'stripe_plan_active',
          message: 'Cancel your Gold plan in Settings on troystack.ai first, so your card isn\'t charged again, then delete your account. Or email support@troystack.com and we\'ll do both.',
        });
      }

      const { data: conversations, error: convError } = await supabase
        .from('troy_conversations')
        .select('id')
        .eq('user_id', userId);
      if (failed(convError)) throw new Error(`troy_conversations: ${convError.message}`);
      const conversationIds = (conversations || []).map((c) => c.id);
      if (conversationIds.length) {
        const { error } = await supabase.from('troy_messages').delete().in('conversation_id', conversationIds);
        if (failed(error)) throw new Error(`troy_messages: ${error.message}`);
      }

      for (const [table, column] of USER_TABLES) {
        const { error } = await supabase.from(table).delete().eq(column, userId);
        if (failed(error)) throw new Error(`${table}: ${error.message}`);
      }

      for (const prefix of appStatePrefixes(userId)) {
        const { error } = await supabase.from('app_state').delete().like('key', `${prefix}%`);
        if (failed(error)) throw new Error(`app_state: ${error.message}`);
      }
      const { error: keysError } = await supabase.from('app_state').delete().in('key', appStateKeys(userId));
      if (failed(keysError)) throw new Error(`app_state: ${keysError.message}`);

      // Reports on Troy's replies stay for review, without the account.
      const { error: reportsError } = await supabase.from('troy_reports').update({ user_id: null }).eq('user_id', userId);
      if (failed(reportsError)) throw new Error(`troy_reports: ${reportsError.message}`);

      const { error: profileDeleteError } = await supabase.from('profiles').delete().eq('id', userId);
      if (failed(profileDeleteError)) throw new Error(`profiles: ${profileDeleteError.message}`);

      const { error: authError } = await supabase.auth.admin.deleteUser(userId);
      if (authError) throw new Error(`auth: ${authError.message}`);

      console.log(`[Account] Deleted account ${userId}`);
      return res.json({ deleted: true });
    } catch (err) {
      console.error(`[Account] Deletion stopped for ${userId}:`, err.message);
      return res.status(500).json({ error: 'Your account could not be deleted just now. Try again, or email support@troystack.com.' });
    }
  });

  return router;
}

module.exports = { createAccountRouter, createTroyReportHandler, USER_TABLES, REPORT_CONTENT_MAX };
