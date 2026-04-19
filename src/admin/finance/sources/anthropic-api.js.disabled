const axios = require('axios');
const { defineCostSource } = require('../define-source');

// Anthropic Admin API — combined usage + cost snapshot.
// Hits two endpoints in parallel (Promise.allSettled so one failure
// doesn't block the other):
//   - /v1/organizations/usage_report/messages  → token counts per model
//   - /v1/organizations/cost_report            → dollar costs per model
// Both require an Admin API key (ANTHROPIC_ADMIN_KEY), which is distinct
// from the inference key in ANTHROPIC_API_KEY.
// Docs:
//   https://docs.claude.com/en/api/admin-api/usage-cost/get-messages-usage-report
//   https://docs.claude.com/en/api/admin-api/usage-cost/get-cost-report

const BASE = 'https://api.anthropic.com';
const USAGE_URL = `${BASE}/v1/organizations/usage_report/messages`;
const COST_URL = `${BASE}/v1/organizations/cost_report`;

function shortErr(err) {
  if (!err) return 'unknown';
  if (err.response && err.response.status) {
    return `HTTP ${err.response.status}${err.response.data && err.response.data.error && err.response.data.error.message ? ' ' + String(err.response.data.error.message).slice(0, 80) : ''}`;
  }
  return (err.message || String(err)).slice(0, 120);
}

function parseUsageResponse(data) {
  const buckets = Array.isArray(data && data.data) ? data.data : [];
  let totalTokens = 0;
  const tokensByModel = {};
  let rowCount = 0;
  for (const bucket of buckets) {
    const rows = Array.isArray(bucket.results) ? bucket.results
      : Array.isArray(bucket.usage) ? bucket.usage
      : [];
    for (const row of rows) {
      rowCount++;
      const subtotal =
        Number(row.uncached_input_tokens || row.input_tokens || 0) +
        Number(row.output_tokens || 0) +
        Number(row.cache_creation_input_tokens || 0) +
        Number(row.cached_input_tokens || 0);
      totalTokens += subtotal;
      const model = row.model || row.model_name || 'unknown';
      tokensByModel[model] = (tokensByModel[model] || 0) + subtotal;
    }
  }
  return { totalTokens, tokensByModel, rowCount };
}

function parseCostResponse(data) {
  const buckets = Array.isArray(data && data.data) ? data.data : [];
  let totalCents = 0;
  const centsByModel = {};
  let rowCount = 0;
  let costExtracted = 0;
  for (const bucket of buckets) {
    const rows = Array.isArray(bucket.results) ? bucket.results
      : Array.isArray(bucket.costs) ? bucket.costs
      : [];
    for (const row of rows) {
      rowCount++;
      // Cover the plausible field shapes: { amount: { value, currency } },
      // { amount_usd }, { cost_usd }, { cost }, or a bare numeric `amount`.
      let costUsd = NaN;
      if (row.amount && typeof row.amount === 'object' && row.amount.value != null) {
        costUsd = Number(row.amount.value);
      } else if (row.amount_usd != null) {
        costUsd = Number(row.amount_usd);
      } else if (row.cost_usd != null) {
        costUsd = Number(row.cost_usd);
      } else if (row.cost != null) {
        costUsd = Number(row.cost);
      } else if (typeof row.amount === 'number') {
        costUsd = row.amount;
      }
      if (!isNaN(costUsd)) {
        if (costUsd > 0) costExtracted++;
        const cents = Math.round(costUsd * 100);
        totalCents += cents;
        const model = row.model || row.model_name || row.service || row.cost_type || 'unknown';
        centsByModel[model] = (centsByModel[model] || 0) + cents;
      }
    }
  }
  // Shape-mismatch heuristic: we saw rows but couldn't extract any cost field.
  const shapeLooksOff = rowCount > 0 && costExtracted === 0;
  return { totalCents, centsByModel, rowCount, shapeLooksOff };
}

function fmtTokens(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}

function buildBreakdown(tokensByModel, centsByModel) {
  const models = new Set([...Object.keys(tokensByModel), ...Object.keys(centsByModel)]);
  const entries = [...models].map(m => {
    const t = tokensByModel[m] || 0;
    const c = centsByModel[m] || 0;
    const tokPart = t > 0 ? `${fmtTokens(t)} tokens` : '';
    const costPart = c > 0 ? `$${(c / 100).toFixed(2)}` : '';
    const parts = [tokPart, costPart].filter(Boolean).join(' ');
    return `${m}: ${parts || '0'}`;
  });
  // Deterministic ordering: largest cost first, then largest token count
  entries.sort((a, b) => {
    const getCost = s => { const m = s.match(/\$([\d.]+)/); return m ? parseFloat(m[1]) : 0; };
    const ca = getCost(a), cb = getCost(b);
    if (ca !== cb) return cb - ca;
    return a.localeCompare(b);
  });
  return entries.join(', ');
}

module.exports = defineCostSource({
  id: 'anthropic',
  category: 'ai_inference',
  label: 'Anthropic Claude',
  source_type: 'api',
  async fetch() {
    const adminKey = process.env.ANTHROPIC_ADMIN_KEY;
    if (!adminKey) throw new Error('ANTHROPIC_ADMIN_KEY not configured');

    const endingAt = new Date();
    const startingAt = new Date(endingAt.getTime() - 24 * 3600 * 1000);
    const headers = {
      'x-api-key': adminKey,
      'anthropic-version': '2023-06-01',
    };
    const params = {
      starting_at: startingAt.toISOString(),
      ending_at: endingAt.toISOString(),
    };

    const [usageSettled, costSettled] = await Promise.allSettled([
      axios.get(USAGE_URL, { headers, params, timeout: 12000 }),
      axios.get(COST_URL, { headers, params, timeout: 12000 }),
    ]);

    const flags = [];
    let tokens = null;
    let tokensByModel = {};
    let usageRaw = null;

    if (usageSettled.status === 'fulfilled') {
      usageRaw = usageSettled.value.data;
      const parsed = parseUsageResponse(usageRaw);
      tokens = parsed.totalTokens;
      tokensByModel = parsed.tokensByModel;
    } else {
      flags.push(`usage_report failed (${shortErr(usageSettled.reason)})`);
    }

    let cents = null;
    let centsByModel = {};
    let costRaw = null;

    if (costSettled.status === 'fulfilled') {
      costRaw = costSettled.value.data;
      const parsed = parseCostResponse(costRaw);
      if (parsed.shapeLooksOff) {
        console.warn(
          '[Finance] anthropic cost_report shape unexpected — raw response (truncated): ' +
          JSON.stringify(costRaw).slice(0, 2000),
        );
        flags.push(`cost_report shape unexpected (${parsed.rowCount} rows, no cost fields parsed)`);
        // Don't trust extracted data on shape mismatch
      } else {
        cents = parsed.totalCents;
        centsByModel = parsed.centsByModel;
      }
    } else {
      flags.push(`cost_report failed (${shortErr(costSettled.reason)})`);
    }

    // Hard failure only if BOTH endpoints are unusable.
    if (tokens === null && cents === null) {
      throw new Error(flags.join('; ') || 'both Anthropic endpoints failed');
    }

    const breakdown = buildBreakdown(tokensByModel, centsByModel);
    const prefix = breakdown || '(no activity in 24h window)';
    const details = (flags.length ? `${prefix} — ${flags.join('; ')}` : prefix).slice(0, 500);

    return {
      amount_cents: cents != null ? cents : 0,
      units: tokens,
      unit_type: tokens != null ? 'tokens' : null,
      details,
      raw_data: { usage: usageRaw, cost: costRaw },
    };
  },
});
