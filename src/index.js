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
const { stripeWebhookHandler, revenueCatWebhookHandler } = require('./routes/stripe');
const widgetRouter = require('./routes/widget');
const snapshotsRouter = require('./routes/snapshots');
const scanUsageRouter = require('./routes/scan-usage');
const minVersionRouter = require('./routes/min-version');
const troyChatRouter = require('./routes/troy-chat');
const stackSignalRouter = require('./routes/stack-signal');
const socialRouter = require('./routes/social');
const dealerPricesRouter = require('./routes/dealerPrices');
const junkSilverRouter = require('./routes/junk-silver');
const apiKeysRouter = require('./routes/api-keys');
const { apiKeyAuth } = require('./middleware/api-key-auth');
const { handleMcp } = require('./routes/mcp');

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
// CORS — locked to troystack.ai + stacktrackergold.com domains
// LLM discovery endpoints allow all origins
// ============================================================
const ALLOWED_ORIGINS = [
  'https://stacktrackergold.com',
  'https://app.stacktrackergold.com',
  'https://www.stacktrackergold.com',
  'https://troystack.ai',
  'https://www.troystack.ai',
  'http://localhost:5173',
  'http://localhost:3000',
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

// ============================================================
// MCP (Model Context Protocol) — MUST come BEFORE express.json()
// The Streamable HTTP transport parses its own body so malformed/empty
// POST bodies don't get rejected by the global JSON parser. Single /mcp
// endpoint handles POST (client→server), GET (SSE stream), DELETE (session end).
// ============================================================
app.post('/mcp', cors(corsOptions), handleMcp);
app.get('/mcp', cors(corsOptions), handleMcp);
app.delete('/mcp', cors(corsOptions), handleMcp);

// Apply CORS and JSON parsing for everything else
app.use(cors(corsOptions));
app.use((req, res, next) => {
  // Skip JSON parsing for Stripe webhook (already handled above)
  if (req.originalUrl === '/v1/webhooks/stripe') return next();
  express.json({ limit: '20mb' })(req, res, next);
});

// JSON parse error handler — must run after express.json() and before routes
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Invalid JSON' });
  }
  next(err);
});

