# TroyStack API — Codebase Reference

> **Standing instruction:** If any task creates, deletes, or moves files, routes, or database columns, update this file before committing.

Express 5 REST API powering the TroyStack precious metals portfolio app. Deployed on Railway. Database on Supabase (PostgreSQL). Node >=20.

---

## 1. API Routes

### src/index.js
- **Purpose:** Express app entry point — CORS, middleware, route mounting, 13 cron jobs
- **Exports:** None (starts server)
- **Dependencies:** All route/service/middleware modules, dotenv, express, cors, helmet, node-cron
- **Last modified:** 2026-03-26

### src/routes/prices.js
- **Purpose:** Live and historical precious metals spot prices
- **Exports:** Express router
- **Dependencies:** supabase, axios, price-fetcher, etf-prices, historical-prices.json
- **Last modified:** 2026-02-23

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | /v1/prices | Public | Current spot prices (Au, Ag, Pt, Pd) with daily % change |
| GET | /v1/prices/history | Public | Historical price data; params: metal, range (1M–ALL), maxPoints |
| GET | /v1/historical-spot | Public | Single-date spot lookup with 5-tier fallback (price_log → ETF → MetalPriceAPI → MacroTrends) |
| POST | /v1/historical-spot-batch | Public | Batch date lookup (max 100 dates) |

### src/routes/market-intel.js
- **Purpose:** Precious metals news headlines from intelligence briefs + breaking alerts
- **Exports:** Express router
- **Dependencies:** supabase
- **Last modified:** 2026-02-19

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | /v1/market-intel | Public | News headlines; params: limit, metal, category |
| GET | /v1/market-intel/categories | Public | Fixed category list |

### src/routes/vault-watch.js
- **Purpose:** COMEX warehouse inventory data
- **Exports:** Express router
- **Dependencies:** supabase, comex-scraper
- **Last modified:** 2026-02-20

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | /v1/vault-watch | Public | Latest COMEX inventory; optional metal filter or days history |
| GET | /v1/vault-watch/history | Public | Historical vault data; params: metal, days |
| POST | /v1/vault-watch/refresh | Admin (INTELLIGENCE_API_KEY) | Manual COMEX scrape trigger |

### src/routes/speculation.js
- **Purpose:** What-if price scenario calculator
- **Exports:** Express router
- **Dependencies:** supabase
- **Last modified:** 2026-02-18

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | /v1/speculation | Public | Target price multipliers; params: silver, gold, platinum, palladium |

### src/routes/portfolio.js
- **Purpose:** Authenticated portfolio summary with live valuation
- **Exports:** Express router
- **Dependencies:** supabase
- **Last modified:** 2026-02-18

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | /v1/portfolio | Bearer token | Portfolio summary: total_value, cost, unrealized P/L, per-metal breakdown |

### src/routes/analytics.js
- **Purpose:** Cost basis and allocation analysis
- **Exports:** Express router
- **Dependencies:** supabase
- **Last modified:** 2026-02-18

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | /v1/analytics | Bearer token | Per-metal: avg cost, break-even, unrealized P/L, purchase dates |

### src/routes/holdings.js
- **Purpose:** CRUD for user precious metals holdings
- **Exports:** Express router
- **Dependencies:** supabase
- **Last modified:** 2026-02-18

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | /v1/holdings | Bearer token | List holdings; params: metal, limit, offset |
| POST | /v1/holdings | Bearer token | Add holding: metal, weight, quantity, purchase_price |

### src/routes/intelligence.js
- **Purpose:** AI daily briefs, portfolio intelligence, news generation
- **Exports:** Router + `runIntelligenceGeneration()`, `generateDailyBrief(userId)`, `generatePortfolioIntelligence(userId)`
- **Dependencies:** supabase, axios, price-fetcher, Gemini API
- **Last modified:** 2026-04-07

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | /v1/daily-brief | Public (UUID) | Get today's daily brief for user |
| POST | /v1/daily-brief/generate | Public (UUID, Gold tier) | Generate fresh daily brief |
| POST | /v1/daily-brief/regenerate | Public (UUID) | Force-regenerate brief |
| POST | /v1/intelligence/generate | Admin (INTELLIGENCE_API_KEY) | Trigger intelligence generation |
| POST | /v1/advisor/chat | Public (UUID) | AI advisor chat |
| GET | /v1/portfolio-intelligence | Public (UUID) | Get portfolio intelligence |
| POST | /v1/portfolio-intelligence/generate | Public (UUID) | Generate portfolio intelligence |

### src/routes/troy-chat.js
- **Purpose:** Troy AI chatbot — persistent conversations, TTS, STT, preview detection
- **Exports:** Express router
- **Dependencies:** supabase, axios, number-to-words, multer, price-fetcher, Gemini API
- **Last modified:** 2026-04-08

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | /v1/troy/conversations | Public (UUID) | Create conversation |
| GET | /v1/troy/conversations | Public (UUID) | List conversations |
| GET | /v1/troy/conversations/:id | Public (UUID) | Get conversation + messages |
| DELETE | /v1/troy/conversations/:id | Public (UUID) | Delete conversation |
| POST | /v1/troy/conversations/:id/messages | Public (UUID, quota) | Send message to Troy (3/day free, 30/day Gold) |
| POST | /v1/troy/speak | Public (UUID, Gold tier) | TTS via ElevenLabs — streams audio/mpeg, 2000 char limit, voice cap |
| POST | /v1/troy/transcribe | Public (UUID) | STT via OpenAI Whisper — multipart audio upload, voice cap |

**Key functions:**
- `detectPreviewContent(response, contextData)` — returns preview type: portfolio, purchasing_power, cost_basis, chart (ratio/spot_price), dealer_link
- `sanitizeTTSText(text)` — preprocesses text for natural TTS: markdown removal, abbreviation expansion, number-to-words conversion, slash patterns, acronyms, URL removal
- `getQuotaStatus(userId, tier)` — checks daily question quota

**Constants:**
- `PURCHASING_POWER_BENCHMARKS` — today's values (oil $70/bbl, gas $3.50/gal, rent $1800/mo, labor $30/hr) + 1971 Nixon Shock values (gold $35, silver $1.29, oil $3.60, gas $0.36, rent $150, labor $3.60)

