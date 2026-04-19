const supabase = require('../../../lib/supabase');
const { defineCheck } = require('../define-check');

module.exports = [
  defineCheck({
    id: 'intelligence_twitter_freshness',
    category: 'intelligence',
    label: 'Twitter Intelligence Freshness',
    async run() {
      const { data, error } = await supabase.from('troy_intelligence')
        .select('created_at').eq('source_type', 'twitter')
        .order('created_at', { ascending: false }).limit(1);
      if (error) return { status: 'red', details: error.message };
      if (!data || !data.length) return { status: 'red', details: 'no twitter rows ever' };
      const ageH = (Date.now() - new Date(data[0].created_at).getTime()) / 3600000;
      const status = ageH < 4 ? 'green' : ageH < 12 ? 'yellow' : 'red';
      return {
        status,
        details: `Last row ${ageH.toFixed(1)}h ago`,
        metric: { value: Number(ageH.toFixed(1)), unit: 'h', label: 'Twitter freshness' },
      };
    },
  }),

  defineCheck({
    id: 'intelligence_youtube_status',
    category: 'intelligence',
    label: 'YouTube Intelligence',
    async run() {
      return {
        status: 'red',
        details: 'Known broken: ESM import failure in youtube-transcript package. See handoff April 17.',
      };
    },
  }),

  defineCheck({
    id: 'intelligence_reddit_status',
    category: 'intelligence',
    label: 'Reddit Intelligence',
    async run() {
      return {
        status: 'red',
        details: 'Known broken: fetch errors on all subs. See handoff April 17.',
      };
    },
  }),

];
