/**
 * MCP (Model Context Protocol) server endpoint.
 *
 * Speaks the Streamable HTTP MCP transport via @modelcontextprotocol/sdk.
 * Exposes 6 tools that wrap existing service/route logic without HTTP
 * self-requests.
 *
 * Transport endpoints (all mounted at /mcp in index.js):
 *   POST /mcp   — JSON-RPC request from client (may upgrade to SSE stream)
 *   GET  /mcp   — client opens SSE stream for server→client notifications
 *   DELETE /mcp — client terminates its session
 *
 * Sessions are managed internally by StreamableHTTPServerTransport —
 * no manual session map required.
 */

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { randomUUID } = require('crypto');
const { z } = require('zod');

const axios = require('axios');
const supabase = require('../lib/supabase');
const { getSpotPrices, getCachedPrices } = require('../services/price-fetcher');
const { callGemini, MODELS } = require('../services/ai-router');
const { hashKey } = require('../middleware/api-key-auth');

// ============================================
// TOOL IMPLEMENTATIONS
// Each wraps an existing REST route's logic without self-requests.
// ============================================

async function tool_getSpotPrices() {
  return await getSpotPrices();
}

async function tool_getPriceHistory({ metal, range = '1Y' }) {
  const rangeMap = { '1M': 30, '3M': 90, '6M': 180, '1Y': 365, '5Y': 1825, ALL: 3650 };
  const days = rangeMap[(range || '1Y').toUpperCase()] || 365;
  const since = new Date();
  since.setDate(since.getDate() - days);

  const { data, error } = await supabase
    .from('price_log')
    .select('timestamp, gold, silver, platinum, palladium')
    .gte('timestamp', since.toISOString())
    .order('timestamp', { ascending: true });

  if (error) throw new Error(`price_log query failed: ${error.message}`);

  const points = (data || [])
    .map(r => ({ timestamp: r.timestamp, price: r[metal] }))
    .filter(p => typeof p.price === 'number');

  return {
    metal,
    range: (range || '1Y').toUpperCase(),
    count: points.length,
    points,
  };
}

async function tool_getStackSignal({ limit = 20, offset = 0, category }) {
  const cappedLimit = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 50);
  const safeOffset = Math.max(parseInt(offset, 10) || 0, 0);

  let query = supabase
    .from('stack_signal_articles')
    .select('id, slug, title, troy_one_liner, troy_commentary, sources, category, image_url, relevance_score, is_stack_signal, published_at, view_count, like_count, comment_count')
    .order('published_at', { ascending: false })
    .range(safeOffset, safeOffset + cappedLimit - 1);

  if (category) query = query.eq('category', category);

  const { data, error } = await query;
  if (error) throw new Error(`stack_signal query failed: ${error.message}`);
  return { articles: data || [], count: data?.length || 0 };
}

