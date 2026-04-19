const axios = require('axios');
const { defineCostSource } = require('../define-source');

// Vercel Usage API — team-scoped. Requires a token with "Full Account"
// access (or read-scoped to usage). VERCEL_TEAM_ID is the mancini-tech-solutions
// team. Response shape is not fully documented; parsing is defensive.
module.exports = defineCostSource({
  id: 'vercel',
  category: 'infrastructure',
  label: 'Vercel',
  source_type: 'api',
  async fetch() {
    const token = process.env.VERCEL_API_TOKEN;
    const teamId = process.env.VERCEL_TEAM_ID;
    if (!token) throw new Error('VERCEL_API_TOKEN not configured');

    const params = {};
    if (teamId) params.teamId = teamId;

    const { data } = await axios.get('https://api.vercel.com/v11/usage', {
      headers: { Authorization: `Bearer ${token}` },
      params,
      timeout: 12000,
    });

    // Known candidate shapes across Vercel API versions.
    const totalUsd = Number(
      (data && data.total && data.total.amount) ||
      (data && data.totalAmount) ||
      (data && data.amount_usd) ||
      0,
    );

    const bandwidthBytes = Number(
      (data && data.bandwidth && (data.bandwidth.total_bytes || data.bandwidth.bytes)) ||
      (data && data.bandwidthBytes) ||
      0,
    );
    const functionInvocations = Number(
      (data && (data.functionInvocations || data.invocations || 0)) || 0,
    );
    const cpuHours = Number((data && (data.cpuHours || data.computeHours || 0)) || 0);

    const parts = [];
    if (bandwidthBytes) parts.push(`${(bandwidthBytes / 1e9).toFixed(2)} GB bandwidth`);
    if (functionInvocations) parts.push(`${functionInvocations.toLocaleString()} invocations`);
    if (cpuHours) parts.push(`${cpuHours.toFixed(2)} CPU-hours`);
    if (!parts.length) parts.push('no usage detail fields in response');

    return {
      amount_cents: Math.round(totalUsd * 100),
      units: functionInvocations || null,
      unit_type: functionInvocations ? 'invocations' : null,
      details: parts.join(', '),
      raw_data: data,
    };
  },
});
