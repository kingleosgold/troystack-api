const { defineCostSource } = require('../define-source');

// Manual source while on Railway Hobby. The public GraphQL schema's usage/
// billing fields (`estimatedUsage`, `metrics`, `projectedUsage`) have shifted
// repeatedly and are typically exposed only for workspaces on a paid tier —
// a 400 on the root `estimatedUsage` query is consistent with "field not
// available on this plan / at this position." The original GraphQL
// implementation is preserved at sources/railway-api.js.disabled; rename it
// back to .js once on a plan tier that exposes billing via API (likely Pro),
// and re-verify the field path against https://docs.railway.com/reference/public-api.
module.exports = defineCostSource({
  id: 'railway',
  category: 'infrastructure',
  label: 'Railway',
  source_type: 'manual',
  async fetch() {
    const val = parseFloat(process.env.RAILWAY_MONTHLY_ESTIMATE || '5.00');
    return {
      amount_cents: Math.round(val * 100),
      details: `Manual entry ($${val.toFixed(2)}/mo). Hobby plan billing API is unstable — update RAILWAY_MONTHLY_ESTIMATE monthly from railway.app/account/usage, or upgrade and restore railway-api.js.disabled.`,
    };
  },
});