async function tool_getVaultWatch({ metal }) {
  const VALID_METALS = ['gold', 'silver', 'platinum', 'palladium'];
  const metals = metal ? [metal] : VALID_METALS;

  if (metal && !VALID_METALS.includes(metal)) {
    throw new Error(`Invalid metal. Use: ${VALID_METALS.join(', ')}`);
  }

  const results = {};
  for (const m of metals) {
    const { data } = await supabase
      .from('vault_data')
      .select('date, metal, registered_oz, eligible_oz, combined_oz, registered_change_oz, eligible_change_oz, combined_change_oz, open_interest_oz, oversubscribed_ratio')
      .eq('metal', m)
      .eq('source', 'comex')
      .order('date', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (data) results[m] = data;
  }

  return metal ? (results[metal] || null) : results;
}

// Junk silver constants — duplicated from routes/junk-silver.js per "don't change existing routes"
const JUNK_SILVER_CONTENT = {
  dimes: 0.07234,
  quarters: 0.18084,
  half_dollars: 0.36169,
  kennedy_40: 0.14792,
  dollars: 0.77344,
  war_nickels: 0.05626,
};
const JUNK_SILVER_FACE = {
  dimes: 0.10,
  quarters: 0.25,
  half_dollars: 0.50,
  kennedy_40: 0.50,
  dollars: 1.00,
  war_nickels: 0.05,
};

async function tool_getJunkSilver(args) {
  const spotData = await getSpotPrices();
  const silverSpot = spotData?.prices?.silver;
  if (!silverSpot || silverSpot <= 0) {
    throw new Error('Silver spot price unavailable');
  }

  const coins = {};
  const perFaceDollar = {};
  let totalSilverOz = 0;
  let totalMeltValue = 0;

  for (const coin of Object.keys(JUNK_SILVER_CONTENT)) {
    const qty = parseInt(args?.[coin], 10);
    if (!Number.isFinite(qty) || qty <= 0) continue;

    const ozPerCoin = JUNK_SILVER_CONTENT[coin];
    const silverOz = qty * ozPerCoin;
    const meltValue = silverOz * silverSpot;

    coins[coin] = {
      quantity: qty,
      silver_oz: Math.round(silverOz * 1000) / 1000,
      melt_value: Math.round(meltValue * 100) / 100,
    };

    totalSilverOz += silverOz;
    totalMeltValue += meltValue;

    const coinsPerFaceDollar = 1 / JUNK_SILVER_FACE[coin];
    perFaceDollar[coin] = Math.round(ozPerCoin * silverSpot * coinsPerFaceDollar * 100) / 100;
  }

  return {
    spot_silver: silverSpot,
    coins,
    total_silver_oz: Math.round(totalSilverOz * 1000) / 1000,
    total_melt_value: Math.round(totalMeltValue * 100) / 100,
    per_face_dollar: perFaceDollar,
    spot_updated_at: spotData.timestamp,
  };
}

async function tool_getSpeculation({ gold, silver, platinum, palladium }) {
  const spotData = await getSpotPrices();
  const current = spotData?.prices || {};

  const targets = { gold, silver, platinum, palladium };
  const result = { current_prices: current, targets: {} };

  for (const [metal, target] of Object.entries(targets)) {
    if (target === undefined || target === null) continue;
    const cur = current[metal];
    if (!cur) continue;
    const t = parseFloat(target);
    if (!Number.isFinite(t)) continue;
    result.targets[metal] = {
      current: cur,
      target: t,
      multiplier: Math.round((t / cur) * 100) / 100,
      change_pct: Math.round(((t - cur) / cur) * 10000) / 100,
    };
  }

  return result;
}

// ============================================
// AUTH HELPER — shared by all authenticated MCP tools
// ============================================

const AUTH_ERROR = { error: 'Invalid API key. Generate one at troystack.ai/developers/keys' };

/**
 * Validate an api_key param: hash it, look up in api_keys table.
 * Returns { userId, keyRow } on success or { error } on failure.
 * Also bumps last_used_at and request_count.
 */
async function validateApiKey(apiKey) {
  if (!apiKey || typeof apiKey !== 'string') return AUTH_ERROR;

  const keyHash = hashKey(apiKey);
  const { data: keyRow, error } = await supabase
    .from('api_keys')
    .select('id, user_id, tier, rate_limit, request_count')
    .eq('key_hash', keyHash)
    .single();

  if (error || !keyRow) return AUTH_ERROR;

  // Fire-and-forget update
  supabase
    .from('api_keys')
    .update({ last_used_at: new Date().toISOString(), request_count: (keyRow.request_count || 0) + 1 })
    .eq('id', keyRow.id)
    .then()
    .catch(err => console.error('[MCP] Key usage update error:', err.message));

  return { userId: keyRow.user_id, keyRow };
}

/**
 * Fetch holdings for a user. Returns array (may be empty).
 */
async function fetchHoldings(userId) {
  const { data, error } = await supabase
    .from('holdings')
    .select('id, metal, type, weight, weight_unit, quantity, purchase_price, purchase_date, notes')
    .eq('user_id', userId)
    .is('deleted_at', null)
    .order('created_at', { ascending: false });

  if (error) throw new Error(`Holdings query failed: ${error.message}`);
  return data || [];
}

// ============================================
// AUTHENTICATED TOOL IMPLEMENTATIONS
// ============================================

async function tool_chatWithTroy({ message, api_key }) {
  let prices = getCachedPrices() || {};
  if (!prices.gold) {
    try { prices = (await getSpotPrices()).prices; } catch { /* use cached */ }
  }

  const gsRatio = prices.silver > 0 ? (prices.gold / prices.silver).toFixed(1) : 'N/A';
  let stackContext = '';

  // If api_key, enrich with portfolio data
  if (api_key) {
    const auth = await validateApiKey(api_key);
    if (!auth.error) {
      const holdings = await fetchHoldings(auth.userId);
      const metalTotals = { gold: { oz: 0, cost: 0 }, silver: { oz: 0, cost: 0 }, platinum: { oz: 0, cost: 0 }, palladium: { oz: 0, cost: 0 } };

      for (const h of holdings) {
        const m = h.metal;
        if (!metalTotals[m]) continue;
        const totalOz = (h.weight || 0) * (h.quantity || 1);
        const totalCost = (h.purchase_price || 0) * (h.quantity || 1);
        metalTotals[m].oz += totalOz;
        metalTotals[m].cost += totalCost;
      }

      const totalValue = Object.keys(metalTotals).reduce((s, m) => s + metalTotals[m].oz * (prices[m] || 0), 0);
      const totalCost = Object.keys(metalTotals).reduce((s, m) => s + metalTotals[m].cost, 0);

      const metalSummary = Object.entries(metalTotals)
        .filter(([, v]) => v.oz > 0)
        .map(([m, v]) => {
          const val = v.oz * (prices[m] || 0);
          return `${m}: ${v.oz.toFixed(2)} oz ($${val.toFixed(2)}, cost $${v.cost.toFixed(2)})`;
        }).join(', ');

      stackContext = `\n\nUSER'S STACK:\nTotal Value: $${totalValue.toFixed(2)} | Cost: $${totalCost.toFixed(2)} | ${totalValue >= totalCost ? 'Gain' : 'Loss'}: $${Math.abs(totalValue - totalCost).toFixed(2)}\nHoldings: ${metalSummary || 'Empty stack'}`;
    }
  }

  const systemPrompt = `You are Troy, a sharp precious metals analyst. Direct, opinionated, data-driven. Say "your stack" not "your portfolio". No emojis, no exclamation points, no "not financial advice". Dips are buying opportunities. You never recommend selling.

CURRENT MARKET:
Gold: $${prices.gold || 'N/A'}, Silver: $${prices.silver || 'N/A'}, G/S Ratio: ${gsRatio}${stackContext}`;

  const response = await callGemini(MODELS.flash, systemPrompt, message, { temperature: 0.8, maxOutputTokens: 1000 });
  return { response: response.trim() };
}

async function tool_getPortfolio({ api_key }) {
  const auth = await validateApiKey(api_key);
  if (auth.error) return auth;

  const holdings = await fetchHoldings(auth.userId);
  const spotData = await getSpotPrices();
  const prices = spotData?.prices || {};

  const metals = {};
  for (const h of holdings) {
    const m = h.metal;
    if (!metals[m]) metals[m] = { oz: 0, value: 0, cost: 0 };
    const totalOz = (h.weight || 0) * (h.quantity || 1);
    const totalCost = (h.purchase_price || 0) * (h.quantity || 1);
    metals[m].oz += totalOz;
    metals[m].value += totalOz * (prices[m] || 0);
    metals[m].cost += totalCost;
  }

  // Round metal values
  for (const m of Object.keys(metals)) {
    metals[m].oz = Math.round(metals[m].oz * 10000) / 10000;
    metals[m].value = Math.round(metals[m].value * 100) / 100;
    metals[m].cost = Math.round(metals[m].cost * 100) / 100;
  }

  const totalValue = Object.values(metals).reduce((s, v) => s + v.value, 0);
  const totalCost = Object.values(metals).reduce((s, v) => s + v.cost, 0);
  const gainLoss = Math.round((totalValue - totalCost) * 100) / 100;
  const gainPct = totalCost > 0 ? Math.round(((totalValue - totalCost) / totalCost) * 10000) / 100 : 0;

  const holdingsList = holdings.map(h => ({
    type: h.type || `${h.metal} purchase`,
    metal: h.metal,
    quantity: h.quantity,
    weight_oz: h.weight,
    total_oz: Math.round((h.weight || 0) * (h.quantity || 1) * 10000) / 10000,
    purchase_price: h.purchase_price,
    purchase_date: h.purchase_date,
  }));

  return { total_value: Math.round(totalValue * 100) / 100, cost_basis: Math.round(totalCost * 100) / 100, gain_loss: gainLoss, gain_pct: gainPct, metals, holdings: holdingsList };
}

async function tool_addHolding({ api_key, metal, type, quantity, weight_oz, purchase_price, purchase_date }) {
  const auth = await validateApiKey(api_key);
  if (auth.error) return auth;

  const VALID = ['gold', 'silver', 'platinum', 'palladium'];
  const m = (metal || '').toLowerCase();
  if (!VALID.includes(m)) return { error: `Invalid metal. Use: ${VALID.join(', ')}` };
  if (!quantity || !weight_oz || !purchase_price) return { error: 'quantity, weight_oz, and purchase_price are required' };

  const totalOz = parseFloat(weight_oz) * parseInt(quantity, 10);

  const { data, error } = await supabase
    .from('holdings')
    .insert({
      user_id: auth.userId,
      metal: m,
      type: type || `${m} purchase`,
      weight: parseFloat(weight_oz),
      quantity: parseInt(quantity, 10),
      purchase_price: parseFloat(purchase_price),
      purchase_date: purchase_date || new Date().toISOString().split('T')[0],
      weight_unit: 'oz',
      notes: JSON.stringify({ source: 'mcp' }),
    })
    .select()
    .single();

  if (error) throw new Error(`Insert failed: ${error.message}`);
  return { success: true, holding: data, total_oz: Math.round(totalOz * 10000) / 10000 };
}

async function tool_getAnalytics({ api_key }) {
  const auth = await validateApiKey(api_key);
  if (auth.error) return auth;

  const holdings = await fetchHoldings(auth.userId);
  const spotData = await getSpotPrices();
  const prices = spotData?.prices || {};

  const analytics = {};
  const METALS = ['gold', 'silver', 'platinum', 'palladium'];

  for (const metal of METALS) {
    const metalHoldings = holdings.filter(h => h.metal === metal);
    const totalOz = metalHoldings.reduce((s, h) => s + (h.weight || 0) * (h.quantity || 1), 0);
    const totalCost = metalHoldings.reduce((s, h) => s + (h.purchase_price || 0) * (h.quantity || 1), 0);
    const spot = prices[metal] || 0;
    const marketValue = totalOz * spot;

    if (totalOz > 0) {
      const dates = metalHoldings.map(h => h.purchase_date).filter(Boolean).sort();
      analytics[metal] = {
        total_oz: Math.round(totalOz * 10000) / 10000,
        avg_cost_per_oz: Math.round((totalCost / totalOz) * 100) / 100,
        break_even_price: Math.round((totalCost / totalOz) * 100) / 100,
        current_spot: spot,
        market_value: Math.round(marketValue * 100) / 100,
        total_cost: Math.round(totalCost * 100) / 100,
        unrealized_pl: Math.round((marketValue - totalCost) * 100) / 100,
        unrealized_pl_pct: totalCost > 0 ? Math.round(((marketValue - totalCost) / totalCost) * 10000) / 100 : 0,
        is_profitable: marketValue >= totalCost,
        purchase_count: metalHoldings.length,
        first_purchase: dates[0] || null,
        latest_purchase: dates[dates.length - 1] || null,
      };
    }
  }

  return { analytics };
}

async function tool_scanReceipt({ api_key, image_base64 }) {
  const auth = await validateApiKey(api_key);
  if (auth.error) return auth;

  if (!image_base64) return { error: 'image_base64 is required' };

  const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
  if (!GEMINI_API_KEY) return { error: 'Receipt scanner not configured' };

  const prompt = `Extract precious metals purchase data from this receipt image. Read every number EXACTLY as printed.

RULES:
1. ONLY include precious metal products: coins, bars, rounds
2. EXCLUDE accessories: tubes, capsules, boxes, cases, albums, flips, holders
3. EXCLUDE items under $10 (accessories)
4. Read prices EXACTLY - do not estimate
5. Extract purchase TIME if visible

Return ONLY valid JSON (no markdown, no explanation):
{
  "dealer": "dealer name",
  "purchaseDate": "YYYY-MM-DD",
  "purchaseTime": "HH:MM",
  "items": [
    {
      "description": "product name exactly as printed",
      "quantity": 1,
      "unitPrice": 123.45,
      "extPrice": 123.45,
      "metal": "silver",
      "ozt": 1.0
    }
  ]
}

If a field is unreadable, use null. Metal must be: gold, silver, platinum, or palladium.`;

  const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;
  const geminiResp = await axios.post(geminiUrl, {
    contents: [{
      parts: [
        { text: prompt },
        { inline_data: { mime_type: 'image/jpeg', data: image_base64 } },
      ],
    }],
    generationConfig: { temperature: 0.1, maxOutputTokens: 2048 },
  }, { headers: { 'Content-Type': 'application/json' }, timeout: 60000 });

  const responseText = geminiResp.data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!responseText) return { error: 'No response from scanner' };

  const jsonMatch = responseText.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return { error: 'Could not parse receipt data' };

  return { success: true, data: JSON.parse(jsonMatch[0]) };
}

