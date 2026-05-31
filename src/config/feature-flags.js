/**
 * Centralized feature flags.
 *
 * X_DISTRIBUTION_ENABLED — master switch for X (Twitter) distribution.
 * When false:
 *   - the Stack Signal pipeline does NOT enqueue tweets (stack-signal-processor.js),
 *   - the auto-tweet / Twitter-scraper / weekly-thread crons are disabled (index.js),
 *   - the downstream admin health checks that look for X-derived data skip
 *     themselves instead of going red (intelligence / distribution / database checks).
 *
 * Disabled 2026-05-30 — see X_API_AUDIT_2026-05-30.md. Re-enable when X strategy
 * is redefined (flip this one constant back to true and uncomment the crons in
 * src/index.js).
 */
const X_DISTRIBUTION_ENABLED = false;

module.exports = { X_DISTRIBUTION_ENABLED };
