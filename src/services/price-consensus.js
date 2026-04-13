/**
 * TroyStack Composite Spot Price Engine
 *
 * Aggregates spot prices from multiple independent sources into a
 * single composite price per metal. Uses median (not mean) for
 * robustness against outlier sources.
 *
 * Sources:
 *   1. MetalPriceAPI (existing primary)
 *   2. GoldAPI.io (existing fallback)
 *   3. Yahoo Finance futures (GC=F, SI=F)
 *
 * Composite is stored in app_state as `composite_spot_latest` and
 * served via GET /v1/prices/composite.
 *
 * Cron: every 60 seconds during market hours (index.js).
 */

const axios = require('axios');
const supabase = require('../lib/supabase');
const { areMarketsClosed } = require('./price-fetcher');

// ============================================
// SOURCE FETCHERS
// ============================================

/**
 * Source 1: MetalPriceAPI (Au, Ag, Pt, Pd)
 */
async function fetchMetalPriceAPI() {
  const apiKey = process.env.METAL_PRICE_API_KEY;
  if (!apiKey) return null;

  const { data } = await axios.get(
    `https://api.metalpriceapi.com/v1/latest?api_key=${apiKey}&base=USD&currencies=XAU,XAG,XPT,XPD`,
    { timeout: 8000 }
  );

  if (!data.rates) return null;

  return {
    gold: data.rates.XAU ? Math.round((1 / data.rates.XAU) * 100) / 100 : null,
    silver: data.rates.XAG ? Math.round((1 / data.rates.XAG) * 100) / 100 : null,
    platinum: data.rates.XPT ? Math.round((1 / data.rates.XPT) * 100) / 100 : null,
    palladium: data.rates.XPD ? Math.round((1 / data.rates.XPD) * 100) / 100 : null,
    source: 'metalpriceapi',
  };
}

/**
 * Source 2: GoldAPI.io (Au, Ag only)
 */
async function fetchGoldAPI() {
  const apiKey = process.env.GOLD_API_KEY;
  if (!apiKey) return null;

  const headers = { 'x-access-token': apiKey, 'Content-Type': 'application/json' };

  const [goldRes, silverRes] = await Promise.all([
    axios.get('https://www.goldapi.io/api/XAU/USD', { headers, timeout: 8000 }),
    axios.get('https://www.goldapi.io/api/XAG/USD', { headers, timeout: 8000 }),
  ]);

  return {
    gold: goldRes.data?.price ? Math.round(goldRes.data.price * 100) / 100 : null,
    silver: silverRes.data?.price ? Math.round(silverRes.data.price * 100) / 100 : null,
    platinum: null,
    palladium: null,
    source: 'goldapi',
  };
}

/**
 * Source 3: Yahoo Finance futures (Au, Ag)
 */
async function fetchYahooFinance() {
  const headers = { 'User-Agent': 'Mozilla/5.0 (compatible; TroyStack/1.0)' };

  const [goldRes, silverRes] = await Promise.all([
    axios.get('https://query1.finance.yahoo.com/v8/finance/chart/GC=F', { headers, timeout: 8000 }).catch(() => null),
    axios.get('https://query1.finance.yahoo.com/v8/finance/chart/SI=F', { headers, timeout: 8000 }).catch(() => null),
  ]);

  const goldPrice = goldRes?.data?.chart?.result?.[0]?.meta?.regularMarketPrice;
  const silverPrice = silverRes?.data?.chart?.result?.[0]?.meta?.regularMarketPrice;

  if (!goldPrice && !silverPrice) return null;

  return {
    gold: goldPrice ? Math.round(goldPrice * 100) / 100 : null,
    silver: silverPrice ? Math.round(silverPrice * 100) / 100 : null,
    platinum: null,
    palladium: null,
    source: 'yahoo_finance',
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
  if (count >= 3 && spread < 0.5) return 'high';
  if (count >= 2) return 'medium';
  return 'low';
}

/**
 * Fetch all sources in parallel, compute median composite price per metal.
 */
async function calculateCompositePrice() {
  const results = await Promise.allSettled([
    fetchMetalPriceAPI(),
    fetchGoldAPI(),
    fetchYahooFinance(),
  ]);

  const sources = results
    .filter(r => r.status === 'fulfilled' && r.value)
    .map(r => r.value);

  if (sources.length === 0) {
    console.log('[Composite] All sources failed');
    return null;
  }

  const METALS = ['gold', 'silver', 'platinum', 'palladium'];
  const composite = {};
  const sourceDetails = [];

  for (const metal of METALS) {
    const prices = sources
      .map(s => s[metal])
      .filter(p => typeof p === 'number' && p > 0);

    const med = median(prices);
    const spread = spreadPct(prices);

    composite[metal] = {
      price: med,
      source_count: prices.length,
      spread_pct: spread,
      confidence: confidence(prices.length, spread),
      prices, // individual source prices for transparency
    };
  }

  for (const s of sources) {
    sourceDetails.push({
      source: s.source,
      gold: s.gold,
      silver: s.silver,
      platinum: s.platinum,
      palladium: s.palladium,
    });
  }

  return {
    gold: composite.gold.price,
    silver: composite.silver.price,
    platinum: composite.platinum.price,
    palladium: composite.palladium.price,
    details: composite,
    source_count: sources.length,
    sources: sourceDetails,
    calculated_at: new Date().toISOString(),
    markets_closed: areMarketsClosed(),
  };
}

// ============================================
// CRON: UPDATE COMPOSITE + STORE IN APP_STATE
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

    console.log(`[Composite] Updated: Au=$${result.gold} Ag=$${result.silver} (${result.source_count} sources, ${result.details.gold.confidence})`);
  } catch (err) {
    console.error('[Composite] Update error:', err.message);
  }
}

/**
 * Get the latest composite price (in-memory first, then app_state fallback).
 */
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
  fetchMetalPriceAPI,
  fetchGoldAPI,
  fetchYahooFinance,
};
