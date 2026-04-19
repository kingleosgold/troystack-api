const axios = require('axios');
const { defineCostSource } = require('../define-source');

// Railway public GraphQL API. The exact schema for `estimatedUsage` has
// changed between Railway versions — this query uses the current public
// surface; if the field name shifts, check https://docs.railway.com/reference/public-api.
module.exports = defineCostSource({
  id: 'railway',
  category: 'infrastructure',
  label: 'Railway',
  source_type: 'api',
  async fetch() {
    const token = process.env.RAILWAY_API_TOKEN;
    if (!token) throw new Error('RAILWAY_API_TOKEN not configured');

    const query = `
      query UsageEstimate {
        estimatedUsage {
          estimatedUsage
          projectedUsage
        }
      }
    `;

    const { data } = await axios.post(
      'https://backboard.railway.app/graphql/v2',
      { query },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        timeout: 12000,
      },
    );

    if (data && data.errors && data.errors.length) {
      throw new Error(`Railway GraphQL: ${JSON.stringify(data.errors).slice(0, 300)}`);
    }

    const node = (data && data.data && data.data.estimatedUsage) || {};
    const mtd = Number(node.estimatedUsage || 0);
    const projected = Number(node.projectedUsage || 0);

    return {
      amount_cents: Math.round(mtd * 100),
      details: `MTD $${mtd.toFixed(2)}, projected full month $${projected.toFixed(2)}`,
      raw_data: data && data.data,
    };
  },
});
