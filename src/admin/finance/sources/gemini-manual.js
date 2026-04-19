const { defineCostSource } = require('../define-source');

module.exports = defineCostSource({
  id: 'gemini',
  category: 'ai_inference',
  label: 'Google Gemini',
  source_type: 'manual',
  async fetch() {
    const val = parseFloat(process.env.GEMINI_MONTHLY_ESTIMATE || '8.00');
    return {
      amount_cents: Math.round(val * 100),
      details: `Manual entry ($${val.toFixed(2)}/mo). Google Cloud Billing API is too messy for Phase 1 — update GEMINI_MONTHLY_ESTIMATE monthly from console.cloud.google.com.`,
    };
  },
});