// Request logging
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.path}`);
  next();
});

// Global API key auth — permissive: validates keys if present, passes through if not.
// Does NOT replace authenticateApiKey for strict-auth routes (/v1/portfolio, etc).
app.use(apiKeyAuth);

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

// RevenueCat webhook — iOS subscription events (needs JSON body, so goes after express.json)
app.post('/v1/webhooks/revenuecat', revenueCatWebhookHandler);

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

// Minimum app version check — no auth, no rate limit
app.use('/v1/min-version', minVersionRouter);

// Troy Chat — persistent conversations (mobile app sends userId)
app.use('/v1/troy', publicLimiter, troyChatRouter);

// Stack Signal — curated precious metals news with Troy's commentary
app.use('/v1/stack-signal', publicLimiter, stackSignalRouter);

// Social features — views, likes, comments on Stack Signal articles
app.use('/v1/stack-signal', publicLimiter, socialRouter);

// Dealer price comparison
app.use('/v1/dealer-prices', publicLimiter, dealerPricesRouter);

// ── Temporary test route ──
// ?post=true to actually send to Twitter; default is dry-run
// ?generate=true to force Gemini generation even if tweet_text exists
app.get('/v1/test-tweet', async (req, res) => {
  try {
    const supabase = require('./lib/supabase');
    const { getClient } = require('./services/auto-tweet');
    const { generateTweetText, sanitizeTweetText } = require('./services/stack-signal-processor');
    const shouldPost = req.query.post === 'true';
    const forceGenerate = req.query.generate === 'true';

    // 1. Fetch most recent article
    const { data: articles } = await supabase
      .from('stack_signal_articles')
      .select('*')
      .order('published_at', { ascending: false })
      .limit(1);

    if (!articles || articles.length === 0) {
      return res.json({ error: 'No articles found' });
    }
    const article = articles[0];

    // 2. Get tweet text — prefer pre-generated unless ?generate=true
    let tweetText;
    let source;

    if (article.tweet_text && !forceGenerate) {
      tweetText = sanitizeTweetText(article.tweet_text) || article.tweet_text.trim();
      source = 'pre-generated (tweet_text column)';
    } else {
      tweetText = await generateTweetText(article.title, article.troy_commentary);
      source = tweetText ? 'gemini (live)' : 'title fallback';
      if (!tweetText) {
        tweetText = article.title.length > 200 ? article.title.substring(0, 200) + '...' : article.title;
      }
    }

    console.log(`[TestTweet] Source: ${source} | Tweet: ${tweetText}`);

    // 3. Append URL + trim to 280
    const url = `https://troystack.com/signal/${article.slug}`;
    const maxTextLen = 280 - 23 - 2;  // 23 = t.co auto-shortened URL, 2 = "\n\n"
    if (tweetText.length > maxTextLen) {
      tweetText = tweetText.substring(0, maxTextLen - 3) + '...';
    }
    const finalTweet = `${tweetText}\n\n${url}`;

    // 4. Optionally post
    let tweetId = null;
    if (shouldPost) {
      const twitter = getClient();
      if (!twitter) {
        return res.json({ error: 'X credentials not configured' });
      }
      const result = await twitter.v2.tweet(finalTweet);
      tweetId = result?.data?.id || null;
      console.log(`[TestTweet] Posted: ${tweetId}`);
    }

    res.json({
      article_title: article.title,
      stored_tweet_text: article.tweet_text || null,
      source,
      sanitized_tweet: tweetText,
      final_tweet: finalTweet,
      tweet_id: tweetId,
      posted: shouldPost && !!tweetId,
    });
  } catch (err) {
    console.error('[TestTweet] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Junk silver melt value calculator
app.use('/v1/junk-silver', publicLimiter, junkSilverRouter);

// API key management — Supabase JWT auth inside the router (not apiKeyAuth)
app.use('/v1/api-keys', publicLimiter, apiKeysRouter);

// MCP routes are mounted above (before express.json()) so the transport
// can parse its own body — see Streamable HTTP block near Stripe webhook.

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
    name: 'TroyStack API',
    version: '3.0.1',
    description: 'AI-powered precious metals portfolio tracking and market intelligence',
    docs: 'https://troystack.ai/developers',
    mcp: 'https://api.troystack.ai/.well-known/mcp.json',
    openapi: 'https://api.troystack.ai/openapi.json',
    llms: 'https://api.troystack.ai/llms.txt',
    sitemap: 'https://api.troystack.ai/sitemap.xml',
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
      social: {
        'POST /v1/stack-signal/articles/:id/view': 'Record article view',
        'POST /v1/stack-signal/articles/:id/like': 'Toggle like (userId required)',
        'GET /v1/stack-signal/articles/:id/likes': 'Get like count + user_liked',
        'POST /v1/stack-signal/articles/:id/comments': 'Post comment (userId required)',
        'GET /v1/stack-signal/articles/:id/comments': 'List comments',
      },
      dealer_prices: {
        'GET /v1/dealer-prices?metal=&weight=': 'Compare dealer prices for a product',
        'GET /v1/dealer-prices/products': 'List tracked products',
        'POST /v1/dealer-prices/click': 'Log affiliate click',
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
      signup: 'Generate API keys in TroyStack app → Settings → Developer Access'
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
  console.log(`\n🪙 TroyStack API running on port ${PORT}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('🧠 Gemini:', process.env.GEMINI_API_KEY ? 'ENABLED' : 'DISABLED');
  console.log('💳 Stripe:', process.env.STRIPE_SECRET_KEY ? 'ENABLED' : 'DISABLED');
  console.log('🔒 CORS: Locked to troystack.ai + stacktrackergold.com domains');
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
      const supabase = require('./lib/supabase');
      // Log cron fire count to prove how many times this executes per day
      const cronFireKey = `daily_brief_cron_fire_${new Date().toISOString().split('T')[0]}`;
      try {
        const { data: existingFire } = await supabase.from('app_state').select('value').eq('key', cronFireKey).single();
        const fireCount = existingFire ? (JSON.parse(existingFire.value).count || 0) + 1 : 1;
        await supabase.from('app_state').upsert({ key: cronFireKey, value: JSON.stringify({ count: fireCount, last_fired: new Date().toISOString() }) });
        console.log(`📝 [Daily Brief Cron] Fire count today: ${fireCount}`);
      } catch (fireErr) {
        console.log(`📝 [Daily Brief Cron] Fire count tracking failed: ${fireErr.message}`);
      }
      try {
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
            // Atomic lock: INSERT fails on unique constraint if another instance already claimed this user+day
            const lockKey = `daily_brief_lock_${user.id}_${new Date().toISOString().split('T')[0]}`;
            const { error: lockError } = await supabase
              .from('app_state')
              .insert({ key: lockKey, value: JSON.stringify({ locked_at: new Date().toISOString() }) });

            if (lockError) {
              console.log(`⏭️ [Daily Brief] Lock claim failed for ${user.id} — another instance won. Skipping.`);
              continue;
            }

            const result = await generateDailyBrief(user.id);
            try { await generatePortfolioIntelligence(user.id); } catch (piErr) { console.log(`🧠 [Portfolio Intelligence Cron] Skipped for ${user.id}: ${piErr.message}`); }
            success++;
            console.log(`📝 [Daily Brief Cron] ✅ ${success}/${goldUsers.length} — user ${user.id}`);

            // ── Clean daily brief push (Phase 2 rebuild) ──
            try {
              const { data: notifRow } = await supabase
                .from('notification_preferences')
                .select('daily_brief')
                .eq('user_id', user.id)
                .limit(1)
                .single();

              // Default to enabled if no preference row exists
              if (notifRow && notifRow.daily_brief === false) {
                console.log(`📝 [Daily Brief Push] Skipped ${user.id}: daily_brief disabled`);
              } else {
                const { data: tokenRow } = await supabase
                  .from('push_tokens')
                  .select('expo_push_token')
                  .eq('user_id', user.id)
                  .order('last_active', { ascending: false })
                  .limit(1)
                  .single();

                if (!tokenRow || !isValidExpoPushToken(tokenRow.expo_push_token)) {
                  console.log(`📝 [Daily Brief Push] Skipped ${user.id}: no valid token`);
                } else {
                  // Dedup: one push per user per day, no exceptions
                  const pushLockKey = `daily_push_${user.id}_${new Date().toISOString().split('T')[0]}`;
                  const { error: pushLockErr } = await supabase
                    .from('app_state')
                    .insert({ key: pushLockKey, value: JSON.stringify({ sent_at: new Date().toISOString() }) });

                  if (pushLockErr) {
                    console.log(`📝 [Daily Brief Push] Skipped ${user.id}: already sent today`);
                  } else {
                    // Body: first sentence of the brief. Nothing else. No fallbacks. No synthesis.
                    const firstSentence = result.brief.brief_text.split(/[.!]\s/)[0];
                    const body = firstSentence.length > 120 ? firstSentence.slice(0, 117) + '...' : firstSentence + '.';

                    await sendPush(tokenRow.expo_push_token, {
                      title: '☀️ Your daily brief from Troy is ready',
                      body: body,
                      data: { type: 'daily_brief', screen: 'DailyBrief' },
                      sound: 'default',
                    });
                    pushSent++;
                    console.log(`📝 [Daily Brief Push] ✅ Sent to ${user.id}`);
                  }
                }
              }
            } catch (pushErr) {
              console.error(`📝 [Daily Brief Push] Error for ${user.id}:`, pushErr.message);
            }
          } catch (err) {
            failed++;
            console.error(`📝 [Daily Brief Cron] ❌ user ${user.id}: ${err.message}`);
          }
          // 2s delay between users to avoid Expo rate limits
          if (goldUsers.indexOf(user) < goldUsers.length - 1) {
            await new Promise(r => setTimeout(r, 2000));
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

  // ── Price Alert Checker: every 5 minutes ──
  cron.schedule('*/5 * * * *', async () => {
    try {
      const { checkPriceAlerts } = require('./services/price-alert-checker');
      await checkPriceAlerts();
    } catch (err) {
      console.error('🔔 [Alert Checker] Error:', err.message);
    }
  }, { timezone: 'UTC' });
  console.log('🔔 [Alert Checker] Scheduled: every 5 minutes');

  // ── Stack Signal article processor: every 2 hours ──
  cron.schedule('0 */2 * * *', async () => {
    console.log(`\n📰 [Stack Signal Cron] Triggered at ${new Date().toISOString()}`);
    try {
      const { runStackSignalPipeline } = require('./services/stack-signal-processor');
      const result = await runStackSignalPipeline();
      console.log(`📰 [Stack Signal Cron] Done: ${result.saved} articles saved`);
    } catch (err) {
      console.error('📰 [Stack Signal Cron] Failed:', err.message);
    }
  }, { timezone: 'UTC' });
  console.log('📰 [Stack Signal Cron] Scheduled: every 2 hours');

  // ── Stack Signal daily synthesis: 6:15 AM EST (11:15 UTC) ──
  // Runs 20 min before Daily Brief so synthesis is ready for the combined morning push
  cron.schedule('15 11 * * *', async () => {
    console.log(`\n📰 [Stack Signal Daily] Triggered at ${new Date().toISOString()}`);
    try {
      const { generateStackSignal } = require('./services/stack-signal-processor');
      const result = await generateStackSignal();
      console.log(`📰 [Stack Signal Daily] Done: ${result ? result.slug : 'no synthesis generated'}`);
    } catch (err) {
      console.error('📰 [Stack Signal Daily] Failed:', err.message);
    }
  }, { timezone: 'UTC' });
  console.log('📰 [Stack Signal Daily] Scheduled: daily at 6:15 AM EST (11:15 UTC)');

  // ── Evening Stack Signal — post market close (4:30 PM EST / 21:30 UTC) ──
  cron.schedule('30 21 * * 1-5', async () => {
    console.log('⚡ [Stack Signal] Running evening post-close digest...');
    try {
      const { generateStackSignal } = require('./services/stack-signal-processor');
      await generateStackSignal('evening');
    } catch (err) {
      console.error('[Stack Signal] Evening digest failed:', err.message);
    }
  }, { timezone: 'UTC' });
  console.log('⚡ [Stack Signal Evening] Scheduled: weekdays at 4:30 PM EST (21:30 UTC)');

  // Friday Weekly Recap — 5:00 PM EST / 22:00 UTC on Fridays
  cron.schedule('0 22 * * 5', async () => {
    console.log('⚡ [Stack Signal] Running Friday weekly recap...');
    try {
      const { generateStackSignal } = require('./services/stack-signal-processor');
      await generateStackSignal('weekly_recap');
    } catch (err) {
      console.error('[Stack Signal] Weekly recap failed:', err.message);
    }
  }, { timezone: 'UTC' });
  console.log('⚡ [Stack Signal Weekly Recap] Scheduled: Fridays at 5:00 PM EST (22:00 UTC)');

  // Monday Weekly Preview — 6:15 AM EST / 11:15 UTC on Mondays
  cron.schedule('15 11 * * 1', async () => {
    console.log('⚡ [Stack Signal] Running Monday weekly preview...');
    try {
      const { generateStackSignal } = require('./services/stack-signal-processor');
      await generateStackSignal('weekly_preview');
    } catch (err) {
      console.error('[Stack Signal] Weekly preview failed:', err.message);
    }
  }, { timezone: 'UTC' });
  console.log('⚡ [Stack Signal Weekly Preview] Scheduled: Mondays at 6:15 AM EST (11:15 UTC)');

  // Weekly X thread — Sunday 6:00 PM EST / 22:00 UTC
  cron.schedule('0 22 * * 0', async () => {
    console.log('🐦 [Weekly Thread] Running Sunday weekly X thread...');
    try {
      const { generateAndPostWeeklyThread } = require('./services/weekly-thread');
      await generateAndPostWeeklyThread();
    } catch (err) {
      console.error('🐦 [Weekly Thread] Failed:', err.message);
    }
  }, { timezone: 'UTC' });
  console.log('🐦 [Weekly Thread] Scheduled: Sundays at 6:00 PM EST (22:00 UTC)');

  // Month-End Review — 5:00 PM EST / 22:00 UTC on last business day of month
  // Runs on 28th-31st, checks if tomorrow is a new month
  cron.schedule('0 22 28-31 * *', async () => {
    const tomorrow = new Date();
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    if (tomorrow.getUTCDate() !== 1) return; // Not last day of month
    console.log('⚡ [Stack Signal] Running month-end review...');
    try {
      const { generateStackSignal } = require('./services/stack-signal-processor');
      await generateStackSignal('monthly_recap');
    } catch (err) {
      console.error('[Stack Signal] Monthly recap failed:', err.message);
    }
  }, { timezone: 'UTC' });
  console.log('⚡ [Stack Signal Monthly Recap] Scheduled: last day of month at 5:00 PM EST (22:00 UTC)');

  // Year-End Review — 10:00 AM EST / 15:00 UTC on January 1
  cron.schedule('0 15 1 1 *', async () => {
    console.log('⚡ [Stack Signal] Running year-in-review...');
    try {
      const { generateStackSignal } = require('./services/stack-signal-processor');
      await generateStackSignal('yearly_recap');
    } catch (err) {
      console.error('[Stack Signal] Year-end review failed:', err.message);
    }
  }, { timezone: 'UTC' });
  console.log('⚡ [Stack Signal Year-End Review] Scheduled: January 1 at 10:00 AM EST (15:00 UTC)');

  // DISABLED: Dealer scraper cron — re-enable when affiliate integrations are ready
  // ── Dealer price scraping: every hour at :05 ──
  // cron.schedule('5 * * * *', async () => {
  //   console.log(`\n[DealerScraper Cron] Starting hourly scrape at ${new Date().toISOString()}`);
  //   try {
  //     const { getCachedPrices } = require('./services/price-fetcher');
  //     const { scrapeAllDealers } = require('./services/dealerScraper');
  //     const supabase = require('./lib/supabase');
  //
  //     const cached = getCachedPrices();
  //     const spotPrices = {
  //       gold: cached?.gold || null,
  //       silver: cached?.silver || null,
  //     };
  //
  //     const results = await scrapeAllDealers(spotPrices);
  //
  //     if (results.length === 0) {
  //       console.log('[DealerScraper Cron] No results scraped — skipping insert');
  //       return;
  //     }
  //
  //     const { error } = await supabase
  //       .from('dealer_prices')
  //       .insert(results);
  //
  //     if (error) {
  //       console.error('[DealerScraper Cron] Supabase insert error:', error.message);
  //     } else {
  //       console.log(`[DealerScraper Cron] Saved ${results.length} prices`);
  //     }
  //   } catch (err) {
  //     console.error('[DealerScraper Cron] Failed:', err.message);
  //   }
  // }, { timezone: 'UTC' });
  // console.log('[DealerScraper Cron] Scheduled: every hour at :05');
  console.log('[DealerScraper Cron] DISABLED — re-enable when affiliate integrations are ready');

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
});
