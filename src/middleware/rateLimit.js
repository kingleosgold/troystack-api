const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = rateLimit;
const supabase = require('../lib/supabase');

// Public endpoints: 100 requests/min per IP
const publicLimiterCore = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
});

// index.js mounts the public limiter on overlapping prefixes ('/v1', '/',
// '/v1/troy' and more), so one request used to pass it up to eight times (a
// Troy chat call, seven) and one app launch could spend the whole minute's
// budget. Count each request once, wherever it first meets the limiter.
function publicLimiter(req, res, next) {
  if (req.publicLimitCounted) return next();
  req.publicLimitCounted = true;
  return publicLimiterCore(req, res, next);
}

// Authenticated endpoints: 30 requests/min per user
const authenticatedLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.userId || ipKeyGenerator(req.ip),
  message: { error: 'Too many requests, please try again later.' },
});

// Developer API: rate limit per tier from api_keys table
const TIER_LIMITS = {
  free: 100,       // 100/hr
  pro: 1000,       // 1000/hr
  enterprise: 10000, // 10000/hr
};

const developerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: (req) => {
    const tier = req.tier || 'free';
    return TIER_LIMITS[tier] || TIER_LIMITS.free;
  },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.apiKeyId || req.userId || ipKeyGenerator(req.ip),
  message: { error: 'Rate limit exceeded for your API tier. Upgrade for higher limits.' },
});

module.exports = { publicLimiter, authenticatedLimiter, developerLimiter };
