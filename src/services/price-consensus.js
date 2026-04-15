/**
 * TroyStack Composite Spot Price — Verification Layer
 *
 * Cross-checks the primary price cache (Yahoo Finance via price-fetcher)
 * against an independent Yahoo Finance call. Logs a warning if they
 * diverge by more than 1%.
 *
 * Sources:
 *   1. price-fetcher cache (Yahoo Finance primary, MetalPriceAPI fallback)
 *   2. Independent Yahoo Finance futures call (cross-check)
 *
 * Composite is stored in app_state as `composite_spot_latest` and
 * served via GET /v1/prices/composite.
 *
 * Cron: every 5 minutes during market hours, every 15 minutes off-hours.
 */

const axios = require('axios');
const supabase = require('../lib/supabase');
const { areMarketsClosed, getCachedPrices } = require('./price-fetcher');

// ============================================
// INDEPENDENT YAHOO FINANCE CALL (cross-check)
// ============================================

async function fetchYahooFinanceCrossCheck() {
  const headers = { 'User-Agent': 'Mozilla/5.0 (compatible; TroyStack/1.0)' };

  const [goldRes, silverRes] = await Promise.all([
    axios.get('https://query1.finance.yahoo.com/v8/finance/chart/GC=F', { headers, timeout: 8000 }).catch(() => null),
    axios.get('https://query1.finance.yahoo.com/v8/finance/chart/SI=F', { headers, timeout: 8000 }).catch(() => null),
  ]);

  const gold = goldRes?.data?.chart?.result?.[0]?.meta?.regularMarketPrice;
  const silver = silverRes?.data?.chart?.result?.[0]?.meta?.regularMarketPrice;

  return {
    gold: gold ? Math.round(gold * 100) / 100 : null,
    silver: silver ? Math.round(silver * 100) / 100 : null,
    source: 'yahoo_finance_crosscheck',
  };
}

// ============================================
// COMPOSITE CALCULATION
// ============================================

function median(arr) {
  if (!arr.length) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0
    ? sorted[mid]
    : Math.round(((sorted[mid - 1] + sorted[mid]) / 2) * 100) / 100;
}

function spreadPct(arr) {
  if (arr.length < 2) return 0;
  const min = Math.min(...arr);
  const max = Math.max(...arr);
  return min > 0 ? Math.round(((max - min) / min) * 10000) / 100 : 0;
}

function confidence(count, spread) {
  if (count >= 2 && spread < 0.5) return 'high';
  if (count >= 2) return 'medium';
  return 'low';
}

async function calculateCompositePrice() {
  // Source 1: existing price-fetcher cache
  const cached = getCachedPrices();

  // Source 2: independent Yahoo Finance cross-check
  let crossCheck = { gold: null, silver: null };
  try {
    crossCheck = await fetchYahooFinanceCrossCheck();
  } catch { /* cross-check is optional */ }

  const sources = [];

  if (cached?.gold && cached?.silver) {
    sources.push({ gold: cached.gold, silver: cached.silver, platinum: cached.platinum, palladium: cached.palladium, source: 'price_fetcher_cache' });
  }

  if (crossCheck.gold && crossCheck.silver) {
    sources.push({ gold: crossCheck.gold, silver: crossCheck.silver, platinum: null, palladium: null, source: 'yahoo_finance_crosscheck' });
  }

  if (sources.length === 0) return null;

  // Divergence warning
  if (sources.length >= 2) {
    const goldDivergence = cached.gold > 0 ? Math.abs(cached.gold - crossCheck.gold) / cached.gold : 0;
    const silverDivergence = cached.silver > 0 ? Math.abs(cached.silver - crossCheck.silver) / cached.silver : 0;
    if (goldDivergence > 0.01) {
      console.log(`[Composite] WARNING: Gold divergence ${(goldDivergence * 100).toFixed(2)}% — cache: $${cached.gold}, cross-check: $${crossCheck.gold}`);
    }
    if (silverDivergence > 0.01) {
      console.log(`[Composite] WARNING: Silver divergence ${(silverDivergence * 100).toFixed(2)}% — cache: $${cached.silver}, cross-check: $${crossCheck.silver}`);
    }
  }

  const METALS = ['gold', 'silver', 'platinum', 'palladium'];
  const details = {};

  for (const metal of METALS) {
    const prices = sources.map(s => s[metal]).filter(p => typeof p === 'number' && p > 0);
    const med = median(prices);
    const spread = spreadPct(prices);
    details[metal] = { price: med, source_count: prices.length, spread_pct: spread, confidence: confidence(prices.length, spread), prices };
  }

  return {
    gold: details.gold.price,
    silver: details.silver.price,
    platinum: details.platinum.price,
    palladium: details.palladium.price,
    details,
    source_count: sources.length,
    sources: sources.map(s => ({ source: s.source, gold: s.gold, silver: s.silver, platinum: s.platinum, palladium: s.palladium })),
    calculated_at: new Date().toISOString(),
    markets_closed: areMarketsClosed(),
  };
}

// ============================================
// UPDATE + CACHE
// ============================================

let _lastComposite = null;

async function updateCompositePrice() {
  try {
    const result = await calculateCompositePrice();
    if (!result) return;

    _lastComposite = result;

    await supabase
      .from('app_state')
      .upsert({
        key: 'composite_spot_latest',
        value: JSON.stringify(result),
      }, { onConflict: 'key' });
  } catch (err) {
    console.error('[Composite] Update error:', err.message);
  }
}

async function getCompositePrice() {
  if (_lastComposite) return _lastComposite;

  try {
    const { data } = await supabase
      .from('app_state')
      .select('value')
      .eq('key', 'composite_spot_latest')
      .single();

    if (data?.value) {
      _lastComposite = typeof data.value === 'string' ? JSON.parse(data.value) : data.value;
      return _lastComposite;
    }
  } catch { /* no stored composite yet */ }

  return null;
}

module.exports = {
  calculateCompositePrice,
  updateCompositePrice,
  getCompositePrice,
};
