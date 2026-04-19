const { defineCostSource } = require('../define-source');

module.exports = defineCostSource({
  id: 'supabase',
  category: 'infrastructure',
  label: 'Supabase',
  source_type: 'manual',
  async fetch() {
    const val = parseFloat(process.env.SUPABASE_MONTHLY_ESTIMATE || '45.00');
    return {
      amount_cents: Math.round(val * 100),
      details: `Manual entry ($${val.toFixed(2)}/mo). No billing API — update SUPABASE_MONTHLY_ESTIMATE env var monthly from Supabase dashboard.`,
    };
  },
});