**contextData fields injected into system prompt:**
- `holdings`, `totalValue`, `totalCost`, `totalGain`, `totalGainPercent`
- `goldPrice`, `silverPrice`, `goldSilverRatio`
- `purchasingPower` — today's comparisons (barrels of oil, gallons of gas, months of rent, hours of labor)
- `purchasingPowerComparison` — 1971 vs today for user's actual gold/silver holdings (oz, 1971 value, today value, barrels/gallons then vs now, multiplier ratio)

### src/routes/scan-receipt.js
- **Purpose:** AI receipt scanning via Gemini vision
- **Exports:** Express router
- **Dependencies:** axios, multer (memory only), Gemini API
- **Last modified:** 2026-02-23

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | /v1/scan-receipt | Authenticated | Scan receipt image → extract holdings data |

### src/routes/scan-usage.js
- **Purpose:** Track receipt scan usage limits (5/30 days free)
- **Exports:** Express router
- **Dependencies:** supabase
- **Last modified:** 2026-02-19

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | /v1/scan-status | Public | Check scan quota; params: userId or rcUserId |
| POST | /v1/increment-scan | Public | Increment scan count |

*Note: Intentionally accepts RevenueCat anonymous IDs ($RCAnonymousID) — this is by design.*

### src/routes/push.js
- **Purpose:** Push notification management, price alerts, notification preferences, audit
- **Exports:** Router + `sendPush()`, `sendBatchPush()`, `isValidExpoPushToken()`
- **Dependencies:** expo-server-sdk, supabase
- **Last modified:** 2026-04-07

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | /v1/push/register | Public | Register/update Expo push token (UUID validated) |
| DELETE | /v1/push/delete | Public | Delete push token |
| POST | /v1/push/price-alerts | Public | Create/update price alert |
| GET | /v1/push/price-alerts | Public | Get user's price alerts |
| PATCH | /v1/push/price-alerts/:id | Public | Update alert |
| DELETE | /v1/push/price-alerts/:id | Public | Delete alert |
| DELETE | /v1/push/price-alerts | Public | Delete all alerts for user/device |
| GET | /v1/push/notification-preferences | Public (UUID) | Get notification preferences |
| POST | /v1/push/notification-preferences | Public (UUID) | Update notification preferences |
| POST | /v1/push/breaking-news | Admin (INTELLIGENCE_API_KEY) | Send breaking news push to all users |
| GET | /v1/push/audit-user-ids | Admin (INTELLIGENCE_API_KEY) | Scan tables for non-UUID user_id contamination |

### src/routes/stripe.js
- **Purpose:** Stripe billing + RevenueCat iOS subscription webhooks
- **Exports:** Router + `stripeWebhookHandler`, `revenueCatWebhookHandler`
- **Dependencies:** stripe SDK, supabase
- **Last modified:** 2026-02-23

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | /v1/webhooks/stripe | Signature | Stripe webhook (checkout, subscription updates) |
| POST | /v1/stripe/create-checkout-session | Public (UUID) | Create Stripe checkout |
| POST | /v1/stripe/verify-session | Public (UUID) | Verify checkout completion |
| GET | /v1/sync-subscription | Public (UUID) | Sync subscription status |
| POST | /v1/webhooks/revenuecat | Signature | RevenueCat iOS purchase webhook |

### src/routes/stack-signal.js
- **Purpose:** Stack Signal curated news articles
- **Exports:** Express router
- **Dependencies:** supabase
- **Last modified:** 2026-03-16

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | /v1/stack-signal | Public | List articles; params: limit, offset, category |
| GET | /v1/stack-signal/latest | Public | Latest synthesis article |
| GET | /v1/stack-signal/:slug | Public | Article by slug |

### src/routes/social.js
- **Purpose:** Social engagement — views, likes, comments on Stack Signal articles
- **Exports:** Express router
- **Dependencies:** supabase
- **Last modified:** 2026-04-07

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | /v1/stack-signal/articles/:id/view | Public | Record view (deduped by user/device) |
| POST | /v1/stack-signal/articles/:id/like | Public (UUID) | Toggle like |
| GET | /v1/stack-signal/articles/:id/likes | Public | Get like count + user_liked flag |
| POST | /v1/stack-signal/articles/:id/comments | Public (UUID) | Post comment (max 1000 chars) |
| GET | /v1/stack-signal/articles/:id/comments | Public | List comments (paginated) |
| DELETE | /v1/stack-signal/articles/:id/comments/:commentId | Public (UUID, owner only) | Delete own comment |

### src/routes/dealerPrices.js
- **Purpose:** Comparative dealer pricing with affiliate links
- **Exports:** Express router
- **Dependencies:** supabase, dealerScraper
- **Last modified:** 2026-03-06

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | /v1/dealer-prices | Public | Compare dealer prices; params: metal, weight |
| GET | /v1/dealer-prices/products | Public | List tracked products |
| POST | /v1/dealer-prices/click | Public | Log affiliate click |

### src/routes/api-keys.js
- **Purpose:** User-facing API key management (generate, list, revoke)
- **Exports:** Express router
- **Dependencies:** supabase, crypto, middleware/api-key-auth (hashKey)
- **Last modified:** 2026-04-11
- **Auth:** Supabase session JWT via `Authorization: Bearer <jwt>` — validated inline via `supabase.auth.getUser(jwt)`. Not authenticated via the API keys it manages (chicken-and-egg avoidance)
- **Limits:** Max 3 keys per user; default tier `free`, default rate_limit 100/hr

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | /v1/api-keys/generate | Supabase JWT | Generate new key `ts_live_<48 hex>` — returns raw key ONCE, then only the hash is stored |
| GET | /v1/api-keys | Supabase JWT | List user's keys with `key_preview` (last 8 chars of hash), tier, rate_limit, last_used_at, request_count |
| DELETE | /v1/api-keys/:id | Supabase JWT | Revoke key — 404 if not owned by caller |