async function tool_getDailyBrief({ api_key }) {
  const todayEST = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

  // If api_key provided, fetch personalized brief
  if (api_key) {
    const auth = await validateApiKey(api_key);
    if (auth.error) return auth;

    const { data, error } = await supabase
      .from('daily_briefs')
      .select('brief_text, generated_at, date')
      .eq('user_id', auth.userId)
      .order('date', { ascending: false })
      .limit(1)
      .single();

    if (error || !data) {
      return { success: true, brief: null, message: 'No daily brief available. Briefs are generated for Gold/Lifetime subscribers.' };
    }

    return { success: true, brief: { brief_text: data.brief_text, generated_at: data.generated_at, date: data.date, is_current: data.date === todayEST } };
  }

  // No api_key — return latest Stack Signal synthesis as a generic market brief
  const { data: signal } = await supabase
    .from('stack_signal_articles')
    .select('title, troy_commentary, troy_one_liner, published_at')
    .eq('is_stack_signal', true)
    .order('published_at', { ascending: false })
    .limit(1)
    .single();

  if (!signal) {
    return { success: true, brief: null, message: 'No market brief available today' };
  }

  return { success: true, brief: { title: signal.title, brief_text: signal.troy_commentary, date: signal.published_at?.split('T')[0], summary: signal.troy_one_liner } };
}

