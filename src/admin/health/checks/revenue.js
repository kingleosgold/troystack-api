const supabase = require('../../../lib/supabase');
const { defineCheck } = require('../define-check');

module.exports = [
  defineCheck({
    id: 'active_subscribers',
    category: 'revenue',
    label: 'Active Paid Subscribers',
    async run() {
      const { count, error } = await supabase.from('profiles')
        .select('*', { count: 'exact', head: true })
        .in('subscription_tier', ['gold', 'lifetime'])
        .eq('subscription_status', 'active');
      if (error) {
        return {
          status: 'green',
          details: `Query error (informational check, still green): ${error.message}`,
          metric: { value: 0, unit: 'subs', label: 'Active paid' },
        };
      }
      const n = count || 0;
      return {
        status: 'green',
        details: `${n} active paid subs`,
        metric: { value: n, unit: 'subs', label: 'Active paid' },
      };
    },
  }),

  defineCheck({
    id: 'new_subscribers_today',
    category: 'revenue',
    label: 'New Subscribers Today',
    async run() {
      const startOfDay = new Date().toISOString().split('T')[0] + 'T00:00:00.000Z';
      const { count, error } = await supabase.from('profiles')
        .select('*', { count: 'exact', head: true })
        .in('subscription_tier', ['gold', 'lifetime'])
        .gte('created_at', startOfDay);
      if (error) {
        return {
          status: 'green',
          details: `Query error (informational check, still green): ${error.message}`,
          metric: { value: 0, unit: 'new today' },
        };
      }
      const n = count || 0;
      return {
        status: 'green',
        details: `${n} new paid subs today`,
        metric: { value: n, unit: 'new today' },
      };
    },
  }),
];