### src/routes/mcp.js
- **Purpose:** Model Context Protocol (MCP) server — wraps 6 public tools for AI agent consumption via the Streamable HTTP transport
- **Exports:** `handleMcp`, `createMcpServer`
- **Dependencies:** `@modelcontextprotocol/sdk` (McpServer + StreamableHTTPServerTransport), zod, crypto (randomUUID), supabase, price-fetcher
- **Last modified:** 2026-04-11

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | /mcp | Public | JSON-RPC request (client→server); may upgrade to SSE stream |
| GET | /mcp | Public | Opens SSE stream for server→client notifications |
| DELETE | /mcp | Public | Terminates the client's session |

All three methods route to the single `handleMcp` function which calls `transport.handleRequest(req, res[, req.body])`.

**Tools registered on the McpServer:**
- `get_spot_prices` — calls `getSpotPrices()` directly
- `get_price_history` — params: `metal`, `range` (1M|3M|6M|1Y|5Y|ALL); queries `price_log` table
- `get_stack_signal` — params: `limit`, `offset`, `category`; queries `stack_signal_articles`
- `get_vault_watch` — optional `metal` param; queries `vault_data` (latest per metal)
- `get_junk_silver` — params: `dimes`, `quarters`, `half_dollars`, `kennedy_40`, `dollars`, `war_nickels`; duplicates the coin constants from junk-silver.js route (per "don't modify existing routes")
- `get_speculation` — params: `gold`, `silver`, `platinum`, `palladium` (target prices); returns multipliers and change_pct per metal

**Session management:** `StreamableHTTPServerTransport` handles sessions internally via the `Mcp-Session-Id` response/request header. Stateful mode with `sessionIdGenerator: () => randomUUID()`. No manual session map. A single shared `McpServer` + `Transport` pair is lazy-initialized on first request and reused for all subsequent requests.

**Body parsing:** `/mcp` routes are mounted in `index.js` BEFORE the global `express.json()` middleware (alongside the Stripe webhook) so malformed or empty POST bodies don't get rejected by the global JSON parser. The `handleMcp` function uses its own `readRawBody()` helper that reads the raw stream, attempts `JSON.parse`, and falls back to `{}` on failure — the MCP transport then handles the error path with a proper JSON-RPC error response.

**Breaking change from prior SSE transport:** the old `/mcp/sse` + `/mcp/messages?sessionId=...` endpoints and the per-session transport map are gone. Clients must upgrade to speak Streamable HTTP at `/mcp`. The prior `GET /mcp` → `/.well-known/mcp.json` redirect in `llms.js` was removed because it conflicted with the new transport's GET handler. Discovery still works via `/.well-known/mcp.json` and `/.well-known/mcp/server-card.json`.

### src/routes/junk-silver.js
- **Purpose:** Junk silver melt value calculator for pre-1965 US coinage
- **Exports:** Express router
- **Dependencies:** price-fetcher (getSpotPrices)
- **Last modified:** 2026-04-11

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | /v1/junk-silver | Public | Calculate melt value; query params: dimes, quarters, half_dollars, kennedy_40, dollars, war_nickels (all optional integers) |

Silver content per coin (troy oz): dimes 0.07234, quarters 0.18084, half_dollars 0.36169, kennedy_40 0.14792 (40% silver), dollars 0.77344, war_nickels 0.05626. Returns total silver oz, total melt value, and per-$1-face breakdown per coin type.

### src/routes/snapshots.js
- **Purpose:** Daily portfolio snapshots for historical charts
- **Exports:** Express router
- **Dependencies:** supabase
- **Last modified:** 2026-04-07

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | /v1/snapshots | Public (UUID) | Save daily snapshot (upserts by user+date) |
| GET | /v1/snapshots/:userId | Public (UUID) | Get snapshots; params: range (1W–ALL) |

### src/routes/widget.js
- **Purpose:** iOS widget data with sparkline charts
- **Exports:** Express router
- **Dependencies:** supabase, price-fetcher
- **Last modified:** 2026-03-01

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | /v1/widget-data | Public | Sparkline data for iOS widget |

### src/routes/min-version.js
- **Purpose:** Force-update version gating
- **Exports:** Express router
- **Dependencies:** None
- **Last modified:** 2026-02-24

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | /v1/min-version | Public (no rate limit) | Minimum app version check |

### src/routes/legal.js
- **Purpose:** Privacy policy and terms of use pages (TroyStack branded, support@troystack.com)
- **Exports:** Express router
- **Dependencies:** None
- **Last modified:** 2026-04-11

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | /privacy | Public | Privacy policy (HTML) |
| GET | /terms | Public | Terms of use (HTML) |
| GET | /api/privacy | Public | Privacy principles (JSON) |

### src/routes/llms.js
- **Purpose:** LLM discoverability endpoints (contact: support@troystack.com)
- **Exports:** Express router
- **Dependencies:** None
- **Last modified:** 2026-04-11

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | /robots.txt | Public (open CORS) | Allow list for AI crawlers (ChatGPT-User, Claude-Web, PerplexityBot) + Sitemap directive |
| GET | /sitemap.xml | Public (open CORS) | XML sitemap of all public endpoints for crawler discovery |
| GET | /llms.txt | Public (open CORS) | LLM-readable app description |
| GET | /openapi.json | Public (open CORS) | OpenAPI 3.0 spec — covers prices, price history, stack-signal, stack-signal/latest, market-intel, vault-watch, junk-silver, speculation, portfolio, holdings, analytics |
| GET | /.well-known/ai-plugin.json | Public (open CORS) | AI plugin manifest (TroyStack branding, troystack.com logo/legal, support@troystack.com) |
| GET | /.well-known/mcp.json | Public (open CORS) | MCP server manifest — 6 public tools: get_spot_prices, get_price_history, get_stack_signal, get_vault_watch, get_junk_silver, get_speculation |
| GET | /.well-known/mcp/server-card.json | Public (open CORS) | MCP server card for registries — points at `/mcp/sse` transport URL with tool summaries, contact, website, logo |
| GET | /.well-known/oauth-protected-resource | Public (open CORS) | OAuth protected resource metadata — empty `authorization_servers` array signals "no auth required" per MCP OAuth spec |
| GET | /.well-known/oauth-protected-resource/mcp | Public (open CORS) | Same payload as above; MCP clients probing the resource-scoped path |