// ============================================
// MCP SERVER FACTORY
// ============================================

function jsonResult(obj) {
  return { content: [{ type: 'text', text: JSON.stringify(obj) }] };
}

function createMcpServer() {
  const server = new McpServer(
    { name: 'troystack', version: '3.0.1' },
    { capabilities: { tools: {} } }
  );

  server.registerTool(
    'get_spot_prices',
    {
      title: 'Get Spot Prices',
      description: 'Returns current spot prices for gold, silver, platinum, and palladium with daily change percentages',
      inputSchema: {},
    },
    async () => jsonResult(await tool_getSpotPrices())
  );

  server.registerTool(
    'get_price_history',
    {
      title: 'Get Price History',
      description: 'Historical spot price data for a precious metal over a time range',
      inputSchema: {
        metal: z.enum(['gold', 'silver', 'platinum', 'palladium']).describe('The metal to fetch history for'),
        range: z.enum(['1M', '3M', '6M', '1Y', '5Y', 'ALL']).optional().describe('Time range (default 1Y)'),
      },
    },
    async (args) => jsonResult(await tool_getPriceHistory(args))
  );

  server.registerTool(
    'get_stack_signal',
    {
      title: 'Get Stack Signal Articles',
      description: 'Returns Stack Signal — TroyStack\'s curated precious metals market intelligence with Troy\'s commentary',
      inputSchema: {
        limit: z.number().int().min(1).max(50).optional().describe('Max articles to return (default 20)'),
        offset: z.number().int().min(0).optional().describe('Pagination offset (default 0)'),
        category: z.string().optional().describe('Optional category filter'),
      },
    },
    async (args) => jsonResult(await tool_getStackSignal(args || {}))
  );

  server.registerTool(
    'get_vault_watch',
    {
      title: 'Get COMEX Vault Watch',
      description: 'Returns COMEX warehouse inventory: registered, eligible, combined ounces, daily changes, open interest, oversubscribed ratio',
      inputSchema: {
        metal: z.enum(['gold', 'silver', 'platinum', 'palladium']).optional().describe('Optional metal filter; returns all 4 if omitted'),
      },
    },
    async (args) => jsonResult(await tool_getVaultWatch(args || {}))
  );

  server.registerTool(
    'get_junk_silver',
    {
      title: 'Calculate Junk Silver Melt Value',
      description: 'Calculates silver melt value for pre-1965 US coinage',
      inputSchema: {
        dimes: z.number().int().min(0).optional().describe('Roosevelt/Mercury dime count (0.07234 oz Ag each)'),
        quarters: z.number().int().min(0).optional().describe('Washington quarter count (0.18084 oz Ag each)'),
        half_dollars: z.number().int().min(0).optional().describe('Walking Liberty/Franklin/1964 Kennedy half count (0.36169 oz Ag each)'),
        kennedy_40: z.number().int().min(0).optional().describe('Kennedy 1965-1970 40% silver halves (0.14792 oz Ag each)'),
        dollars: z.number().int().min(0).optional().describe('Morgan/Peace dollar count (0.77344 oz Ag each)'),
        war_nickels: z.number().int().min(0).optional().describe('Jefferson 1942-1945 war nickel count (0.05626 oz Ag each)'),
      },
    },
    async (args) => jsonResult(await tool_getJunkSilver(args || {}))
  );

  server.registerTool(
    'get_speculation',
    {
      title: 'Run What-If Price Scenario',
      description: 'Calculates price multipliers comparing current spot to hypothetical target prices',
      inputSchema: {
        gold: z.number().optional().describe('Target gold price per oz'),
        silver: z.number().optional().describe('Target silver price per oz'),
        platinum: z.number().optional().describe('Target platinum price per oz'),
        palladium: z.number().optional().describe('Target palladium price per oz'),
      },
    },
    async (args) => jsonResult(await tool_getSpeculation(args || {}))
  );

  // ── Authenticated tools (optional or required api_key) ──

  server.registerTool(
    'chat_with_troy',
    {
      title: 'Chat with Troy',
      description: 'Ask Troy anything about precious metals, markets, your stack. Provide api_key for personalized portfolio-aware answers, or omit for general market analysis.',
      inputSchema: {
        message: z.string().describe('Your question or message for Troy'),
        api_key: z.string().optional().describe('TroyStack API key for portfolio-aware responses (optional)'),
      },
    },
    async (args) => jsonResult(await tool_chatWithTroy(args))
  );

  server.registerTool(
    'get_portfolio',
    {
      title: 'Get Portfolio',
      description: 'Returns your precious metals portfolio: total value, cost basis, gain/loss, per-metal breakdown, and individual holdings',
      inputSchema: {
        api_key: z.string().describe('TroyStack API key (required)'),
      },
    },
    async (args) => jsonResult(await tool_getPortfolio(args))
  );

  server.registerTool(
    'add_holding',
    {
      title: 'Add Holding',
      description: 'Add a precious metals purchase to your portfolio',
      inputSchema: {
        api_key: z.string().describe('TroyStack API key (required)'),
        metal: z.enum(['gold', 'silver', 'platinum', 'palladium']).describe('Metal type'),
        type: z.string().optional().describe('Product name (e.g. "2024 American Silver Eagle")'),
        quantity: z.number().int().min(1).describe('Number of pieces'),
        weight_oz: z.number().min(0.001).describe('Weight per piece in troy ounces'),
        purchase_price: z.number().min(0.01).describe('Price per piece in USD'),
        purchase_date: z.string().optional().describe('Purchase date YYYY-MM-DD (default: today)'),
      },
    },
    async (args) => jsonResult(await tool_addHolding(args))
  );

  server.registerTool(
    'get_analytics',
    {
      title: 'Get Portfolio Analytics',
      description: 'Cost basis, average cost per oz, break-even price, unrealized P/L per metal',
      inputSchema: {
        api_key: z.string().describe('TroyStack API key (required)'),
      },
    },
    async (args) => jsonResult(await tool_getAnalytics(args))
  );

  server.registerTool(
    'scan_receipt',
    {
      title: 'Scan Receipt',
      description: 'Extract precious metals purchase data from a receipt image using AI vision',
      inputSchema: {
        api_key: z.string().describe('TroyStack API key (required)'),
        image_base64: z.string().describe('Base64-encoded receipt image (JPEG)'),
      },
    },
    async (args) => jsonResult(await tool_scanReceipt(args))
  );

  server.registerTool(
    'get_daily_brief',
    {
      title: 'Get Daily Brief',
      description: 'Troy\'s daily market brief. Provide api_key for personalized brief, or omit for the latest Stack Signal market synthesis.',
      inputSchema: {
        api_key: z.string().optional().describe('TroyStack API key for personalized brief (optional)'),
      },
    },
    async (args) => jsonResult(await tool_getDailyBrief(args || {}))
  );

  return server;
}

