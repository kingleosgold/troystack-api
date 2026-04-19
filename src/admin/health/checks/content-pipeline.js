const supabase = require('../../../lib/supabase');
const { defineCheck } = require('../define-check');
const { RSS_FEEDS } = require('../../../services/rss-fetcher');

function last24h() {
  return new Date(Date.now() - 24 * 3600 * 1000).toISOString();
}

module.exports = [
  defineCheck({
    id: 'articles_24h_volume',
    category: 'content_pipeline',
    label: 'Articles Saved (24h)',
    async run() {
      const { count, error } = await supabase
        .from('stack_signal_articles')
        .select('*', { count: 'exact', head: true })
        .gte('created_at', last24h());
      if (error) return { status: 'red', details: error.message };
      const n = count || 0;
      const status = n >= 5 ? 'green' : n >= 1 ? 'yellow' : 'red';
      return {
        status,
        details: `${n} articles in last 24h`,
        metric: { value: n, unit: 'articles', label: 'Last 24h' },
      };
    },
  }),

  defineCheck({
    id: 'signal_score_range',
    category: 'content_pipeline',
    label: 'Signal Score Range',
    async run() {
      const { data, error } = await supabase
        .from('stack_signal_articles')
        .select('signal_score')
        .gte('created_at', last24h());
      if (error) return { status: 'red', details: error.message };
      if (!data || !data.length) {
        return { status: 'yellow', details: 'No articles in last 24h' };
      }
      const scores = data.map(r => r.signal_score).filter(n => typeof n === 'number');
      if (!scores.length) return { status: 'red', details: 'all signal_score values NULL' };
      const min = Math.min(...scores);
      const max = Math.max(...scores);
      const avg = scores.reduce((s, x) => s + x, 0) / scores.length;
      let status, details;
      if (max > min) {
        status = 'green';
        details = `range ${min}-${max}, avg ${avg.toFixed(1)}, n=${scores.length}`;
      } else if (scores.length < 3) {
        status = 'yellow';
        details = `flat at ${min}, only ${scores.length} samples`;
      } else {
        status = 'red';
        details = `flat at ${min} across ${scores.length} articles — scoring regressed`;
      }
      return {
        status,
        details,
        metric: { value: Number(avg.toFixed(1)), unit: '', label: 'Avg signal score' },
      };
    },
  }),

  defineCheck({
    id: 'image_url_coverage',
    category: 'content_pipeline',
    label: 'Article Image Coverage',
    async run() {
      const { data, error } = await supabase
        .from('stack_signal_articles')
        .select('image_url')
        .gte('created_at', last24h());
      if (error) return { status: 'red', details: error.message };
      const total = (data || []).length;
      if (total === 0) {
        return {
          status: 'red',
          details: 'No articles in last 24h',
          metric: { value: 0, unit: '/0', label: 'With images' },
        };
      }
      const missing = data.filter(r => !r.image_url).length;
      const ratio = missing / total;
      const status = ratio < 0.1 ? 'green' : ratio < 0.3 ? 'yellow' : 'red';
      return {
        status,
        details: `${total - missing}/${total} have images (${missing} missing)`,
        metric: { value: total - missing, unit: `/${total}`, label: 'With images' },
      };
    },
  }),

  defineCheck({
    id: 'rss_feed_count_healthy',
    category: 'content_pipeline',
    label: 'RSS Feed Count',
    async run() {
      const count = Array.isArray(RSS_FEEDS) ? RSS_FEEDS.length : 0;
      let status;
      if (count === 41) status = 'green';
      else if ((count >= 35 && count <= 40) || (count >= 42 && count <= 45)) status = 'yellow';
      else status = 'red';
      return {
        status,
        details: `${count} feeds registered in rss-fetcher.js`,
        metric: { value: count, unit: 'feeds', label: 'Active RSS feeds' },
      };
    },
  }),
];