Root response `GET /` now includes top-level `mcp`, `openapi`, `llms`, `sitemap`, `docs` URLs for crawler discovery alongside the existing endpoint catalog.

---

## 2. Middleware

### src/middleware/auth.js
- **Purpose:** Strict API key authentication — Bearer token → SHA-256 hash → api_keys table lookup. Returns 401 if no key present.
- **Exports:** `authenticateApiKey(req, res, next)`, `hashApiKey(key)`
- **Dependencies:** supabase, crypto
- **Last modified:** 2026-02-18
- **Attaches to req:** `userId`, `apiKeyId`, `tier`, `rateLimit`
- **Used by:** /v1/portfolio, /v1/analytics, /v1/holdings

### src/middleware/api-key-auth.js
- **Purpose:** Permissive global API key middleware — validates if a key is present, passes through if not
- **Exports:** `apiKeyAuth(req, res, next)`, `hashKey(key)`
- **Dependencies:** supabase, crypto
- **Last modified:** 2026-04-11
- **Extracts key from:** `x-api-key` header (preferred), or `Authorization: Bearer ts_live_...` (only tokens starting with `ts_live_` are treated as API keys, so Supabase JWTs pass through)
- **Rate limit:** Hourly via `app_state` key `api_key_hourly_${keyId}_${YYYY-MM-DDTHH}` — auto-resets each hour. Returns 429 with `{error, limit, reset}` when exceeded
- **Side effects:** Fire-and-forget increment of hourly bucket + update `api_keys.last_used_at` + `api_keys.request_count`
- **Attaches to req:** `req.apiKey = { id, user_id, tier, rate_limit }` on success
- **Applied:** Globally via `app.use(apiKeyAuth)` in index.js (after body parsing, before routes)
- **Coexists with auth.js:** Both can run on the same request — this one silently validates globally, `authenticateApiKey` still enforces strict auth on portfolio/analytics/holdings routes

### src/middleware/rateLimit.js
- **Purpose:** Three-tier rate limiting
- **Exports:** `publicLimiter` (100/min per IP), `authenticatedLimiter` (30/min per user), `developerLimiter` (tier-based hourly: free=100, pro=1000, enterprise=10000)
- **Dependencies:** express-rate-limit, supabase
- **Last modified:** 2026-02-18

### CORS (in index.js)
- Allowed origins: `troystack.ai` (root, www), `stacktrackergold.com` (root, www, app — legacy), `localhost:5173`, `localhost:3000`
- LLM discovery endpoints use open CORS
- Mobile apps, curl, server-to-server allowed (no origin)

### Body parsing (in index.js)
- `express.json({ limit: '20mb' })` for all routes
- Stripe webhook uses `express.raw()` before JSON parser for signature verification

---

## 3. Cron Jobs

All scheduled in `src/index.js`. Timezone: UTC unless noted.

| Schedule | Time (EST) | Job | Source |
|----------|-----------|-----|--------|
| `30 11 * * *` | 6:30 AM | Intelligence generation | intelligence.js `runIntelligenceGeneration()` |
| `35 11 * * *` | 6:35 AM | Daily brief for Gold/Lifetime users + push | intelligence.js `generateDailyBrief()` |
| `0 23 * * *` | 6:00 PM | COMEX vault data scrape | comex-scraper.js `scrapeComexVaultData()` |
| `*/15 * * * *` | Every 15 min | Price logging (skips weekends) | price-fetcher.js `fetchLiveSpotPrices()` + `logPriceToSupabase()` |
| `*/5 * * * *` | Every 5 min | Price alert checker | price-alert-checker.js `checkPriceAlerts()` |
| `0 */2 * * *` | Every 2 hrs | Stack Signal article pipeline | stack-signal-processor.js `runStackSignalPipeline()` |
| `15 11 * * *` | 6:15 AM | Stack Signal daily synthesis | stack-signal-processor.js `generateStackSignal()` |
| `30 21 * * 1-5` | 4:30 PM (weekdays) | Stack Signal evening digest | `generateStackSignal('evening')` |
| `0 22 * * 5` | 5:00 PM (Fri) | Weekly recap | `generateStackSignal('weekly_recap')` |
| `15 11 * * 1` | 6:15 AM (Mon) | Weekly preview | `generateStackSignal('weekly_preview')` |
| `0 22 * * 0` | 6:00 PM (Sun) | Weekly X thread to @troystack_ | weekly-thread.js `generateAndPostWeeklyThread()` |
| `0 22 28-31 * *` | 5:00 PM (last day) | Monthly recap | `generateStackSignal('monthly_recap')` |
| `0 15 1 1 *` | 10:00 AM (Jan 1) | Yearly recap | `generateStackSignal('yearly_recap')` |
| ~~`5 * * * *`~~ | ~~Every hour at :05~~ | **DISABLED** — Dealer price scraping (re-enable when affiliate integrations ready) | dealerScraper.js `scrapeAllDealers()` |

---

## 4. Database Schema (Supabase PostgreSQL)

### profiles
- `id` (UUID, PK) — Supabase auth user ID
- `subscription_tier` (text) — free, gold, lifetime
- `stripe_customer_id` (text)
- Used by: stripe.js, intelligence.js, troy-chat.js, stack-signal-push.js

### holdings
- `id` (UUID, PK), `user_id` (UUID, FK→profiles)
- `metal` (text), `type` (text, product name), `quantity` (int), `weight_oz` (numeric), `weight_unit` (text), `total_oz` (numeric)
- `purchase_price` (numeric), `purchase_date` (date), `notes` (JSONB — spot_price, premium, source)
- `deleted_at` (timestamp, soft delete)
- Used by: portfolio.js, analytics.js, holdings.js, intelligence.js, troy-chat.js

### price_log
- `id` (serial PK), `timestamp` (timestamptz)
- `gold`, `silver`, `platinum`, `palladium` (numeric — spot prices)
- `source` (text), `gold_change_pct`, `silver_change_pct`, `platinum_change_pct`, `palladium_change_pct`
- Used by: prices.js, analytics.js, portfolio.js, widget.js, speculation.js

