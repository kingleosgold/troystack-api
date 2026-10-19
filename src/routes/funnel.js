const rateLimit = require('express-rate-limit');

// Daily counts of the steps from troystack.ai's Gold page to an open
// checkout, kept in funnel_counts (migration 010). The site counts the page
// view, the plan tap and the sign-up. The API counts a checkout it opened,
// so that step can't be counted from a browser.

const SITE_STEPS = new Set(['gold_view', 'plan_tap', 'signup']);
const PLANS = new Set(['monthly', 'yearly', 'lifetime']);

function cleanPlan(value) {
  return PLANS.has(value) ? value : '';
}

function cleanSurface(value) {
  return typeof value === 'string' && /^[a-z0-9-]{1,40}$/.test(value) ? value : '';
}

/** Adds one to today's count for a step. Never throws, since a lost count mustn't stop the page or checkout. */
async function bumpFunnel(supabase, { step, plan, campaign }, now = new Date()) {
  try {
    const { error } = await supabase.rpc('bump_funnel_count', {
      p_day: now.toISOString().slice(0, 10),
      p_step: step,
      p_plan: cleanPlan(plan),
      p_campaign: cleanSurface(campaign),
    });
    if (error) throw new Error(error.message);
    return true;
  } catch (err) {
    console.warn(`[Funnel] Could not count ${step}:`, err.message);
    return false;
  }
}

// Each visitor's browser sends a few of these a visit. More than that from
// one address is someone running the count up.
const funnelLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
});

function createFunnelHandler({ supabase }) {
  return async (req, res) => {
    const body = req.body || {};
    if (!SITE_STEPS.has(body.step)) {
      return res.status(400).json({ error: 'step must be gold_view, plan_tap or signup' });
    }
    await bumpFunnel(supabase, { step: body.step, plan: body.plan, campaign: body.campaign });
    return res.status(204).end();
  };
}

module.exports = { bumpFunnel, createFunnelHandler, funnelLimiter };
