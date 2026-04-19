const { defineCostSource } = require('../define-source');

module.exports = defineCostSource({
  id: 'metalpriceapi',
  category: 'infrastructure',
  label: 'MetalPriceAPI',
  source_type: 'manual',
  async fetch() {
    const val = parseFloat(process.env.METALPRICEAPI_MONTHLY_ESTIMATE || '0');
    return {
      amount_cents: Math.round(val * 100),
      details: `Manual entry ($${val.toFixed(2)}/mo). Free tier post-downgrade — update METALPRICEAPI_MONTHLY_ESTIMATE if the plan changes.`,
    };
  },
});
