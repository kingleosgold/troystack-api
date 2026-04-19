const supabase = require('../../../lib/supabase');
const { defineCheck } = require('../define-check');

// Per-table staleness caps. `marketSensitive: true` means the cap is multiplied
// during weekend/off-hours when no fresh data is expected (price_log is frozen,
// article/tweet flow slows). Ratio vs cap drives green/yellow/red in the check.
const FRESHNESS = {
  price_log:             { col: 'timestamp',    capSec:   120, marketSensitive: true  },
  stack_signal_articles: { col: 'created_at',   capSec:  3600, marketSensitive: false },
  troy_intelligence:     { col: 'created_at',   capSec: 14400, marketSensitive: false },
  daily_briefs:          { col: 'generated_at', capSec: 86400, marketSensitive: false },
  tweet_queue:           { col: 'created_at',   capSec:  1800, marketSensitive: true  },
};
const CLOSED_MARKET_MULTIPLIER = 60;

module.exports = [
  defineCheck({
    id: 'supabase_connection',
    category: 'database',
    label: 'Supabase Connection',
    async run() {
      const t0 = Date.now();
      const { error } = await supabase.from('app_state')
        .select('key', { head: true, count: 'exact' }).limit(1);
      const ms = Date.now() - t0;
      if (error) return { status: 'red', details: `DB error: ${error.message}`, metric: { value: ms, unit: 'ms' } };
      const status = ms < 100 ? 'green' : ms < 500 ? 'yellow' : 'red';
      return { status, details: `probe ${ms}ms`, metric: { value: ms, unit: 'ms' } };
    },
  }),

  defineCheck({
    id: 'price_log_row_count',
    category: 'database',
    label: 'Price Log Row Count',
    async run() {
      const { count, error } = await supabase.from('price_log').select('*', { count: 'exact', head: true });
      if (error) return { status: 'red', details: error.message };
      const n = count || 0;
      const status = n > 1000 ? 'green' : n > 100 ? 'yellow' : 'red';
      return { status, details: `${n} rows in price_log`, metric: { value: n, unit: 'rows' } };
    },
  }),

  defineCheck({
    id: 'key_tables_write_freshness',
    category: 'database',
    label: 'Key Tables Write Freshness',
    async run() {
      const { areMarketsClosed } = require('../../../services/price-fetcher');
      const marketsClosed = areMarketsClosed();
      const probes = await Promise.all(
        Object.entries(FRESHNESS).map(async ([table, cfg]) => {
          const capSec = marketsClosed && cfg.marketSensitive
            ? cfg.capSec * CLOSED_MARKET_MULTIPLIER
            : cfg.capSec;
          const { data, error } = await supabase
            .from(table).select(cfg.col)
            .order(cfg.col, { ascending: false }).limit(1);
          if (error || !data || !data.length) {
            return { table, ageSec: Infinity, capSec, error: error ? error.message : 'no rows' };
          }
          const ageSec = (Date.now() - new Date(data[0][cfg.col]).getTime()) / 1000;
          return { table, ageSec, capSec };
        }),
      );

      const ranked = probes.map(p => {
        const ratio = p.ageSec / p.capSec;
        let st = 'green';
        if (ratio >= 5) st = 'red';
        else if (ratio >= 2) st = 'yellow';
        return { ...p, ratio, st };
      });

      const rank = { green: 0, yellow: 1, red: 2, unknown: 3 };
      const overall = ranked.reduce((acc, r) => rank[r.st] > rank[acc] ? r.st : acc, 'green');
      const worst = ranked.slice().sort((a, b) => (b.ratio || 0) - (a.ratio || 0))[0];

      const summary = ranked
        .map(r => `${r.table}:${isFinite(r.ageSec) ? Math.round(r.ageSec) + 's' : 'none'}/${r.capSec}s`)
        .join(', ');
      const worstDetail = worst
        ? `worst=${worst.table} ${isFinite(worst.ageSec) ? Math.round(worst.ageSec) + 's' : 'no rows'} (cap ${worst.capSec}s)`
        : 'no probes';

      const closedSuffix = marketsClosed ? ' (markets closed; price_log/tweet_queue caps relaxed ×60)' : '';
      return { status: overall, details: `${worstDetail}. ${summary}${closedSuffix}` };
    },
  }),
];
