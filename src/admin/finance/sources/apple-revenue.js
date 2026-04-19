const supabase = require('../../../lib/supabase');
const { defineCostSource } = require('../define-source');

// Apple App Store commission, Small Business Program rate.
const APPLE_COMMISSION_RATE = 0.15;

// Phase 1: we don't yet have revenue_snapshots populated (Phase 2), so this
// source cannot compute exact per-renewal fees. It reports active-subscriber
// counts + the commission rate, and returns amount_cents = 0 with details
// explaining the gap. UI should render it as 'derived' and hide from totals
// until Phase 2 wires real revenue data through.
module.exports = defineCostSource({
  id: 'apple_fees',
  category: 'payment_processing',
  label: 'Apple App Store (derived)',
  source_type: 'derived',
  async fetch() {
    const [goldResp, lifetimeResp] = await Promise.all([
      supabase.from('profiles')
        .select('*', { count: 'exact', head: true })
        .eq('subscription_tier', 'gold')
        .eq('subscription_status', 'active'),
      supabase.from('profiles')
        .select('*', { count: 'exact', head: true })
        .eq('subscription_tier', 'lifetime')
        .eq('subscription_status', 'active'),
    ]);

    if (goldResp.error) throw new Error(`profiles.gold query: ${goldResp.error.message}`);
    if (lifetimeResp.error) throw new Error(`profiles.lifetime query: ${lifetimeResp.error.message}`);

    const goldCount = goldResp.count || 0;
    const lifetimeCount = lifetimeResp.count || 0;

    return {
      amount_cents: 0,
      units: goldCount + lifetimeCount,
      unit_type: 'subscribers',
      details:
        `Placeholder — Phase 1 lacks revenue_snapshots for per-renewal fee calc. ` +
        `Active subs: ${goldCount} gold + ${lifetimeCount} lifetime. ` +
        `Commission: ${(APPLE_COMMISSION_RATE * 100).toFixed(0)}% (Small Business Program).`,
      raw_data: {
        active_gold: goldCount,
        active_lifetime: lifetimeCount,
        commission_rate: APPLE_COMMISSION_RATE,
      },
    };
  },
});