### push_tokens
- `id` (UUID, PK), `user_id` (UUID, nullable), `device_id` (text, nullable)
- `expo_push_token` (text, unique), `platform` (text), `app_version` (text)
- `last_active` (timestamptz)
- Used by: push.js, index.js (daily brief push), comex-scraper.js, price-alert-checker.js, stack-signal-push.js

### notification_preferences
- `user_id` (UUID, PK)
- `daily_brief`, `morning_brief`, `market_alerts`, `critical_alerts`, `price_alerts`, `breaking_news`, `comex_alerts` (boolean)
- `comex_gold`, `comex_silver`, `comex_platinum`, `comex_palladium` (boolean)
- Used by: push.js, index.js, comex-scraper.js, price-alert-checker.js, stack-signal-push.js

### price_alerts
- `id` (UUID, PK), `user_id` (UUID, nullable), `device_id` (text, nullable)
- `metal` (text), `target_price` (numeric), `direction` (text: above/below)
- `enabled` (boolean), `triggered` (boolean)
- Used by: push.js, price-alert-checker.js

### intelligence_briefs
- `id` (UUID, PK), `date` (date)
- `title`, `summary`, `category`, `source`, `source_url` (text)
- `relevance_score` (numeric)
- Used by: intelligence.js, market-intel.js, daily brief generation

### daily_briefs
- `id` (UUID, PK), `user_id` (UUID, FK→profiles), `date` (date)
- `brief_text` (text), `generated_at` (timestamptz)
- Unique on (user_id, date)
- Used by: intelligence.js

### troy_conversations
- `id` (UUID, PK), `user_id` (UUID)
- `title` (text), `created_at`, `updated_at` (timestamptz)
- Used by: troy-chat.js

### troy_messages
- `id` (UUID, PK), `conversation_id` (UUID, FK→troy_conversations)
- `role` (text: user/assistant), `content` (text)
- `created_at` (timestamptz)
- Used by: troy-chat.js

### troy_question_usage
- `user_id` (UUID, PK), `questions_used` (int), `period_start` (timestamptz)
- Rolling 1-day window: free=3/day, gold=30/day
- Used by: troy-chat.js

### stack_signal_articles
- `id` (UUID, PK), `slug` (text, unique)
- `title`, `troy_one_liner`, `troy_commentary` (text)
- `sources` (JSONB — array of {title, url, source})
- `category`, `image_url` (text), `relevance_score` (numeric), `is_stack_signal` (boolean)
- `published_at` (timestamptz), `gold_price_at_publish`, `silver_price_at_publish` (numeric)
- `view_count`, `like_count`, `comment_count` (int)
- Used by: stack-signal.js, social.js, stack-signal-processor.js, intelligence.js

### article_views
- `id` (UUID, PK), `article_id` (UUID, FK), `user_id` (UUID, nullable), `device_id` (text, nullable)
- Used by: social.js

### article_likes
- `id` (UUID, PK), `article_id` (UUID, FK), `user_id` (UUID)
- Used by: social.js

### article_comments
- `id` (UUID, PK), `article_id` (UUID, FK), `user_id` (UUID)
- `content` (text), `created_at` (timestamptz)
- Used by: social.js

### vault_data
- `id` (serial PK), `metal` (text), `date` (date)
- `registered_oz`, `eligible_oz`, `combined_oz` (numeric)
- `registered_change_oz`, `eligible_change_oz`, `combined_change_oz` (numeric)
- `open_interest_oz`, `oversubscribed_ratio` (numeric)
- Unique on (metal, date)
- Used by: vault-watch.js, comex-scraper.js

### portfolio_snapshots
- `user_id` (UUID), `snapshot_date` (date)
- `total_value`, `gold_value`, `silver_value`, `platinum_value`, `palladium_value` (numeric)
- `gold_oz`, `silver_oz`, `platinum_oz`, `palladium_oz` (numeric)
- `gold_spot`, `silver_spot`, `platinum_spot`, `palladium_spot` (numeric)
- Unique on (user_id, snapshot_date)
- Used by: snapshots.js

### scan_usage
- `user_id` (text — can be UUID or $RCAnonymousID), `scans_used` (int), `period_start` (timestamptz)
- 5 scans per 30-day rolling period
- Used by: scan-usage.js

### dealer_prices
- `id` (serial PK), `dealer` (text), `product_name` (text)
- `metal` (text), `weight_oz` (numeric), `price` (numeric), `spot_premium` (numeric)
- `affiliate_url` (text), `scraped_at` (timestamptz)
- Used by: dealerPrices.js, dealerScraper.js

### affiliate_clicks
- `id` (serial PK), `dealer` (text), `product_name` (text), `metal` (text)
- `weight_oz` (numeric), `user_id` (UUID, nullable), `clicked_at` (timestamptz)
- Used by: dealerPrices.js

### breaking_news
- `id` (UUID, PK), `title`, `body` (text), `metal` (text, nullable), `severity` (text)
- Used by: push.js, market-intel.js

### notification_log
- `id` (serial PK), `user_id` (UUID), `type` (text), `metal` (text)
- `target_price`, `current_price` (numeric), `sent_at` (timestamptz)
- Used by: price-alert-checker.js

### app_state
- `key` (text, PK), `value` (text/JSONB)
- General-purpose key-value store for: cron locks, daily caps, voice usage counters, DALL-E usage, push dedup
- Key patterns: `daily_brief_lock_{userId}_{date}`, `voice_usage_{userId}_{date}`, `dalle_daily_count_{date}`, `breaking_push_count_{date}`
- Used by: index.js, troy-chat.js, stack-signal-processor.js, stack-signal-push.js

### api_keys
- `id` (UUID, PK), `user_id` (UUID, FK→profiles)
- `key_hash` (text, SHA-256), `tier` (text: free/pro/enterprise), `rate_limit` (int)
- `last_used_at` (timestamptz), `request_count` (int)
- Used by: auth.js

### etf_daily_cache
- `symbol` (text), `date` (date), OHLCV data
- Used by: etf-prices.js

### etf_ratios
- Calibrated ETF-to-spot conversion ratios by date
- Used by: etf-prices.js

---

## 5. External Services