// ============================================
// STREAMABLE HTTP TRANSPORT — per-session model
// Each client gets its own McpServer + Transport instance so multiple
// concurrent sessions don't hit "Server already initialized".
// ============================================

// Map sessionId → { server, transport }
const sessions = new Map();

// Clean up stale sessions after 30 minutes of inactivity
const SESSION_TTL_MS = 30 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.lastActivity > SESSION_TTL_MS) {
      console.log(`[MCP] Cleaning up stale session: ${id}`);
      try { session.transport.close?.(); } catch { /* ignore */ }
      try { session.server.close?.(); } catch { /* ignore */ }
      sessions.delete(id);
    }
  }
}, 5 * 60 * 1000); // check every 5 minutes

/**
 * Read the raw request body as a string. Resolves even if the body is empty.
 * Used instead of express.json() so malformed or empty POST bodies don't get
 * rejected before reaching the MCP transport.
 */
function readRawBody(req) {
  return new Promise((resolve, reject) => {
    // If something upstream already parsed the body, reuse it (defensive)
    if (req.body !== undefined && req.body !== null && typeof req.body !== 'string') {
      return resolve(req.body);
    }

    let raw = '';
    req.setEncoding('utf8');
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        // Malformed JSON → empty object so the transport can return a proper MCP error
        resolve({});
      }
    });
    req.on('error', reject);
  });
}

