const supabase = require('../../../lib/supabase');
const { defineCheck } = require('../define-check');

module.exports = [
  defineCheck({
    id: 'price_fetcher_freshness',
    category: 'prices',
    label: 'Price Fetcher Freshness',
    async run() {
      const { data, error } = await supabase
        .from('price_log')
        .select('timestamp, gold_price, silver_price')
        .order('timestamp', { ascending: false })
        .limit(1);
      if (error) return { status: 'red', details: `price_log query error: ${error.message}` };
      if (!data || !data.length) return { status: 'red', details: 'no rows in price_log' };
      const row = data[0];
      const ageSec = Math.round((Date.now() - new Date(row.timestamp).getTime()) / 1000);
      const { areMarketsClosed } = require('../../../services/price-fetcher');
      const marketsClosed = areMarketsClosed();
      // When markets are closed, price_log is legitimately stale — the last write
      // is the final tick before Friday 5pm ET close. Max possible gap ~49h (full weekend).
      const greenCap = marketsClosed ? 4 * 3600 : 120;
      const yellowCap = marketsClosed ? 52 * 3600 : 300;
      const status = ageSec < greenCap ? 'green' : ageSec < yellowCap ? 'yellow' : 'red';
      return {
        status,
        details: `Last write ${ageSec}s ago${marketsClosed ? ' (markets closed)' : ''}`,
        metric: { value: row.gold_price, unit: 'USD/oz', label: 'Gold spot' },
      };
    },
  }),

  defineCheck({
    id: 'price_source_is_yahoo',
    category: 'prices',
    label: 'Active Price Source',
    async run() {
      const { getSpotPrices } = require('../../../services/price-fetcher');
      const result = await getSpotPrices();
      const rawSource = result && result.source ? String(result.source) : '';
      const primary = rawSource.split(' ')[0];
      let status = 'red';
      if (primary === 'yahoo_finance') status = 'green';
      else if (primary === 'metalpriceapi') status = 'yellow';
      return {
        status,
        details: `Source: ${rawSource || 'unknown'}`,
        metric: { value: primary || 'unknown', unit: '', label: 'Active source' },
      };
    },
  }),

  defineCheck({
    id: 'composite_divergence',
    category: 'prices',
    label: 'Composite Price Divergence',
    async run() {
      const { getCompositePrice } = require('../../../services/price-consensus');
      const c = await getCompositePrice();
      if (!c) return { status: 'red', details: 'No composite price available' };
      const goldPct = (c.details && c.details.gold && c.details.gold.spread_pct) || 0;
      const silverPct = (c.details && c.details.silver && c.details.silver.spread_pct) || 0;
      const maxPct = Math.max(goldPct, silverPct);
      const status = maxPct < 0.5 ? 'green' : maxPct < 1.0 ? 'yellow' : 'red';
      return {
        status,
        details: `Gold spread ${goldPct}%, Silver spread ${silverPct}%`,
        metric: { value: Number(maxPct.toFixed(2)), unit: '%', label: 'Max divergence' },
      };
    },
  }),
];
