const { defineCostSource } = require('../define-source');

module.exports = defineCostSource({
  id: 'openai',
  category: 'ai_inference',
  label: 'OpenAI (Whisper)',
  source_type: 'manual',
  async fetch() {
    const val = parseFloat(process.env.OPENAI_MONTHLY_ESTIMATE || '2.00');
    return {
      amount_cents: Math.round(val * 100),
      details: `Manual entry ($${val.toFixed(2)}/mo). Whisper + DALL-E usage is low — update OPENAI_MONTHLY_ESTIMATE monthly from platform.openai.com/usage.`,
    };
  },
});
