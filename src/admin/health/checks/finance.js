const supabase = require('../../../lib/supabase');
const { defineCheck } = require('../define-check');

module.exports = [
  defineCheck({
    id: 'finance_cron_last_run',
    category: 'crons',
    label: 'Finance Cost Snapshot',
    async run() {
      const { data, error } = await supabase.from('cost_snapshots')
        .select('snapshot_date')
        .order('snapshot_date', { ascending: false }).limit(1);
      if (error) return { status: 'red', details: `cost_snapshots query error: ${error.message}` };
      if (!data || !data.length) {
        return {
          status: 'red',
          details: 'No snapshots yet — cron fires nightly at 2 AM ET',
          metric: { value: 0, unit: 'h', label: 'Since last snapshot' },
        };
      }

      const snapshotDate = data[0].snapshot_date;
      // snapshot_date is a calendar date (ET). The cron fires around 2 AM ET,
      // so the row was written at ~02:00 ET on that day. Approximate that
      // wall-clock moment to compute age from "now".
      const writeTime = new Date(`${snapshotDate}T02:00:00-05:00`);
      const ageHours = (Date.now() - writeTime.getTime()) / 3600000;
      const ageH1 = Number(ageHours.toFixed(1));

      let status;
      if (ageHours < 28) status = 'green';
      else if (ageHours < 48) status = 'yellow';
      else status = 'red';

      return {
        status,
        details: `Last snapshot: ${snapshotDate} (${ageH1}h ago)`,
        metric: { value: ageH1, unit: 'h', label: 'Since last snapshot' },
      };
    },
  }),

  defineCheck({
    id: 'finance_sources_health',
    category: 'crons',
    label: 'Finance Source Health',
    async run() {
      const latestResp = await supabase.from('cost_snapshots')
        .select('snapshot_date')
        .order('snapshot_date', { ascending: false }).limit(1);
      if (latestResp.error) return { status: 'red', details: latestResp.error.message };
      if (!latestResp.data || !latestResp.data.length) {
        return {
          status: 'red',
          details: 'No snapshots yet',
          metric: { value: '0/0', unit: '', label: 'Errored / total' },
        };
      }

      const date = latestResp.data[0].snapshot_date;
      const { data: rows, error } = await supabase.from('cost_snapshots')
        .select('source,details').eq('snapshot_date', date);
      if (error) return { status: 'red', details: error.message };

      const total = (rows || []).length;
      const errored = (rows || []).filter(r => String(r.details || '').startsWith('ERROR:'));
      const ecount = errored.length;

      let status;
      if (total === 0) status = 'red';
      else if (ecount === 0) status = 'green';
      else if (ecount <= 3) status = 'yellow';
      else status = 'red';

      const details = ecount
        ? `Errored on ${date}: ${errored.map(r => r.source).join(', ')}`
        : `All ${total} sources healthy on ${date}`;

      return {
        status,
        details,
        metric: { value: `${ecount}/${total}`, unit: '', label: 'Errored / total' },
      };
    },
  }),
];
