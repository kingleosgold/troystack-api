const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
require('dotenv').config();

const pricesRouter = require('./routes/prices');
const marketIntelRouter = require('./routes/market-intel');
const vaultWatchRouter = require('./routes/vault-watch');
const speculationRouter = require('./routes/speculation');
const portfolioRouter = require('./routes/portfolio');
const analyticsRouter = require('./routes/analytics');
const holdingsRouter = require('./routes/holdings');
const llmsRouter = require('./routes/llms');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(helmet());
app.use(cors());
app.use(express.json());

// Request logging
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.path}`);
  next();
});

// ============================================================
// PUBLIC ENDPOINTS (no auth required)
// ============================================================
app.use('/v1/prices', pricesRouter);
app.use('/v1/market-intel', marketIntelRouter);
app.use('/v1/vault-watch', vaultWatchRouter);
app.use('/v1/speculation', speculationRouter);

// LLM discoverability
app.use('/', llmsRouter);

// ============================================================
// AUTHENTICATED ENDPOINTS (API key required)
// ============================================================
const { authenticateApiKey } = require('./middleware/auth');
app.use('/v1/portfolio', authenticateApiKey, portfolioRouter);
app.use('/v1/analytics', authenticateApiKey, analyticsRouter);
app.use('/v1/holdings', authenticateApiKey, holdingsRouter);

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'stg-api', version: '1.0.0' });
});

// API root - documentation
app.get('/', (req, res) => {
  res.json({
    name: 'Stack Tracker Gold API',
    version: '1.0.0',
    description: 'Precious metals portfolio tracking, live spot prices, COMEX vault data, and market intelligence.',
    documentation: 'https://api.stacktrackergold.com/docs',
    endpoints: {
      public: {
        'GET /v1/prices': 'Live spot prices for Au, Ag, Pt, Pd',
        'GET /v1/prices/history?metal=silver&range=1M': 'Historical price data',
        'GET /v1/market-intel': 'Latest precious metals news and analysis',
        'GET /v1/vault-watch': 'COMEX warehouse inventory data',
        'GET /v1/speculation?silver=1000&gold=25000': 'What-if price projections',
      },
      authenticated: {
        'GET /v1/portfolio': 'User portfolio summary with live valuation',
        'GET /v1/analytics': 'Cost basis, break-even, allocation analysis',
        'POST /v1/holdings': 'Add a purchase to portfolio',
        'GET /v1/holdings': 'List all holdings',
      },
      llm: {
        'GET /llms.txt': 'LLM-readable app description',
        'GET /openapi.json': 'OpenAPI 3.0 specification',
        'GET /.well-known/ai-plugin.json': 'AI plugin manifest',
        'GET /.well-known/mcp.json': 'MCP server manifest',
      }
    },
    authentication: {
      type: 'Bearer token',
      header: 'Authorization: Bearer YOUR_API_KEY',
      signup: 'Generate API keys in Stack Tracker Gold app → Settings → Developer Access'
    }
  });
});

// 404
app.use((req, res) => {
  res.status(404).json({ error: 'Not found', path: req.path });
});

// Error handler
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`Stack Tracker Gold API running on port ${PORT}`);
});
