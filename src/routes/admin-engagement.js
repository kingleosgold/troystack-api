// GET /v1/admin/engagement — read-only stack engagement analytics for the
// admin dashboard. Sits alongside admin-health.js under /v1/admin and reuses
// the same ADMIN_AUTH_KEY header auth (imported from admin-health).
//
// Design notes:
//   - 60s in-memory cache per endpoint path. Cold hits run ~6 Supabase
//     queries in parallel; warm hits return immediately with
//     cache_age_seconds > 0.
//   - All timestamps are bucketed in America/New_York to match the rest of
//     the app (voice_usage counters, daily tweet caps, etc.).
//   - Schema gaps are first-class: every top_stats entry has
//     available:true|false; gapped blocks include gap_reason so the
//     frontend can render a "requires instrumentation" note on that card.
//   - All users counted. No filter on jon/marianna/gio.

const express = require('express');
const supabase = require('../lib/supabase');
const { adminAuth } = require('./admin-health');

const router = express.Router();

const TZ = 'America/New_York';
const CACHE_TTL_MS = 60_000;
const cache = new Map(); // key → { value, storedAt }

function nyDateStr(date = new Date()) {
  // YYYY-MM-DD in America/New_York. en-CA locale gives ISO-style output.
  return date.toLocaleDateString('en-CA', { timeZone: TZ });
}

function nyStartOfDayISO(dateStr) {
  // Given YYYY-MM-DD in NY, return the UTC ISO timestamp for its 00:00:00.
  // NY is UTC-5 (EST) or UTC-4 (EDT). We infer the offset by constructing
  // the same wall-clock time in both and picking whichever localizes back.
  // For our use (date-bucketing) a simple approach is good enough: build a
  // Date assumed to be in NY, convert to UTC by subtracting the current
  // offset. Supabase comparisons use timestamptz, so UTC is the right
  // reference.
  // Reliable trick: round-trip through Intl to find the offset for this date.
  const probe = new Date(`${dateStr}T12:00:00Z`);
  const nyParts = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ,
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit',
  }).formatToParts(probe);
  const nyHour = parseInt(nyParts.find(p => p.type === 'hour').value, 10);
  const offsetHours = 12 - nyHour; // UTC noon → NY hour difference
  const start = new Date(`${dateStr}T00:00:00Z`);
  start.setUTCHours(start.getUTCHours() + offsetHours);
  return start.toISOString();
}

function dateArray(daysBack) {
  // Last `daysBack` days ending today, oldest first. YYYY-MM-DD in NY.
  const today = new Date();
  const out = [];
  for (let i = daysBack - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - i);
    out.push(nyDateStr(d));
  }
  return out;
}

function bucketCountsByDate(rows, createdAtField, dates) {
  // Returns { 'YYYY-MM-DD': count } for each date in `dates`, 0-filled.
  const counts = Object.fromEntries(dates.map(d => [d, 0]));
  for (const r of rows) {
    const ts = r[createdAtField];
    if (!ts) continue;
    const d = nyDateStr(new Date(ts));
    if (d in counts) counts[d] += 1;
  }
  return counts;
}

function bucketDistinctByDate(rows, createdAtField, keyField, dates) {
  // Returns { 'YYYY-MM-DD': number_of_distinct_keyField_values }.
  const sets = Object.fromEntries(dates.map(d => [d, new Set()]));
  for (const r of rows) {
    const ts = r[createdAtField];
    const k = r[keyField];
    if (!ts || !k) continue;
    const d = nyDateStr(new Date(ts));
    if (d in sets) sets[d].add(k);
  }
  return Object.fromEntries(Object.entries(sets).map(([d, s]) => [d, s.size]));
}

