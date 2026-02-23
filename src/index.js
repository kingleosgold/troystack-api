const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const cron = require('node-cron');
require('dotenv').config();

const pricesRouter = require('./routes/prices');
const marketIntelRouter = require('./routes/market-intel');
const vaultWatchRouter = require('./routes/vault-watch');
const speculationRouter = require('./routes/speculation');
const portfolioRouter = require('./routes/portfolio');
const analyticsRouter = require('./routes/analytics');
const holdingsRouter = require('./routes/holdings');
const llmsRouter = require('./routes/llms');
const intelligenceRouter = require('./routes/intelligence');
const scanReceiptRouter = require('./routes/scan-receipt');
const pushRouter = require('./routes/push');
const legalRouter = require('./routes/legal');
const stripeRouter = require('./routes/stripe');
const { stripeWebhookHandler } = require('./routes/stripe');
const widgetRouter = require('./routes/widget');
const snapshotsRouter = require('./routes/snapshots');
const scanUsageRouter = require('./routes/scan-usage');

const { initPriceFetcher, fetchLiveSpotPrices, logPriceToSupabase, areMarketsClosed } = require('./services/price-fetcher');
const { publicLimiter, authenticatedLimiter, developerLimiter } = require('./middleware/rateLimit');

const app = express();
const PORT = process.env.PORT || 3000;

// Trust proxy for correct client IP detection (Railway, etc.)
app.set('trust proxy', 1);

// Security headers
app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" },
  contentSecurityPolicy: false,
}));

// ============================================================
// CORS — locked to stacktrackergold.com domains
// LLM discovery endpoints allow all origins
// ============================================================
const ALLOWED_ORIGINS = [
  'https://stacktrackergold.com',
  'https://app.stacktrackergold.com',
  'https://www.stacktrackergold.com',
];

const corsOptions = {
  origin: (origin, callback) => {
    // Allow requests with no origin (mobile apps, curl, server-to-server)
    if (!origin) return callback(null, true);
    if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
    callback(new Error('Not allowed by CORS'));
  },
  methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Origin', 'X-Requested-With', 'Content-Type', 'Accept', 'Authorization', 'X-API-Key', 'Stripe-Signature'],
};

// LLM discovery endpoints — open CORS
const openCors = cors();

// ============================================================
// STRIPE WEBHOOK — MUST come BEFORE express.json()
// Needs raw body for signature verification
// ============================================================
app.post('/v1/webhooks/stripe', cors(corsOptions), express.raw({ type: 'application/json' }), stripeWebhookHandler);

// Apply CORS and JSON parsing for everything else
app.use(cors(corsOptions));
app.use((req, res, next) => {
  // Skip JSON parsing for Stripe webhook (already handled above)
  if (req.originalUrl === '/v1/webhooks/stripe') return next();
  express.json({ limit: '20mb' })(req, res, next);
});

