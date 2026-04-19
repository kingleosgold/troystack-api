const supabase = require('../../../lib/supabase');
const { defineCheck } = require('../define-check');

// Only crons that write an app_state heartbeat key are checked directly here.
// Other crons are observed indirectly via output-freshness checks (e.g.
// price_fetcher → price_fetcher_freshness; stack_signal → articles_24h_volume;
// tweet_queue → tweet_queue_processing; intel_twitter → intelligence_twitter_freshness).
const EXPECTED_CRONS = [
  { name: 'daily_brief', maxAgeH: 25 },
];

module.exports = [
  defineCheck({
    id: 'cron_heartbeats',
    category: 'crons',
    label: 'Cron Heartbeats',
    async run() {
      const today = new Date().toISOString().split('T')[0];
      const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
      const { data, error } = await supabase.from('app_state')
        .select('key,value')
        .or(`key.like.%_cron_fire_${today},key.like.%_cron_fire_${yesterday}`);
      if (error) return { status: 'red', details: `app_state query error: ${error.message}` };

      const latest = {};
      for (const row of data || []) {
        const m = row.key.match(/^(.+)_cron_fire_(\d{4}-\d{2}-\d{2})$/);
        if (!m) continue;
        const name = m[1];
        let v = row.value;
        if (typeof v === 'string') { try { v = JSON.parse(v); } catch { v = {}; } }
        const fired = v && v.last_fired;
        if (!fired) continue;
        if (!latest[name] || fired > latest[name].last_fired) {
          latest[name] = { last_fired: fired, count: (v && v.count) || 0 };
        }
      }

      const statuses = EXPECTED_CRONS.map(expected => {
        const info = latest[expected.name];
        if (!info) return { name: expected.name, st: 'red', detail: 'no heartbeat in last 48h' };
        const ageH = (Date.now() - new Date(info.last_fired).getTime()) / 3600000;
        if (ageH > expected.maxAgeH * 2) return { name: expected.name, st: 'red', detail: `${ageH.toFixed(1)}h ago` };
        if (ageH > expected.maxAgeH) return { name: expected.name, st: 'yellow', detail: `${ageH.toFixed(1)}h ago (late)` };
        return { name: expected.name, st: 'green', detail: `${ageH.toFixed(1)}h ago, count=${info.count}` };
      });

      const rank = { green: 0, yellow: 1, red: 2 };
      const overall = statuses.reduce((acc, s) => rank[s.st] > rank[acc] ? s.st : acc, 'green');
      const nonGreen = statuses.filter(s => s.st !== 'green').map(s => `${s.name}:${s.st}(${s.detail})`).join(', ');
      const summary = statuses.map(s => `${s.name}:${s.st}`).join(', ');

      return {
        status: overall,
        details: nonGreen
          ? `${nonGreen}. Heartbeat-instrumented: ${summary}`
          : `All instrumented crons healthy: ${summary}. (Other crons observed via output freshness.)`,
      };
    },
  }),
];