async function handleMcp(req, res) {
  // Force-set Accept header — StreamableHTTPServerTransport returns 400
  // "Not Acceptable" without both application/json and text/event-stream
  if (!req.headers.accept || !req.headers.accept.includes('text/event-stream')) {
    req.headers.accept = 'application/json, text/event-stream';
  }

  try {
    const sessionId = req.headers['mcp-session-id'];

    if (sessionId && sessions.has(sessionId)) {
      // Route to existing session
      const session = sessions.get(sessionId);
      session.lastActivity = Date.now();

      if (req.method === 'POST') {
        const body = await readRawBody(req);
        await session.transport.handleRequest(req, res, body);
      } else if (req.method === 'DELETE') {
        await session.transport.handleRequest(req, res);
        sessions.delete(sessionId);
        console.log(`[MCP] Session deleted: ${sessionId} (${sessions.size} active)`);
      } else {
        await session.transport.handleRequest(req, res);
      }
    } else if (req.method === 'POST') {
      // New session — create a fresh McpServer + Transport pair
      const server = createMcpServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => {
          console.log(`[MCP] New session: ${sid} (${sessions.size + 1} active)`);
          sessions.set(sid, { server, transport, lastActivity: Date.now() });
        },
        onsessionclosed: (sid) => {
          console.log(`[MCP] Session closed: ${sid}`);
          sessions.delete(sid);
        },
      });

      await server.connect(transport);

      const body = await readRawBody(req);
      await transport.handleRequest(req, res, body);
    } else if (sessionId) {
      // Session ID provided but not in our map (stale/expired)
      res.status(404).json({ error: 'Session not found or expired' });
    } else {
      // GET/DELETE without session ID
      res.status(400).json({ error: 'Missing Mcp-Session-Id header' });
    }
  } catch (err) {
    console.error('[MCP] Request error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'MCP request failed', detail: err.message });
    }
  }
}

module.exports = { handleMcp, createMcpServer };
