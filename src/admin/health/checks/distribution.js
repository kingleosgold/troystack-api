const supabase = require('../../../lib/supabase');
const { defineCheck } = require('../define-check');

function todayET() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

module.exports = [
  defineCheck({
    id: 'tweet_queue_processing',
    category: 'distribution',
    label: 'Tweet Queue Processing',
    async run() {
      const nowIso = new Date().toISOString();
      const dayAgo = new Date(Date.now() - 86400000).toISOString();
      const [overdueResp, postedResp] = await Promise.all([
        supabase.from('tweet_queue')
          .select('*', { count: 'exact', head: true })
          .eq('posted', false).lt('scheduled_for', nowIso),
        supabase.from('tweet_queue')
          .select('*', { count: 'exact', head: true })
          .eq('posted', true).gte('created_at', dayAgo),
      ]);
      if (overdueResp.error) return { status: 'red', details: overdueResp.error.message };
      const overdue = overdueResp.count || 0;
      const posted24h = postedResp.count || 0;
      let status;
      if (overdue === 0) status = 'green';
      else if (overdue <= 3) status = 'yellow';
      else status = 'red';
      return {
        status,
        details: `${overdue} overdue, ${posted24h} posted in 24h`,
        metric: { value: posted24h, unit: 'tweets', label: 'Posted 24h' },
      };
    },
  }),

  defineCheck({
    id: 'tweet_daily_cap_usage',
    category: 'distribution',
    label: 'Tweet Daily Cap',
    async run() {
      const { data } = await supabase.from('app_state')
        .select('value').eq('key', `tweet_count_${todayET()}`).maybeSingle();
      let raw = data && data.value;
      if (raw && typeof raw === 'object') raw = raw.count != null ? raw.count : JSON.stringify(raw);
      const count = parseInt(raw, 10) || 0;
      let status;
      if (count >= 15) status = 'red';
      else if (count >= 12) status = 'yellow';
      else status = 'green';
      return {
        status,
        details: `${count}/15 used today`,
        metric: { value: count, unit: '/15', label: 'Tweets today' },
      };
    },
  }),

  defineCheck({
    id: 'daily_brief_today',
    category: 'distribution',
    label: 'Daily Briefs Today',
    async run() {
      const today = todayET();
      const { data, error } = await supabase.from('daily_briefs')
        .select('brief_text, generated_at').eq('date', today);
      if (error) return { status: 'red', details: error.message };
      const rows = data || [];
      if (rows.length === 0) {
        return {
          status: 'red',
          details: 'No briefs generated today',
          metric: { value: 0, unit: 'briefs', label: 'Sent today' },
        };
      }
      const lens = rows.map(r => (r.brief_text || '').length);
      const minLen = Math.min(...lens);
      const mostRecent = rows.map(r => r.generated_at).sort().slice(-1)[0];
      const status = rows.length >= 10 && minLen >= 500 ? 'green' : 'yellow';
      return {
        status,
        details: `${rows.length} briefs, min_length=${minLen} chars, last_at=${mostRecent}`,
        metric: { value: rows.length, unit: 'briefs', label: 'Sent today' },
      };
    },
  }),

  defineCheck({
    id: 'daily_brief_cron_fired',
    category: 'distribution',
    label: 'Daily Brief Cron Heartbeat',
    async run() {
      // The cron fires once every 24h at 6:35 AM ET. The heartbeat key is
      // stamped with the ET date (see src/index.js daily-brief cron). Between
      // midnight ET and the 6:35 AM fire there's a window when no "today"
      // key exists yet — fall back to yesterday's key if < 25h old.
      const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
      const yesterdayDate = new Date(Date.now() - 86400000);
      const yesterdayET = yesterdayDate.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

      function parse(v) {
        if (!v) return null;
        if (typeof v === 'string') { try { return JSON.parse(v); } catch { return null; } }
        return v;
      }

      function classify(parsed, whichLabel) {
        const count = (parsed && parsed.count) || 0;
        const lastFired = (parsed && parsed.last_fired) || null;
        if (count === 0) return { status: 'red', details: `${whichLabel} heartbeat present but count=0` };
        if (count > 1) return { status: 'yellow', details: `${whichLabel} fired ${count}× — lock issue (${lastFired})` };
        return { status: 'green', details: `${whichLabel} fired 1× at ${lastFired}` };
      }

      const { data: todayRow } = await supabase.from('app_state')
        .select('value').eq('key', `daily_brief_cron_fire_${todayET}`).maybeSingle();
      const todayParsed = parse(todayRow && todayRow.value);
      if (todayParsed) return classify(todayParsed, 'today');

      // Fallback: accept yesterday's key if its last_fired is within 25 h
      const { data: yRow } = await supabase.from('app_state')
        .select('value').eq('key', `daily_brief_cron_fire_${yesterdayET}`).maybeSingle();
      const yParsed = parse(yRow && yRow.value);
      if (yParsed && yParsed.last_fired) {
        const ageH = (Date.now() - new Date(yParsed.last_fired).getTime()) / 3600000;
        if (ageH < 25) {
          const base = classify(yParsed, 'yesterday');
          return { ...base, details: `${base.details} (${ageH.toFixed(1)}h ago; next cron pending)` };
        }
        return { status: 'red', details: `yesterday's heartbeat ${ageH.toFixed(1)}h old, no fresh fire` };
      }

      return { status: 'red', details: `no heartbeat key for ${todayET} or ${yesterdayET}` };
    },
  }),

  defineCheck({
    id: 'push_tokens_active',
    category: 'distribution',
    label: 'Active Push Tokens',
    async run() {
      const cutoff = new Date(Date.now() - 30 * 86400000).toISOString();
      const { count, error } = await supabase.from('push_tokens')
        .select('*', { count: 'exact', head: true }).gte('last_active', cutoff);
      if (error) return { status: 'red', details: `push_tokens query error: ${error.message}` };
      const n = count || 0;
      const status = n >= 10 ? 'green' : n >= 3 ? 'yellow' : 'red';
      return {
        status,
        details: `${n} tokens active in last 30 days`,
        metric: { value: n, unit: 'tokens', label: 'Active 30d' },
      };
    },
  }),
];