function parseVoiceUsageKey(key) {
  // Key shape: voice_usage_{userId}_{YYYY-MM-DD}. The userId is a UUID (36
  // chars with dashes), so splitting by '_' is safe because both the userId
  // and the date contain no underscores.
  if (!key || !key.startsWith('voice_usage_')) return null;
  const rest = key.slice('voice_usage_'.length);
  const lastUnderscore = rest.lastIndexOf('_');
  if (lastUnderscore === -1) return null;
  return {
    userId: rest.slice(0, lastUnderscore),
    date: rest.slice(lastUnderscore + 1),
  };
}

async function buildEngagement() {
  const queryStart = Date.now();
  const today = nyDateStr();
  const dates7 = dateArray(7);
  const dates30 = dateArray(30);
  const cutoff7 = nyStartOfDayISO(dates7[0]);
  const cutoff30 = nyStartOfDayISO(dates30[0]);
  const queryTimings = {};

  // ---------------------------------------------------------------------
  // Fetch in parallel. Each block swallows its own error and marks the
  // affected metric unavailable rather than failing the whole endpoint.
  // ---------------------------------------------------------------------

  const timers = {};
  const time = async (name, promise) => {
    const t0 = Date.now();
    const r = await promise;
    timers[name] = Date.now() - t0;
    queryTimings[name] = timers[name];
    return r;
  };

  const [
    conversations30,
    userMessages30,
    voiceUsageRows,
    articleViews7,
    allConversations7,
  ] = await Promise.all([
    time('conversations_30d', supabase
      .from('troy_conversations')
      .select('id, user_id, updated_at, created_at')
      .gte('updated_at', cutoff30)
      .limit(50000)),
    time('messages_30d', supabase
      .from('troy_messages')
      .select('conversation_id, role, created_at')
      .eq('role', 'user')
      .gte('created_at', cutoff30)
      .limit(50000)),
    time('voice_usage_all', supabase
      .from('app_state')
      .select('key, value')
      .like('key', 'voice_usage_%')
      .limit(50000)),
    time('article_views_7d', supabase
      .from('article_views')
      .select('id, created_at')
      .gte('created_at', cutoff7)
      .limit(50000)),
    // Separate small query for power users so we can rank by 7d activity
    // without reprocessing the 30d set.
    time('conversations_7d', supabase
      .from('troy_conversations')
      .select('user_id, updated_at')
      .gte('updated_at', cutoff7)
      .limit(10000)),
  ]);

  // ---------------------------------------------------------------------
  // Normalize: convert Supabase responses to rows-or-null.
  // ---------------------------------------------------------------------
  const convRows30 = conversations30.error ? null : (conversations30.data || []);
  const msgRows30 = userMessages30.error ? null : (userMessages30.data || []);
  const voiceRows = voiceUsageRows.error ? null : (voiceUsageRows.data || []);
  const articleRows7 = articleViews7.error ? null : (articleViews7.data || []);
  const convRows7 = allConversations7.error ? null : (allConversations7.data || []);

  // Conversation id → user id lookup (needed to attribute messages to users)
  const convUser = new Map();
  if (convRows30) for (const c of convRows30) convUser.set(c.id, c.user_id);

  // Enrich message rows with user_id via lookup.
  const msgWithUser = (msgRows30 || []).map(m => ({
    ...m, user_id: convUser.get(m.conversation_id) || null,
  })).filter(m => m.user_id);

  // ---------------------------------------------------------------------
  // Top stats (today + 7d sparkline)
  // ---------------------------------------------------------------------

  // active_users_today: distinct users with a conversation updated today
  let activeUsersBlock;
  if (convRows7) {
    const perDay = bucketDistinctByDate(convRows7, 'updated_at', 'user_id', dates7);
    activeUsersBlock = {
      value: perDay[today] || 0,
      sparkline_7d: dates7.map(d => perDay[d] || 0),
      available: true,
    };
  } else {
    activeUsersBlock = {
      value: null, sparkline_7d: [], available: false,
      gap_reason: `troy_conversations query failed: ${allConversations7.error?.message || 'unknown'}`,
    };
  }

  // troy_messages_today: user messages today (7d sparkline too)
  let messagesBlock;
  if (msgRows30) {
    const perDay = bucketCountsByDate(msgRows30, 'created_at', dates7);
    messagesBlock = {
      value: perDay[today] || 0,
      sparkline_7d: dates7.map(d => perDay[d] || 0),
      available: true,
    };
  } else {
    messagesBlock = {
      value: null, sparkline_7d: [], available: false,
      gap_reason: `troy_messages query failed: ${userMessages30.error?.message || 'unknown'}`,
    };
  }

  // voice_plays_today: sum of voice_usage_{user}_{date} values. Proxy — this
  // counter increments on both /speak and /transcribe, so it over-counts true
  // "plays". Still the only voice signal we have until a dedicated column
  // lands on troy_messages.
  let voiceBlock;
  if (voiceRows) {
    const perDay = Object.fromEntries(dates7.map(d => [d, 0]));
    for (const r of voiceRows) {
      const parsed = parseVoiceUsageKey(r.key);
      if (!parsed) continue;
      if (parsed.date in perDay) perDay[parsed.date] += parseInt(r.value, 10) || 0;
    }
    voiceBlock = {
      value: perDay[today] || 0,
      sparkline_7d: dates7.map(d => perDay[d] || 0),
      available: true,
    };
  } else {
    voiceBlock = {
      value: null, sparkline_7d: [], available: false,
      gap_reason: `app_state voice_usage query failed: ${voiceUsageRows.error?.message || 'unknown'}`,
    };
  }

  // signal_reads_today: article_views inserts today
  let signalReadsBlock;
  if (articleRows7) {
    const perDay = bucketCountsByDate(articleRows7, 'created_at', dates7);
    signalReadsBlock = {
      value: perDay[today] || 0,
      sparkline_7d: dates7.map(d => perDay[d] || 0),
      available: true,
    };
  } else {
    signalReadsBlock = {
      value: null, sparkline_7d: [], available: false,
      gap_reason: `article_views query failed: ${articleViews7.error?.message || 'unknown'}`,
    };
  }

  // ---------------------------------------------------------------------
  // 30-day feature_usage matrix (one row per day)
  // ---------------------------------------------------------------------
  const messages30PerDay = msgRows30
    ? bucketCountsByDate(msgRows30, 'created_at', dates30)
    : null;

  const voice30PerDay = voiceRows
    ? (() => {
        const per = Object.fromEntries(dates30.map(d => [d, 0]));
        for (const r of voiceRows) {
          const parsed = parseVoiceUsageKey(r.key);
          if (!parsed) continue;
          if (parsed.date in per) per[parsed.date] += parseInt(r.value, 10) || 0;
        }
        return per;
      })()
    : null;

  const feature_usage_30d = dates30.map(date => ({
    date,
    troy_messages: messages30PerDay ? messages30PerDay[date] : null,
    voice_plays: voice30PerDay ? voice30PerDay[date] : null,
    push_opens: null,   // no push-open tracking in schema — see gaps list
    stack_edits: null,  // holdings has inserts/deletes but no edit-event log
  }));

  // ---------------------------------------------------------------------
  // Gapped metrics (documented at the endpoint)
  // ---------------------------------------------------------------------
  const top_troy_topics_7d = {
    available: false,
    gap_reason: 'No topic/intent column on troy_messages or troy_conversations — requires an "intent" field populated at message write time (or an async classification job).',
  };

  // ---------------------------------------------------------------------
  // voice_text_ratio_7d: voice_count / (voice_count + text_count) over 7d
  // ---------------------------------------------------------------------
  let voiceTextRatioBlock;
  if (voiceRows && msgRows30) {
    let voiceCount = 0;
    const dateSet = new Set(dates7);
    for (const r of voiceRows) {
      const parsed = parseVoiceUsageKey(r.key);
      if (!parsed) continue;
      if (dateSet.has(parsed.date)) voiceCount += parseInt(r.value, 10) || 0;
    }
    let textCount = 0;
    for (const m of msgRows30) {
      const d = nyDateStr(new Date(m.created_at));
      if (dateSet.has(d)) textCount += 1;
    }
    const total = voiceCount + textCount;
    voiceTextRatioBlock = {
      voice_count: voiceCount,
      text_count: textCount,
      ratio: total > 0 ? parseFloat((voiceCount / total).toFixed(4)) : 0,
      available: true,
    };
  } else {
    voiceTextRatioBlock = {
      voice_count: null, text_count: null, ratio: null, available: false,
      gap_reason: 'voice_usage or troy_messages query failed',
    };
  }

  // ---------------------------------------------------------------------
  // power_users_7d: top users by conversations touched in last 7 days
  // ---------------------------------------------------------------------
  let powerUsersBlock = [];
  if (convRows7) {
    const perUser = new Map(); // user_id → { count, lastActive }
    for (const c of convRows7) {
      if (!c.user_id) continue;
      const cur = perUser.get(c.user_id) || { count: 0, lastActive: null };
      cur.count += 1;
      if (!cur.lastActive || c.updated_at > cur.lastActive) cur.lastActive = c.updated_at;
      perUser.set(c.user_id, cur);
    }
    const topUsers = [...perUser.entries()]
      .sort(([, a], [, b]) => b.count - a.count)
      .slice(0, 10);

    // Hydrate tier from profiles (one query) + email from auth.users (parallel).
    const userIds = topUsers.map(([uid]) => uid);
    const tierTimerStart = Date.now();
    const { data: profileRows } = await supabase
      .from('profiles')
      .select('id, subscription_tier')
      .in('id', userIds);
    queryTimings.profiles_tier_lookup = Date.now() - tierTimerStart;
    const tierMap = new Map((profileRows || []).map(p => [p.id, p.subscription_tier || 'free']));

    const emailTimerStart = Date.now();
    const emailResults = await Promise.all(userIds.map(uid =>
      supabase.auth.admin.getUserById(uid).then(r => [uid, r.data?.user?.email || null]).catch(() => [uid, null])
    ));
    queryTimings.auth_email_lookup = Date.now() - emailTimerStart;
    const emailMap = new Map(emailResults);

    powerUsersBlock = topUsers.map(([uid, v]) => ({
      user_id: uid,
      email: emailMap.get(uid),
      tier: tierMap.get(uid) || 'free',
      conversations_count: v.count,
      last_active: v.lastActive,
    }));
  }

  const totalMs = Date.now() - queryStart;

  return {
    generated_at: new Date().toISOString(),
    cache_age_seconds: 0,
    top_stats: {
      active_users_today: activeUsersBlock,
      troy_messages_today: messagesBlock,
      voice_plays_today: voiceBlock,
      signal_reads_today: signalReadsBlock,
    },
    feature_usage_30d,
    top_troy_topics_7d,
    voice_text_ratio_7d: voiceTextRatioBlock,
    power_users_7d: powerUsersBlock,
    _meta: {
      total_ms: totalMs,
      query_timings_ms: queryTimings,
    },
  };
}

router.get('/engagement', adminAuth, async (req, res) => {
  try {
    const cacheKey = 'engagement';
    const hit = cache.get(cacheKey);
    const now = Date.now();
    if (hit && now - hit.storedAt < CACHE_TTL_MS) {
      return res.json({
        ...hit.value,
        cache_age_seconds: Math.floor((now - hit.storedAt) / 1000),
      });
    }

    const payload = await buildEngagement();
    cache.set(cacheKey, { value: payload, storedAt: now });
    res.json(payload);
  } catch (err) {
    console.error('[AdminEngagement] /engagement failed:', err.message, err.stack);
    res.status(500).json({ error: 'engagement query failed', message: err.message });
  }
});

module.exports = router;
