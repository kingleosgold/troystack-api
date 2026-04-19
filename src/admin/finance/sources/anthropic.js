const { defineCostSource } = require('../define-source');

// Manual source while Jon is on an Anthropic Individual API plan, which does
// not include Admin API (/v1/organizations/*) access — any call returns 401
// regardless of key scope. The original two-endpoint API implementation is
// preserved at sources/anthropic-api.js.disabled; rename it back to .js when
// the plan upgrades to Team/Enterprise.
module.exports = defineCostSource({
  id: 'anthropic',
  category: 'ai_inference',
  label: 'Anthropic Claude',
  source_type: 'manual',
  async fetch() {
    const val = parseFloat(process.env.ANTHROPIC_MONTHLY_ESTIMATE || '8.00');
    return {
      amount_cents: Math.round(val * 100),
      details: `Manual entry ($${val.toFixed(2)}/mo). Admin API requires Teams/Enterprise plan — update ANTHROPIC_MONTHLY_ESTIMATE monthly from console.anthropic.com/workspaces/default/cost (Export button available).`,
    };
  },
});
