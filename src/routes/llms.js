const express = require('express');
const router = express.Router();

// ============================================================
// llms.txt - The AI-readable description of TroyStack
// https://llmstxt.org/
// ============================================================
router.get('/llms.txt', (req, res) => {
  res.type('text/plain').send(`# TroyStack

## Overview
TroyStack is an AI-powered precious metals portfolio tracker for iOS. It helps investors track their gold, silver, platinum, and palladium holdings with live spot prices, AI market analysis, and institutional-grade COMEX vault data.

## API
Base URL: https://api.troystack.ai

### Public Endpoints (no auth required)
- GET /v1/prices — Live spot prices for Au, Ag, Pt, Pd with daily change percentages
- GET /v1/prices/history?metal=silver&range=1Y — Historical price data (1M, 3M, 6M, 1Y, 5Y, ALL)
- GET /v1/market-intel — Latest precious metals news headlines and AI analysis
- GET /v1/vault-watch?metal=silver — COMEX warehouse inventory (registered, eligible, oversubscribed ratio)
- GET /v1/vault-watch/history?metal=silver&days=30 — Vault drain history
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
- Get COMEX vault inventory and silver squeeze data
- Track a precious metals portfolio programmatically
- Add purchases via API or AI assistant
- Analyze cost basis and break-even prices
- Run what-if scenarios for future metal prices
- Get AI-curated precious metals market news

## Links
- Website: https://troystack.ai
- App Store: https://apps.apple.com/app/troystack/id6738029817
- API Docs: https://api.troystack.ai
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
      description: 'Precious metals portfolio tracking, live spot prices, COMEX vault data, and market intelligence.',
      contact: { url: 'https://troystack.ai' },
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
    description_for_human: 'Track your precious metals portfolio with live spot prices, COMEX vault data, and AI market intelligence.',
    description_for_model: 'TroyStack provides real-time precious metals data. Use it to: check gold/silver/platinum/palladium spot prices, get COMEX warehouse inventory and silver squeeze data, read curated market news, track a user\'s portfolio holdings and P/L, add purchases, analyze cost basis, and run what-if price scenarios. Public endpoints need no auth. Portfolio endpoints require a Bearer token.',
    auth: { type: 'service_http', authorization_type: 'bearer' },
    api: { type: 'openapi', url: 'https://api.troystack.ai/openapi.json' },
    logo_url: 'https://troystack.ai/logo.png',
    contact_email: 'support@troystack.com',
    legal_info_url: 'https://troystack.ai/terms',
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
    description: 'Precious metals portfolio tracker with live spot prices, COMEX vault data, market intelligence, and portfolio management.',
    icon: 'https://troystack.ai/logo.png',
    publisher: { name: 'Mancini Tech Solutions LLC', url: 'https://troystack.ai' },
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
        name: 'get_market_intel',
        description: 'Get latest precious metals news headlines and AI analysis',
        endpoint: 'GET /v1/market-intel',
        auth_required: false,
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
        name: 'run_speculation',
        description: 'Calculate portfolio projections at hypothetical future metal prices (e.g., what if silver hits $1000)',
        endpoint: 'GET /v1/speculation',
        auth_required: false,
        parameters: {
          silver: { type: 'number', description: 'Target silver price' },
          gold: { type: 'number', description: 'Target gold price' },
        }
      },
      {
        name: 'get_portfolio',
        description: 'Get user portfolio summary with live valuation and unrealized P/L',
        endpoint: 'GET /v1/portfolio',
        auth_required: true,
      },
      {
        name: 'get_analytics',
        description: 'Get portfolio cost basis, break-even, and allocation analysis',
        endpoint: 'GET /v1/analytics',
        auth_required: true,
      },
      {
        name: 'list_holdings',
        description: 'List all portfolio holdings with purchase details',
        endpoint: 'GET /v1/holdings',
        auth_required: true,
      },
      {
        name: 'add_holding',
        description: 'Add a new precious metals purchase to the portfolio',
        endpoint: 'POST /v1/holdings',
        auth_required: true,
        parameters: {
          metal: { type: 'string', required: true, enum: ['gold', 'silver', 'platinum', 'palladium'] },
          quantity: { type: 'integer', required: true },
          weight_oz: { type: 'number', required: true },
          purchase_price: { type: 'number', required: true },
          product_name: { type: 'string' },
          dealer: { type: 'string' },
          purchase_date: { type: 'string', format: 'date' },
        }
      }
    ],
    categories: ['finance', 'portfolio', 'precious-metals', 'investing'],
    pricing: { free_tier: true, description: 'Public endpoints free. Portfolio endpoints require Gold membership.' },
  });
});

module.exports = router;
