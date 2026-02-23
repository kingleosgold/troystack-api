/**
 * ETF Price Service — ported from old backend
 *
 * Fetches historical SLV/GLD/PPLT/PALL ETF data from Yahoo Finance
 * and converts to estimated spot prices using calibrated ratios.
 *
 * Key facts:
 * - SLV launched April 2006, GLD launched November 2004
 * - Each SLV share ≈ 0.92 oz silver (erodes ~0.5%/year due to expense ratio)
 * - Each GLD share ≈ 0.092 oz gold (1/10th oz, also erodes slowly)
 */

const yahooFinance = require('yahoo-finance2').default;
const supabase = require('../lib/supabase');

// Default conversion ratios (calibrated daily when possible)
const DEFAULT_SLV_RATIO = 0.92;
const DEFAULT_GLD_RATIO = 0.092;
const DEFAULT_PPLT_RATIO = 0.096;
const DEFAULT_PALL_RATIO = 0.096;

// ============================================
// ETF HISTORICAL DATA
// ============================================

async function fetchETFHistorical(symbol, dateString) {
  try {
    // Check Supabase cache first
    try {
      const { data: cached } = await supabase
        .from('etf_daily_cache')
        .select('*')
        .eq('symbol', symbol)
        .eq('date', dateString)
        .single();

      if (cached) {
        return {
          open: parseFloat(cached.open_price),
          high: parseFloat(cached.high_price),
          low: parseFloat(cached.low_price),
          close: parseFloat(cached.close_price),
          volume: cached.volume,
          date: new Date(cached.date),
        };
      }
    } catch (e) { /* cache miss, continue */ }

    const date = new Date(dateString);
    const nextDay = new Date(date);
    nextDay.setDate(nextDay.getDate() + 1);

    const result = await yahooFinance.historical(symbol, {
      period1: date,
      period2: nextDay,
      interval: '1d',
    });

    if (result && result.length > 0) {
      const data = {
        open: result[0].open,
        high: result[0].high,
        low: result[0].low,
        close: result[0].close,
        volume: result[0].volume,
        date: result[0].date,
      };

      // Cache for future use (non-blocking)
      supabase
        .from('etf_daily_cache')
        .upsert({
          symbol,
          date: dateString,
          open_price: data.open,
          high_price: data.high,
          low_price: data.low,
          close_price: data.close,
          volume: data.volume,
        }, { onConflict: 'symbol,date' })
        .then(() => {})
        .catch(() => {});

      return data;
    }

    return null;
  } catch (error) {
    console.error(`ETF fetch error ${symbol} ${dateString}:`, error.message);
    return null;
  }
}

async function fetchAllETFs(dateString) {
  const [slvData, gldData, ppltData, pallData] = await Promise.all([
    fetchETFHistorical('SLV', dateString),
    fetchETFHistorical('GLD', dateString),
    fetchETFHistorical('PPLT', dateString).catch(() => null),
    fetchETFHistorical('PALL', dateString).catch(() => null),
  ]);
  return { slv: slvData, gld: gldData, pplt: ppltData, pall: pallData };
}

// ============================================
// ETF → SPOT CONVERSIONS
// ============================================

function slvToSpotSilver(slvPrice, ratio = DEFAULT_SLV_RATIO) {
  if (!slvPrice || !ratio) return null;
  return slvPrice / ratio;
}

function gldToSpotGold(gldPrice, ratio = DEFAULT_GLD_RATIO) {
  if (!gldPrice || !ratio) return null;
  return gldPrice / ratio;
}

function ppltToSpotPlatinum(ppltPrice, ratio = DEFAULT_PPLT_RATIO) {
  if (!ppltPrice || !ratio) return null;
  return ppltPrice / ratio;
}

function pallToSpotPalladium(pallPrice, ratio = DEFAULT_PALL_RATIO) {
  if (!pallPrice || !ratio) return null;
  return pallPrice / ratio;
}

// ============================================
// RATIO CALIBRATION
// ============================================

async function getRatioForDate(dateString) {
  // Try etf_ratios table for the nearest ratio on or before date
  try {
    const { data } = await supabase
      .from('etf_ratios')
      .select('*')
      .lte('date', dateString)
      .order('date', { ascending: false })
      .limit(1)
      .single();

    if (data) {
      return {
        slv_ratio: parseFloat(data.slv_ratio),
        gld_ratio: parseFloat(data.gld_ratio),
        pplt_ratio: data.pplt_ratio ? parseFloat(data.pplt_ratio) : DEFAULT_PPLT_RATIO,
        pall_ratio: data.pall_ratio ? parseFloat(data.pall_ratio) : DEFAULT_PALL_RATIO,
      };
    }
  } catch (e) { /* table may not exist yet, fall through */ }

  return {
    slv_ratio: DEFAULT_SLV_RATIO,
    gld_ratio: DEFAULT_GLD_RATIO,
    pplt_ratio: DEFAULT_PPLT_RATIO,
    pall_ratio: DEFAULT_PALL_RATIO,
  };
}

module.exports = {
  fetchAllETFs,
  slvToSpotSilver,
  gldToSpotGold,
  ppltToSpotPlatinum,
  pallToSpotPalladium,
  getRatioForDate,
  DEFAULT_SLV_RATIO,
  DEFAULT_GLD_RATIO,
  DEFAULT_PPLT_RATIO,
  DEFAULT_PALL_RATIO,
};
