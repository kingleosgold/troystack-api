const express = require('express');
const router = express.Router();

// ============================================================
// robots.txt — allow AI crawlers to discover discovery endpoints
// ============================================================
router.get('/robots.txt', (req, res) => {
  res.type('text/plain').send(`# AI Crawlers
User-agent: ChatGPT-User
Allow: /

User-agent: Claude-Web
Allow: /

User-agent: PerplexityBot
Allow: /

User-agent: *
Allow: /.well-known/
Allow: /llms.txt
Allow: /openapi.json
Allow: /sitemap.xml

Sitemap: https://api.troystack.ai/sitemap.xml
`);
});

// ============================================================
// sitemap.xml — lists all public endpoints for crawler discovery
// ============================================================
router.get('/sitemap.xml', (req, res) => {
  const base = 'https://api.troystack.ai';
  const lastmod = new Date().toISOString().split('T')[0];
  const urls = [
    '/',
    '/health',
    '/llms.txt',
    '/openapi.json',
    '/.well-known/ai-plugin.json',
    '/.well-known/mcp.json',
    '/.well-known/mcp/server-card.json',
    '/v1/prices',
    '/v1/prices/history',
    '/v1/market-intel',
    '/v1/vault-watch',
    '/v1/vault-watch/history',
    '/v1/speculation',
    '/v1/stack-signal',
    '/v1/stack-signal/latest',
    '/v1/junk-silver',
    '/v1/dealer-prices',
    '/v1/dealer-prices/products',
  ];

  const body = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map(u => `  <url>
    <loc>${base}${u}</loc>
    <lastmod>${lastmod}</lastmod>
    <changefreq>daily</changefreq>
  </url>`).join('\n')}
</urlset>
`;

  res.type('application/xml').send(body);
});

// ============================================================
// llms.txt - The AI-readable description of TroyStack
// https://llmstxt.org/
// ============================================================
router.get('/llms.txt', (req, res) => {
  res.type('text/plain').send(`# TroyStack

## Overview
TroyStack is an AI-powered precious metals portfolio tracking and market intelligence platform. It helps investors track their gold, silver, platinum, and palladium holdings with live spot prices, AI-curated Stack Signal market analysis, institutional-grade COMEX vault data, and junk silver melt value tools.

## API
Base URL: https://api.troystack.ai

### Public Endpoints (no auth required)
- GET /v1/prices — Live spot prices for Au, Ag, Pt, Pd with daily change percentages
- GET /v1/prices/history?metal=silver&range=1Y — Historical price data (1M, 3M, 6M, 1Y, 5Y, ALL)
- GET /v1/stack-signal — Latest Stack Signal market intelligence articles (Troy's curated precious metals analysis)
- GET /v1/stack-signal/latest — Most recent Stack Signal daily synthesis editorial
- GET /v1/market-intel — Latest precious metals news headlines
- GET /v1/vault-watch?metal=silver — COMEX warehouse inventory (registered, eligible, oversubscribed ratio)
- GET /v1/vault-watch/history?metal=silver&days=30 — Vault drain history
- GET /v1/junk-silver?dimes=50&quarters=40 — Pre-1965 US coin melt value calculator
- GET /v1/speculation?silver=1000&gold=25000 — What-if price scenario projections

### Authenticated Endpoints (Bearer token required)
- GET /v1/portfolio — User's portfolio summary with live valuation and unrealized P/L
- GET /v1/analytics — Cost basis, break-even, allocation analysis per metal
- GET /v1/holdings — List all holdings with purchase details
- POST /v1/holdings — Add a new purchase (metal, quantity, weight_oz, purchase_price)

### Authentication
API keys are generated in the TroyStack iOS app under Settings → Developer Access.
Include as: Authorization: Bearer YOUR_API_KEY

## MCP Server
TroyStack is available as an MCP (Model Context Protocol) tool server.
Manifest: https://api.troystack.ai/.well-known/mcp.json

## Use Cases
- Check current gold and silver prices
- Read Troy's Stack Signal market intelligence and daily editorials
- Get COMEX vault inventory and silver squeeze data
- Calculate melt value of pre-1965 US junk silver coins
- Track a precious metals portfolio programmatically
- Analyze cost basis and break-even prices
- Run what-if scenarios for future metal prices

## Links
- Website: https://troystack.com
- App Store: https://apps.apple.com/app/troystack/id6738029817
- API Docs: https://api.troystack.ai
- Contact: support@troystack.com
`);
});

// ============================================================
// OpenAPI 3.0 specification
// ============================================================
router.get('/openapi.json', (req, res) => {
  res.json({
    openapi: '3.0.3',
    info: {
      title: 'TroyStack API',
      version: '1.0.0',
      description: 'AI-powered precious metals portfolio tracking and market intelligence. Live spot prices, COMEX vault data, Stack Signal editorial, and junk silver melt value tools.',
      contact: { url: 'https://troystack.com', email: 'support@troystack.com' },
    },
    servers: [{ url: 'https://api.troystack.ai' }],
    paths: {
      '/v1/prices': {
        get: {
          summary: 'Get live spot prices',
          description: 'Returns current spot prices for gold, silver, platinum, and palladium with daily change percentages.',
          operationId: 'getPrices',
          tags: ['Prices'],
          responses: {
            '200': { description: 'Live spot prices for all 4 metals' }
          }
        }
      },
      '/v1/prices/history': {
        get: {
          summary: 'Get historical prices',
          operationId: 'getPriceHistory',
          tags: ['Prices'],
          parameters: [
            { name: 'metal', in: 'query', schema: { type: 'string', enum: ['gold', 'silver', 'platinum', 'palladium'] }, required: true },
            { name: 'range', in: 'query', schema: { type: 'string', enum: ['1M', '3M', '6M', '1Y', '5Y', 'ALL'] } }
          ],
          responses: { '200': { description: 'Historical price data' } }
        }
      },
      '/v1/stack-signal': {
        get: {
          summary: 'Get Stack Signal articles',
          description: 'Returns curated Stack Signal precious metals intelligence articles with Troy\'s commentary.',
          operationId: 'getStackSignal',
          tags: ['Stack Signal'],
          parameters: [
            { name: 'limit', in: 'query', schema: { type: 'integer', default: 20, minimum: 1, maximum: 50 } },
            { name: 'offset', in: 'query', schema: { type: 'integer', default: 0 } },
            { name: 'category', in: 'query', schema: { type: 'string' } }
          ],
          responses: { '200': { description: 'Stack Signal articles with Troy commentary and source references' } }
        }
      },
      '/v1/stack-signal/latest': {
        get: {
          summary: 'Get latest Stack Signal synthesis',
          description: 'Returns the most recent Stack Signal daily synthesis editorial.',
          operationId: 'getStackSignalLatest',
          tags: ['Stack Signal'],
          responses: { '200': { description: 'Latest daily synthesis article' } }
        }
      },
      '/v1/market-intel': {
        get: {
          summary: 'Get market intelligence',
          description: 'Returns latest precious metals news headlines with AI analysis and category tags.',
          operationId: 'getMarketIntel',
          tags: ['Market Intelligence'],
          parameters: [
            { name: 'limit', in: 'query', schema: { type: 'integer', default: 20 } },
            { name: 'category', in: 'query', schema: { type: 'string', enum: ['BREAKING', 'SUPPLY_DEMAND', 'CENTRAL_BANK', 'POLICY', 'MINING', 'INVESTMENT', 'GEOPOLITICAL', 'ANALYSIS'] } }
          ],
          responses: { '200': { description: 'Market intelligence articles' } }
        }
      },
      '/v1/vault-watch': {
        get: {
          summary: 'Get COMEX vault data',
          description: 'Returns real-time COMEX warehouse inventory including registered, eligible ounces, daily drains, and oversubscribed ratios.',
          operationId: 'getVaultWatch',
          tags: ['Vault Watch'],
          parameters: [
            { name: 'metal', in: 'query', schema: { type: 'string', enum: ['gold', 'silver', 'platinum', 'palladium'], default: 'silver' } }
          ],
          responses: { '200': { description: 'COMEX warehouse inventory data' } }
        }
      },
      '/v1/junk-silver': {
        get: {
          summary: 'Junk silver melt value calculator',
          description: 'Calculates silver melt value for pre-1965 US coinage. All quantity params are optional non-negative integers.',
          operationId: 'getJunkSilver',
          tags: ['Tools'],
          parameters: [
            { name: 'dimes', in: 'query', schema: { type: 'integer', minimum: 0 }, description: 'Roosevelt/Mercury dimes (0.07234 oz Ag each)' },
            { name: 'quarters', in: 'query', schema: { type: 'integer', minimum: 0 }, description: 'Washington quarters (0.18084 oz Ag each)' },
            { name: 'half_dollars', in: 'query', schema: { type: 'integer', minimum: 0 }, description: 'Walking Liberty/Franklin/Kennedy 1964 half dollars (0.36169 oz Ag each)' },
            { name: 'kennedy_40', in: 'query', schema: { type: 'integer', minimum: 0 }, description: 'Kennedy 1965-1970 40% silver halves (0.14792 oz Ag each)' },
            { name: 'dollars', in: 'query', schema: { type: 'integer', minimum: 0 }, description: 'Morgan/Peace dollars (0.77344 oz Ag each)' },
            { name: 'war_nickels', in: 'query', schema: { type: 'integer', minimum: 0 }, description: 'Jefferson 1942-1945 war nickels (0.05626 oz Ag each)' }
          ],
          responses: { '200': { description: 'Melt value breakdown by coin type + totals' } }
        }
      },
      '/v1/speculation': {
        get: {
          summary: 'What-if price projections',
          description: 'Calculate projected portfolio value at hypothetical future metal prices.',
          operationId: 'getSpeculation',
          tags: ['Tools'],
          parameters: [
            { name: 'silver', in: 'query', schema: { type: 'number' }, description: 'Target silver price per oz' },
            { name: 'gold', in: 'query', schema: { type: 'number' }, description: 'Target gold price per oz' },
            { name: 'platinum', in: 'query', schema: { type: 'number' } },
            { name: 'palladium', in: 'query', schema: { type: 'number' } }
          ],
          responses: { '200': { description: 'Price projections with multipliers' } }
        }
      },
      '/v1/portfolio': {
        get: {
          summary: 'Get portfolio summary',
          description: 'Returns authenticated user\'s portfolio with live valuation, cost basis, and unrealized P/L.',
          operationId: 'getPortfolio',
          tags: ['Portfolio'],
          security: [{ bearerAuth: [] }],
          responses: { '200': { description: 'Portfolio summary' }, '401': { description: 'Authentication required' } }
        }
      },
      '/v1/holdings': {
        get: {
          summary: 'List holdings',
          operationId: 'getHoldings',
          tags: ['Portfolio'],
          security: [{ bearerAuth: [] }],
          responses: { '200': { description: 'List of holdings' } }
        },
        post: {
          summary: 'Add a purchase',
          operationId: 'addHolding',
          tags: ['Portfolio'],
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['metal', 'quantity', 'weight_oz', 'purchase_price'],
                  properties: {
                    metal: { type: 'string', enum: ['gold', 'silver', 'platinum', 'palladium'] },
                    product_name: { type: 'string', example: '2024 American Silver Eagle' },
                    quantity: { type: 'integer', example: 20 },
                    weight_oz: { type: 'number', example: 1.0 },
                    purchase_price: { type: 'number', example: 35.50, description: 'Price per unit' },
                    dealer: { type: 'string', example: 'APMEX' },
                    purchase_date: { type: 'string', format: 'date', example: '2024-11-21' },
                  }
                }
              }
            }
          },
          responses: { '201': { description: 'Holding created' } }
        }
      },
      '/v1/analytics': {
        get: {
          summary: 'Portfolio analytics',
          description: 'Cost basis, break-even analysis, and allocation per metal.',
          operationId: 'getAnalytics',
          tags: ['Portfolio'],
          security: [{ bearerAuth: [] }],
          responses: { '200': { description: 'Analytics data' } }
        }
      }
    },
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', description: 'API key from TroyStack app' }
      }
    }
  });
});

// ============================================================
// AI Plugin manifest (ChatGPT / OpenAI format)
// ============================================================
router.get('/.well-known/ai-plugin.json', (req, res) => {
  res.json({
    schema_version: 'v1',
    name_for_human: 'TroyStack',
    name_for_model: 'troystack',
    description_for_human: 'AI-powered precious metals portfolio tracking and market intelligence.',
    description_for_model: 'TroyStack provides AI-powered precious metals portfolio tracking and market intelligence. Use it to: check gold/silver/platinum/palladium spot prices, read Stack Signal market intelligence articles and daily synthesis editorials, get COMEX warehouse inventory and silver squeeze data, calculate melt value of pre-1965 US junk silver coins, track a user\'s portfolio holdings and P/L, analyze cost basis, and run what-if price scenarios. Public endpoints need no auth. Portfolio endpoints require a Bearer token.',
    auth: { type: 'service_http', authorization_type: 'bearer' },
    api: { type: 'openapi', url: 'https://api.troystack.ai/openapi.json' },
    logo_url: 'https://troystack.com/logo.png',
    contact_email: 'support@troystack.com',
    legal_info_url: 'https://troystack.com/terms',
  });
});

// ============================================================
// MCP Server manifest
// ============================================================
router.get('/.well-known/mcp.json', (req, res) => {
  res.json({
    schema_version: '1.0',
    name: 'troystack',
    display_name: 'TroyStack',
    description: 'AI-powered precious metals portfolio tracking and market intelligence',
    icon: 'https://troystack.com/logo.png',
    publisher: { name: 'Mancini Tech Solutions LLC', url: 'https://troystack.com' },
    contact_email: 'support@troystack.com',
    api_base_url: 'https://api.troystack.ai',
    tools: [
      {
        name: 'get_spot_prices',
        description: 'Get live spot prices for gold, silver, platinum, and palladium',
        endpoint: 'GET /v1/prices',
        auth_required: false,
      },
      {
        name: 'get_price_history',
        description: 'Get historical price data for a metal over a time range',
        endpoint: 'GET /v1/prices/history',
        auth_required: false,
        parameters: {
          metal: { type: 'string', required: true, enum: ['gold', 'silver', 'platinum', 'palladium'] },
          range: { type: 'string', enum: ['1M', '3M', '6M', '1Y', '5Y', 'ALL'] },
        }
      },
      {
        name: 'get_stack_signal',
        description: 'Get the latest Stack Signal market intelligence articles — Troy\'s curated precious metals analysis with commentary and sourced reporting',
        endpoint: 'GET /v1/stack-signal',
        auth_required: false,
        parameters: {
          limit: { type: 'integer', description: 'Max articles to return (1-50)', default: 20 },
          offset: { type: 'integer', description: 'Pagination offset', default: 0 },
          category: { type: 'string', description: 'Filter by article category' },
        }
      },
      {
        name: 'get_vault_watch',
        description: 'Get COMEX warehouse inventory data including registered/eligible ounces and oversubscribed ratio',
        endpoint: 'GET /v1/vault-watch',
        auth_required: false,
        parameters: {
          metal: { type: 'string', enum: ['gold', 'silver', 'platinum', 'palladium'] },
        }
      },
      {
        name: 'get_junk_silver',
        description: 'Calculate silver melt value for pre-1965 US coinage (dimes, quarters, half dollars, Kennedy 40% halves, Morgan/Peace dollars, war nickels)',
        endpoint: 'GET /v1/junk-silver',
        auth_required: false,
        parameters: {
          dimes: { type: 'integer', description: 'Roosevelt/Mercury dime count' },
          quarters: { type: 'integer', description: 'Washington quarter count' },
          half_dollars: { type: 'integer', description: 'Walking Liberty/Franklin/1964 Kennedy half count' },
          kennedy_40: { type: 'integer', description: 'Kennedy 1965-1970 (40% silver) half count' },
          dollars: { type: 'integer', description: 'Morgan/Peace silver dollar count' },
          war_nickels: { type: 'integer', description: '1942-1945 Jefferson war nickel count' },
        }
      },
      {
        name: 'get_speculation',
        description: 'Calculate portfolio projections at hypothetical future metal prices (e.g., what if silver hits $1000)',
        endpoint: 'GET /v1/speculation',
        auth_required: false,
        parameters: {
          silver: { type: 'number', description: 'Target silver price per oz' },
          gold: { type: 'number', description: 'Target gold price per oz' },
          platinum: { type: 'number', description: 'Target platinum price per oz' },
          palladium: { type: 'number', description: 'Target palladium price per oz' },
        }
      }
    ],
    categories: ['finance', 'portfolio', 'precious-metals', 'investing'],
    pricing: { free_tier: true, description: 'Public endpoints free. Portfolio endpoints require Gold membership.' },
  });
});

// ============================================================
// MCP Server Card — discoverable metadata for MCP registries
// Distinct path from /.well-known/mcp.json (which is the tool manifest)
// ============================================================
router.get('/.well-known/mcp/server-card.json', (req, res) => {
  res.json({
    name: 'TroyStack',
    description: 'AI-powered precious metals data — live spot prices, COMEX vault inventory, market intelligence, junk silver calculator, and historical price data',
    url: 'https://api.troystack.ai/mcp',
    transport: 'streamable-http',
    version: '3.0.1',
    tools: [
      { name: 'get_spot_prices', description: 'Live gold, silver, platinum, palladium spot prices' },
      { name: 'get_price_history', description: 'Historical price data with configurable range' },
      { name: 'get_stack_signal', description: 'AI-generated precious metals market intelligence articles' },
      { name: 'get_vault_watch', description: 'COMEX warehouse inventory data' },
      { name: 'get_junk_silver', description: 'Pre-1965 US coin silver melt value calculator' },
      { name: 'get_speculation', description: 'What-if price scenario calculator' },
    ],
    contact: 'support@troystack.com',
    website: 'https://troystack.com',
    logo: 'https://troystack.com/logo.png',
  });
});

// ============================================================
// OAuth Protected Resource metadata — signals "no auth required"
// Empty authorization_servers array per MCP OAuth spec
// ============================================================
const oauthProtectedResource = {
  resource: 'https://api.troystack.ai/mcp',
  authorization_servers: [],
};

router.get('/.well-known/oauth-protected-resource', (req, res) => {
  res.type('application/json').json(oauthProtectedResource);
});

router.get('/.well-known/oauth-protected-resource/mcp', (req, res) => {
  res.type('application/json').json(oauthProtectedResource);
});

module.exports = router;