| Service | Purpose | Env Var(s) | Used In |
|---------|---------|-----------|---------|
| **Supabase** | PostgreSQL database + auth | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | lib/supabase.js (everywhere) |
| **Google Gemini** | AI chat, daily briefs, receipt scanning, news search, commentary | `GEMINI_API_KEY` | intelligence.js, troy-chat.js, scan-receipt.js, stack-signal-processor.js |
| **Anthropic Claude** | Editorial summaries for Stack Signal | `ANTHROPIC_API_KEY` | ai-router.js, stack-signal-processor.js |
| **OpenAI** | DALL-E image generation, Whisper STT | `OPENAI_API_KEY` | ai-router.js, troy-chat.js (transcribe) |
| **ElevenLabs** | Text-to-speech (Troy's voice) | `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID` | troy-chat.js (speak) |
| **MetalPriceAPI** | Primary spot price source | `METAL_PRICE_API_KEY` | price-fetcher.js |
| **GoldAPI.io** | Fallback spot price source | `GOLD_API_KEY` | price-fetcher.js |
| **Yahoo Finance** | ETF historical data (SLV, GLD, PPLT, PALL) | None (public) | etf-prices.js |
| **Stripe** | Billing, subscriptions | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_GOLD_MONTHLY_PRICE_ID`, `STRIPE_GOLD_YEARLY_PRICE_ID`, `STRIPE_GOLD_LIFETIME_PRICE_ID` | stripe.js |
| **RevenueCat** | iOS in-app purchase webhooks | `REVENUECAT_WEBHOOK_SECRET` | stripe.js |
| **Expo Push** | Mobile push notifications | None (expo-server-sdk) | push.js, index.js, stack-signal-push.js, comex-scraper.js, price-alert-checker.js |
| **X (Twitter)** | Auto-tweet Stack Signal articles (@troystack_) | `X_CONSUMER_KEY`, `X_CONSUMER_SECRET`, `X_ACCESS_TOKEN`, `X_ACCESS_SECRET` | auto-tweet.js |
| **CME Group** | COMEX warehouse XLS reports | None (public URLs) | comex-scraper.js |
| **Dealer websites** | Price scraping (APMEX, JM Bullion, SD Bullion) | `APMEX_AFFILIATE_ID`, `JMB_AFFILIATE_ID`, `SDB_AFFILIATE_ID` | dealerScraper.js |

---

## 6. Environment Variables

| Variable | Required | Used In | Description |
|----------|----------|---------|-------------|
| `PORT` | No (default 3000) | index.js | Server port |
| `SUPABASE_URL` | Yes | lib/supabase.js | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes | lib/supabase.js | Supabase service role key |
| `GEMINI_API_KEY` | Yes | intelligence.js, troy-chat.js, scan-receipt.js, stack-signal-processor.js | Google Gemini API key |
| `ANTHROPIC_API_KEY` | Yes | ai-router.js | Anthropic Claude API key |
| `OPENAI_API_KEY` | Yes | ai-router.js, troy-chat.js | OpenAI API key (DALL-E + Whisper) |
| `ELEVENLABS_API_KEY` | Yes | troy-chat.js | ElevenLabs TTS API key |
| `ELEVENLABS_VOICE_ID` | Yes | troy-chat.js | ElevenLabs voice ID (Brad) |
| `METAL_PRICE_API_KEY` | Yes | price-fetcher.js, prices.js | MetalPriceAPI key |
| `GOLD_API_KEY` | No | price-fetcher.js | GoldAPI.io fallback key |
| `STRIPE_SECRET_KEY` | Yes | stripe.js | Stripe secret key |
| `STRIPE_WEBHOOK_SECRET` | Yes | stripe.js | Stripe webhook signing secret |
| `STRIPE_GOLD_MONTHLY_PRICE_ID` | Yes | stripe.js | Stripe price ID for Gold monthly |
| `STRIPE_GOLD_YEARLY_PRICE_ID` | Yes | stripe.js | Stripe price ID for Gold yearly |
| `STRIPE_GOLD_LIFETIME_PRICE_ID` | Yes | stripe.js | Stripe price ID for Lifetime |
| `REVENUECAT_WEBHOOK_SECRET` | No | stripe.js | RevenueCat webhook secret |
| `INTELLIGENCE_API_KEY` | Yes | intelligence.js, push.js, vault-watch.js | Admin API key for cron triggers |
| `APMEX_AFFILIATE_ID` | No | dealerScraper.js | APMEX affiliate partner ID |
| `JMB_AFFILIATE_ID` | No | dealerScraper.js | JM Bullion affiliate ID |
| `SDB_AFFILIATE_ID` | No | dealerScraper.js | SD Bullion affiliate ID |
| `MIN_VERSION_IOS` | No | min-version.js | Minimum iOS app version |
| `MIN_VERSION_ANDROID` | No | min-version.js | Minimum Android app version |
| `MIN_VERSION_MESSAGE` | No | min-version.js | Force-update message text |
| `MIN_VERSION_ENFORCED` | No | min-version.js | "true" to enforce version gate |
| `X_CONSUMER_KEY` | No | auto-tweet.js | X (Twitter) API consumer key |
| `X_CONSUMER_SECRET` | No | auto-tweet.js | X (Twitter) API consumer secret |
| `X_ACCESS_TOKEN` | No | auto-tweet.js | X (Twitter) API access token |
| `X_ACCESS_SECRET` | No | auto-tweet.js | X (Twitter) API access secret |

---

## 7. Voice Pipeline

### TTS — POST /v1/troy/speak
1. Validate userId (UUID), text (non-empty, ≤2000 chars)
2. Check subscription tier (Gold/Lifetime only)
3. Check daily voice cap (app_state: `voice_usage_{userId}_{date}` — America/New_York timezone)
   - Free: 1/day, Gold/Lifetime: 20/day
   - Shared counter with /transcribe
4. Run `sanitizeTTSText(text)`:
   - Remove markdown (`**`, `*`, `_`)
   - Expand abbreviations (oz→ounces, ASE→American Silver Eagle, AGE→American Gold Eagle, pt→platinum, pd→palladium)
   - Expand slash patterns ($30/oz→"30 dollars an ounce")
   - Expand acronyms (Fed→"the Fed", GDP→"G D P", CPI→"C P I", BRICS→"BRICKS", etc.)
   - Historic years (1971, 2008, 1934 → spoken words)
   - Strip trailing zeros ($10.00→$10)
   - Convert dollar amounts to words via `number-to-words` ($4,657.59→"four thousand six hundred fifty-seven dollars and fifty-nine cents")
   - Convert large numbers (commas and plain 4+ digit)
   - Convert percentages (122.7%→"one hundred twenty-two point seven percent")
   - Convert ranges/ratios, plus/minus signs
   - Remove parenthetical percentages, URLs, bullets, special chars
   - Collapse whitespace
5. POST to ElevenLabs `/v1/text-to-speech/{voiceId}` with model `eleven_turbo_v2_5`
6. Stream audio/mpeg response back to client
7. Increment voice usage counter

### STT — POST /v1/troy/transcribe
1. Validate userId (UUID), check audio file exists (multer, 10MB limit)
2. Check subscription tier + daily voice cap (same shared counter)
3. POST multipart to OpenAI `/v1/audio/transcriptions` (model: whisper-1, language: en)
4. Return `{ text: "transcribed text" }`
5. Increment voice usage counter

---

## 8. Stack Signal

### Article Pipeline (every 2 hours)
1. `rss-fetcher.js` fetches from 8 RSS feeds (Kitco, Seeking Alpha, Mining.com, Reuters, Zero Hedge, Yahoo Finance, Google News)
2. Deduplicates against existing articles in DB (by URL)
3. Clusters related articles via Gemini
4. **Feed articles:** `writeFeedReaction()` (Gemini Flash) writes 400-800 word feed articles with depth requirements (historical context, physical market connection, purchasing power framing, forward-looking close)
   - Save guard filters articles with `troy_commentary.length < 2500` chars
5. Generates/assigns image (DALL-E gated by `USE_DALLE = false` flag; pool fallback)
6. Saves feed articles to `stack_signal_articles` table (`is_stack_signal=false`). After each successful save, `postArticleTweet()` fires to X (fire-and-forget, dedup by slug, 5/day cap).
7. Sends push notification if score ≥85 (via stack-signal-push.js)
8. **Claude daily synthesis editorial** — `generateClaudeDailySynthesis()` runs opportunistically at the end of every pipeline cycle:
   - Deduped by date (EST): only one synthesis per day (`is_stack_signal=true AND category='synthesis'`)
   - Requires ≥ 3 feed articles saved for today; otherwise skips
   - Gathers today's feed articles and builds a pseudo-cluster passed to `writeSynthesisArticle()` (Claude Sonnet, 1500-2500 words, 6-8 paragraphs)
   - Saves with distinct title `The Stack Signal: <Month Day, Year>`, `is_stack_signal=true`, `category='synthesis'`, `relevance_score=95`
   - After save, `postArticleTweet()` fires to X (same dedup/cap as feed articles)

### Synthesis Types
- **daily** (6:15 AM EST): Morning market digest
- **evening** (4:30 PM EST weekdays): Post-market close recap
- **weekly_recap** (5:00 PM EST Fridays): Week in review
- **weekly_preview** (6:15 AM EST Mondays): Week ahead preview
- **monthly_recap** (5:00 PM EST last day): Month-end review
- **yearly_recap** (10:00 AM EST Jan 1): Year-in-review

### Push Tiers (stack-signal-push.js)
- Score 85-89: Market Alert (paid users only)
- Score 90-94: Breaking News (paid users only)
- Score 95-100: Critical Alert (ALL users)
- Emergency override: Score 99+ with keywords (1 extra push, 3/day hard ceiling)
- Daily cap tracked via `breaking_push_count_{date}` in app_state

---

## 9. Push Notifications

### Token Management
- Registered via POST /v1/push/register (UUID validated since 2026-04-07)
- Auto-deleted when Expo returns `DeviceNotRegistered`
- Deduped by user_id (most recent token per user for daily brief push)

### Daily Brief Push (index.js cron, 6:35 AM EST)
1. Fetch all Gold/Lifetime users from profiles
2. Atomic lock per user per day (`daily_brief_lock_{userId}_{date}` in app_state)
3. Generate daily brief + portfolio intelligence
4. Check notification_preferences (daily_brief flag)
5. Push dedup (`daily_push_{userId}_{date}` in app_state)
6. Send via Expo with first sentence of brief as body
7. 2-second delay between users (Expo rate limit)

### Price Alert System (every 5 min)
1. Fetch all enabled, non-triggered alerts
2. Compare against current spot prices
3. If triggered: send push, mark triggered, log to notification_log

### Breaking News (admin endpoint)
1. Insert to breaking_news table
2. Fetch all push tokens with user_id
3. Filter out users with breaking_news=false in notification_preferences
4. Dedup by user_id (one token per user)
5. Batch send via Expo

---

## 10. Affiliate Integration

### detectPreviewContent() (troy-chat.js)
Returns preview hints for the mobile app UI based on Troy's response text:

| Type | Trigger Keywords | Data Returned |
|------|-----------------|---------------|
| `portfolio` | "your stack", "portfolio", "holdings", "total value" | Holdings, totalValue, totalGain |
| `purchasing_power` | "purchasing power", "barrels of oil", "buying power" | Purchasing power data |
| `cost_basis` | "cost basis", "average cost", "break even" | Holdings array |
| `chart` (ratio) | "gold/silver ratio", "the ratio" | Ratio value |
| `chart` (spot_price) | "gold price", "silver price", "spot price" | Gold/silver prices |
| `dealer_link` (silver) | "silver eagle" | FlexOffers Silver Eagles affiliate URL |
| `dealer_link` (gold) | "gold eagle" | FlexOffers Gold Eagles affiliate URL |

### Affiliate URLs
- **Silver Eagles:** `https://track.flexlinkspro.com/g.ashx?foid=156074.13444.1055589&trid=1546671.246173&foc=16&fot=9999&fos=6`
- **Gold Eagles:** `https://track.flexlinkspro.com/g.ashx?foid=156074.13444.1055590&trid=1546671.246173&foc=16&fot=9999&fos=6`

### Dealer Price Comparison
- Hourly scraping of APMEX, JM Bullion, SD Bullion
- Products: Silver/Gold Eagles, Maples, Rounds, Bars (various sizes)
- Click logging to affiliate_clicks table
- Affiliate partner IDs via env vars

---

## 11. Intelligence

### Daily Brief Generation (generateDailyBrief)
1. Fetch user holdings + spot prices + today's intelligence briefs + Stack Signal synthesis
2. Build contextData with portfolio metrics
3. Call Gemini 2.5 Flash with Troy system prompt:
   - Conversational, narrative tone
   - Lead with story, not numbers (max 2-3 key numbers)
   - Under 200 words
   - No greetings, no exclamation points, no emojis
   - "your stack" not "your portfolio"
   - Sound natural when read aloud
4. Upsert to daily_briefs table

### Intelligence Generation (runIntelligenceGeneration)
1. Generate 6 Google searches on precious metals topics via Gemini with search grounding
2. Extract structured briefs (title, summary, category, source, relevance_score)
3. Deduplicate against existing briefs for today
4. Cap at 8 briefs/day
5. Insert to intelligence_briefs table

### Portfolio Intelligence (generatePortfolioIntelligence)
- Per-user analysis of holdings performance, allocation, opportunities
- Generated alongside daily brief for Gold/Lifetime users

---

## Services Reference

### src/services/price-fetcher.js
- **Purpose:** Fetch, cache, and log spot prices
- **Exports:** `initPriceFetcher()`, `getSpotPrices()`, `getCachedPrices()`, `fetchLiveSpotPrices()`, `logPriceToSupabase()`, `areMarketsClosed()`, `getLastTradingDay()`
- **Dependencies:** axios, supabase, etf-prices
- **Last modified:** 2026-02-24
- **Cache:** In-memory, 10-min TTL. Friday close stored for change calculation.
- **Market hours:** Closed Friday 5PM ET → Sunday 6PM ET

### src/services/etf-prices.js
- **Purpose:** Convert ETF prices to estimated spot via calibrated ratios
- **Exports:** `fetchAllETFs()`, `getRatioForDate()`, `slvToSpotSilver()`, `gldToSpotGold()`, `ppltToSpotPlatinum()`, `pallToSpotPalladium()`
- **Dependencies:** yahoo-finance2, supabase
- **Last modified:** 2026-02-23

### src/services/ai-router.js
- **Purpose:** Unified AI model routing (Gemini, Claude, DALL-E)
- **Exports:** `callGemini()`, `callClaude()`, `generateImage()`, `MODELS`
- **Dependencies:** axios, @anthropic-ai/sdk
- **Last modified:** 2026-02-27

### src/services/rss-fetcher.js
- **Purpose:** Fetch precious metals news from 8 RSS feeds
- **Exports:** `fetchNewArticles()`, `RSS_FEEDS`
- **Dependencies:** axios, fast-xml-parser, supabase
- **Last modified:** 2026-03-01

### src/services/stack-signal-processor.js
- **Purpose:** Stack Signal article pipeline + synthesis generation
- **Exports:** `runStackSignalPipeline()`, `generateStackSignal(type)`
- **Dependencies:** supabase, ai-router, rss-fetcher, price-fetcher, stack-signal-push
- **Last modified:** 2026-03-28

### src/services/auto-tweet.js
- **Purpose:** Post Stack Signal articles to X (@troystack_) — fire-and-forget, never blocks article saves
- **Exports:** `postArticleTweet(article)`, `getClient()` — returns shared TwitterApi client
- **Dependencies:** twitter-api-v2, supabase
- **Dedup:** `app_state` key `tweeted_signal_${slug}` holds the tweet id
- **Daily cap:** 5 tweets/day via `app_state` key `tweet_count_${YYYY-MM-DD}` (America/New_York boundary)
- **Tweet format:** `<title>\n\n<troy_one_liner>\n\n<https://troystack.com/signal/slug>` truncated to 280 chars
- **Credential check:** skips silently if X_* env vars missing

### src/services/weekly-thread.js
- **Purpose:** Generate and post a 5-7 tweet weekly recap thread to @troystack_ every Sunday 6 PM ET
- **Exports:** `generateAndPostWeeklyThread()`, `isoWeekKey(date?)`
- **Dependencies:** supabase, ai-router (Gemini Flash), price-fetcher, auto-tweet (reuses client)
- **Flow:** dedup by ISO week (`weekly_thread_${YYYY-WW}`) → fetch top 10 Stack Signal articles from last 7 days → fetch current spot + 7-day-ago price_log for weekly change → Gemini Flash JSON array of tweets → post thread (first standalone, rest via `in_reply_to_tweet_id`) with 1s delay between tweets → save root tweet id to app_state
- **Cron:** `0 22 * * 0` (Sundays 22:00 UTC = 6 PM ET)

### src/services/stack-signal-push.js
- **Purpose:** Push notifications for high-scoring Stack Signal articles
- **Exports:** `sendSignalPush()`
- **Dependencies:** supabase, push.js
- **Last modified:** 2026-03-11

### src/services/comex-scraper.js
- **Purpose:** Scrape COMEX warehouse inventory from CME XLS files
- **Exports:** `scrapeComexVaultData()`
- **Dependencies:** axios, XLSX, supabase, push.js
- **Last modified:** 2026-03-26

### src/services/dealerScraper.js
- **Purpose:** Scrape dealer prices (APMEX, JM Bullion, SD Bullion)
- **Exports:** `scrapeAllDealers()`, `PRODUCTS`
- **Dependencies:** cheerio, axios, supabase
- **Last modified:** 2026-03-06

### src/services/price-alert-checker.js
- **Purpose:** Check price alerts and send push notifications
- **Exports:** `checkPriceAlerts()`
- **Dependencies:** supabase, push.js, price-fetcher
- **Last modified:** 2026-03-04

### src/lib/supabase.js
- **Purpose:** Supabase client singleton
- **Exports:** Supabase client instance
- **Dependencies:** @supabase/supabase-js
- **Last modified:** 2026-02-18

### src/scripts/backfill-signal-images.js
- **Purpose:** One-time script to assign pool images to articles with null image_url
- **Usage:** `node src/scripts/backfill-signal-images.js`
- **Last modified:** 2026-03-28
