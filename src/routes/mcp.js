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

const supabase = require('../lib/supabase');
const { getSpotPrices } = require('../services/price-fetcher');

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

  return server;
}

// ============================================
// STREAMABLE HTTP TRANSPORT
// Single shared transport multiplexes sessions internally via Mcp-Session-Id header
// ============================================

let _server = null;
let _transport = null;
let _initPromise = null;

async function ensureInit() {
  if (_server && _transport) return;
  if (_initPromise) return _initPromise;

  _initPromise = (async () => {
    _server = createMcpServer();
    _transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sessionId) => {
        console.log(`[MCP] Session initialized: ${sessionId}`);
      },
      onsessionclosed: (sessionId) => {
        console.log(`[MCP] Session closed: ${sessionId}`);
      },
    });
    await _server.connect(_transport);
    console.log('[MCP] Streamable HTTP transport ready');
  })();

  return _initPromise;
}

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
    await ensureInit();

    if (req.method === 'POST') {
      // Manually parse body — this route is mounted BEFORE express.json()
      // so malformed/empty bodies don't get rejected upstream
      const body = await readRawBody(req);
      await _transport.handleRequest(req, res, body);
    } else {
      // GET (SSE stream) and DELETE (session end) don't need a body
      await _transport.handleRequest(req, res);
    }
  } catch (err) {
    console.error('[MCP] Request error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'MCP request failed', detail: err.message });
    }
  }
}

module.exports = { handleMcp, createMcpServer };
