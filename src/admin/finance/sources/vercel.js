const { defineCostSource } = require('../define-source');

// Manual source while the team is on Vercel Hobby. The public Usage REST API
// (/v*/usage, /v1/teams/{id}/billing/*) is gated to Pro+ plans; Hobby usage is
// dashboard-only. A 404 on /v11/usage for a Hobby team is consistent with
// "endpoint not available on this plan." The original API implementation is
// preserved at sources/vercel-api.js.disabled; rename it back to .js once
// the team is on a plan tier that exposes the Usage API.
module.exports = defineCostSource({
  id: 'vercel',
  category: 'infrastructure',
  label: 'Vercel',
  source_type: 'manual',
  async fetch() {
    const val = parseFloat(process.env.VERCEL_MONTHLY_ESTIMATE || '0.00');
    return {
      amount_cents: Math.round(val * 100),
      details: `Manual entry ($${val.toFixed(2)}/mo). Hobby plan has no programmatic usage API — update VERCEL_MONTHLY_ESTIMATE monthly from vercel.com/dashboard/usage, or upgrade to Pro and restore vercel-api.js.disabled.`,
    };
  },
});