// Request logging
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.path}`);
  next();
});

// ============================================================
// PUBLIC ENDPOINTS (no auth required)
// Rate limit: 100 requests/min per IP
// ============================================================
app.use('/v1/prices', publicLimiter, pricesRouter);
app.use('/v1', publicLimiter, pricesRouter); // historical-spot route
app.use('/v1/market-intel', publicLimiter, marketIntelRouter);
app.use('/v1/vault-watch', publicLimiter, vaultWatchRouter);
app.use('/v1/speculation', publicLimiter, speculationRouter);

// LLM discoverability — open CORS, public rate limit
app.use('/', openCors, publicLimiter, llmsRouter);

// ============================================================
// AUTHENTICATED ENDPOINTS (API key required)
// Rate limit: 30 requests/min per user + tier-based developer limits
// ============================================================
const { authenticateApiKey } = require('./middleware/auth');
app.use('/v1/portfolio', authenticateApiKey, authenticatedLimiter, developerLimiter, portfolioRouter);
app.use('/v1/analytics', authenticateApiKey, authenticatedLimiter, developerLimiter, analyticsRouter);
app.use('/v1/holdings', authenticateApiKey, authenticatedLimiter, developerLimiter, holdingsRouter);

// ============================================================
// NEW SERVICES — Intelligence, Daily Brief, Advisor
// ============================================================
app.use('/v1/intelligence', publicLimiter, intelligenceRouter);
app.use('/v1', publicLimiter, intelligenceRouter); // daily-brief + advisor + portfolio-intelligence routes

// Receipt scanner — authenticated endpoint
app.use('/v1/scan-receipt', authenticatedLimiter, scanReceiptRouter);

// Push notifications — public (mobile app sends tokens)
app.use('/v1/push', publicLimiter, pushRouter);

// Stripe billing (non-webhook routes)
app.use('/v1/stripe', publicLimiter, stripeRouter);

// Subscription sync (GET /v1/sync-subscription)
app.use('/v1', publicLimiter, stripeRouter);

// Widget data + sparklines — public (iOS widget fetches directly)
app.use('/v1', publicLimiter, widgetRouter);

// Portfolio snapshots — public (mobile app saves/reads)
app.use('/v1/snapshots', publicLimiter, snapshotsRouter);

// Scan usage tracking — public (mobile app checks limits)
app.use('/v1', publicLimiter, scanUsageRouter);

// Legal pages — open CORS, public
app.use('/', openCors, legalRouter);

// ============================================================
// HEALTH + API ROOT
// ============================================================
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'stg-api',
    version: '1.0.0',
    stripe: !!process.env.STRIPE_SECRET_KEY,
    gemini: !!process.env.GEMINI_API_KEY,
  });
});

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
      intelligence: {
        'POST /v1/intelligence/generate': 'Trigger intelligence generation (API key required)',
        'GET /v1/daily-brief?userId=xxx': 'Get today\'s daily brief for a user',
        'POST /v1/daily-brief/generate': 'Generate daily brief for a user',
        'POST /v1/advisor/chat': 'AI Stack Advisor chat',
        'POST /v1/scan-receipt': 'Scan receipt image for holdings data',
      },
      push: {
        'POST /v1/push/register': 'Register Expo push token',
        'DELETE /v1/push/delete': 'Remove push token',
        'POST /v1/push/price-alerts': 'Create price alert',
        'GET /v1/push/price-alerts': 'Get price alerts',
      },
      billing: {
        'POST /v1/stripe/create-checkout-session': 'Create Stripe checkout',
        'POST /v1/stripe/verify-session': 'Verify checkout session',
        'POST /v1/webhooks/stripe': 'Stripe webhook',
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

// ============================================================
// STARTUP + CRON SCHEDULES
// ============================================================
app.listen(PORT, () => {
  console.log(`\n🪙 Stack Tracker Gold API running on port ${PORT}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('🧠 Gemini:', process.env.GEMINI_API_KEY ? 'ENABLED' : 'DISABLED');
  console.log('💳 Stripe:', process.env.STRIPE_SECRET_KEY ? 'ENABLED' : 'DISABLED');
  console.log('🔒 CORS: Locked to stacktrackergold.com domains');
  console.log('⚡ Rate Limits: Public 100/min, Auth 30/min, Dev tier-based');

  // ── Intelligence cron: daily at 6:30 AM EST (11:30 UTC) ──
  if (process.env.GEMINI_API_KEY) {
    cron.schedule('30 11 * * *', async () => {
      console.log(`\n🧠 [Intelligence Cron] Triggered at ${new Date().toISOString()}`);
      try {
        const { runIntelligenceGeneration } = require('./routes/intelligence');
        const result = await runIntelligenceGeneration();
        console.log(`🧠 [Intelligence Cron] Done: ${result.briefsInserted} briefs, ${result.vaultInserted}/4 vault`);
      } catch (err) {
        console.error(`🧠 [Intelligence Cron] Failed:`, err.message);
      }
    }, { timezone: 'UTC' });
    console.log('🧠 [Intelligence Cron] Scheduled: daily at 6:30 AM EST (11:30 UTC)');

    // ── Daily Brief cron: 6:35 AM EST (11:35 UTC) ──
    cron.schedule('35 11 * * *', async () => {
      console.log(`\n📝 [Daily Brief Cron] Triggered at ${new Date().toISOString()}`);
      try {
        const supabase = require('./lib/supabase');
        const { generateDailyBrief, generatePortfolioIntelligence } = require('./routes/intelligence');
        const { sendPush, isValidExpoPushToken } = require('./routes/push');

        const { data: goldUsers, error } = await supabase
          .from('profiles')
          .select('id')
          .in('subscription_tier', ['gold', 'lifetime']);

        if (error || !goldUsers) {
          console.error('📝 [Daily Brief Cron] Failed to fetch Gold users:', error?.message);
          return;
        }

        console.log(`📝 [Daily Brief Cron] Generating briefs for ${goldUsers.length} Gold/Lifetime users`);
        let success = 0;
        let failed = 0;
        let pushSent = 0;

        for (const user of goldUsers) {
          try {
            const result = await generateDailyBrief(user.id);
            try { await generatePortfolioIntelligence(user.id); } catch (piErr) { console.log(`🧠 [Portfolio Intelligence Cron] Skipped for ${user.id}: ${piErr.message}`); }
            success++;
            console.log(`📝 [Daily Brief Cron] ✅ ${success}/${goldUsers.length} — user ${user.id}`);

            // Send push notification
            if (result && result.brief && result.brief.brief_text) {
              try {
                const { data: notifPref } = await supabase
                  .from('notification_preferences')
                  .select('daily_brief')
                  .eq('user_id', user.id)
                  .single();
                const briefEnabled = !notifPref || notifPref.daily_brief !== false;

                if (briefEnabled) {
                  const { data: tokenData } = await supabase
                    .from('push_tokens')
                    .select('expo_push_token')
                    .eq('user_id', user.id)
                    .order('last_active', { ascending: false })
                    .limit(1)
                    .single();

                  if (tokenData && isValidExpoPushToken(tokenData.expo_push_token)) {
                    const firstSentence = result.brief.brief_text.split(/[.!]\s/)[0];
                    const body = firstSentence.length > 100 ? firstSentence.slice(0, 97) + '...' : firstSentence;
                    await sendPush(tokenData.expo_push_token, {
                      title: 'Your daily brief from Troy is ready',
                      body,
                      data: { type: 'daily_brief' },
                      sound: 'default',
                    });
                    pushSent++;
                  }
                }
              } catch (pushErr) {
                console.log(`📝 [Daily Brief Cron] Push skipped for ${user.id}: ${pushErr.message}`);
              }
            }
          } catch (err) {
            failed++;
            console.error(`📝 [Daily Brief Cron] ❌ user ${user.id}: ${err.message}`);
          }
        }

        console.log(`📝 [Daily Brief Cron] Done: ${success} success, ${failed} failed, ${pushSent} push sent out of ${goldUsers.length}`);
      } catch (err) {
        console.error('📝 [Daily Brief Cron] Failed:', err.message);
      }
    }, { timezone: 'UTC' });
    console.log('📝 [Daily Brief Cron] Scheduled: daily at 6:35 AM EST (11:35 UTC)');
  } else {
    console.log('🧠 Intelligence Cron: DISABLED (no GEMINI_API_KEY)');
    console.log('📝 Daily Brief Cron: DISABLED (no GEMINI_API_KEY)');
  }

  // ── COMEX XLS Scraper cron: 6:00 PM EST (23:00 UTC) ──
  cron.schedule('0 23 * * *', async () => {
    console.log(`\n🏦 [COMEX Cron] Triggered at ${new Date().toISOString()}`);
    try {
      const { scrapeComexVaultData } = require('./services/comex-scraper');
      const result = await scrapeComexVaultData();
      console.log(`🏦 [COMEX Cron] Done: ${result.inserted}/4 metals`);
    } catch (err) {
      console.error('🏦 [COMEX Cron] Failed:', err.message);
    }
  }, { timezone: 'UTC' });
  console.log('🏦 [COMEX Cron] Scheduled: daily at 6:00 PM EST (23:00 UTC)');

  // ── Price Fetcher: init on startup + 15-minute price_log cron ──
  initPriceFetcher().then(() => {
    console.log('💰 [Price Fetcher] Initialized (cache warmed, Friday close loaded)');
  }).catch(err => {
    console.error('💰 [Price Fetcher] Init error:', err.message);
  });

  cron.schedule('*/15 * * * *', async () => {
    if (areMarketsClosed()) {
      console.log(`💰 [Price Log Cron] ${new Date().toISOString()} — Markets closed, skipping`);
      return;
    }
    try {
      const result = await fetchLiveSpotPrices();
      if (result && result.prices) {
        await logPriceToSupabase(result);
        console.log(`💰 [Price Log] ${new Date().toISOString()} — ${result.source} — Au:$${result.prices.gold} Ag:$${result.prices.silver}`);
      }
    } catch (err) {
      console.error('💰 [Price Log Cron] Error:', err.message);
    }
  }, { timezone: 'UTC' });
  console.log('💰 [Price Log Cron] Scheduled: every 15 minutes');

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
});
