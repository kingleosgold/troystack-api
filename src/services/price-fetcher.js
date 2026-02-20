const axios = require('axios');
const supabase = require('../lib/supabase');

// ============================================
// IN-MEMORY CACHE
// ============================================

const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

let spotPriceCache = {
  prices: { gold: 5100, silver: 107, platinum: 2700, palladium: 2000 },
  lastUpdated: null,
  source: 'static-fallback',
  change: { gold: {}, silver: {}, platinum: {}, palladium: {}, source: 'unavailable' },
  marketsClosed: false,
};

let fridayCloseData = null;
let previousDayPrices = { gold: 0, silver: 0, platinum: 0, palladium: 0, date: null };
let lastSavedDate = null;

// ============================================
// MARKET HOURS DETECTION
// ============================================

/**
 * Check if precious metals markets are currently closed.
 * Markets open: Sunday 6pm ET through Friday 5pm ET.
 * Markets closed: Friday 5pm ET through Sunday 6pm ET.
 */
function areMarketsClosed() {
  const now = new Date();
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour12: false,
    weekday: 'short',
    hour: 'numeric',
    minute: 'numeric',
  });
  const parts = {};
  for (const p of fmt.formatToParts(now)) {
    parts[p.type] = p.value;
  }

  const dayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const dayOfWeek = dayMap[parts.weekday];
  const hour = parseInt(parts.hour, 10);

  const closed = (
    dayOfWeek === 6 ||
    (dayOfWeek === 0 && hour < 18) ||
    (dayOfWeek === 5 && hour >= 17)
  );

  return closed;
}

// ============================================
// LAST TRADING DAY
// ============================================

/**
 * Get the last trading day (skips weekends).
 * Monday → Friday, Sunday → Friday, otherwise → yesterday.
 */
function getLastTradingDay() {
  const today = new Date();
  let daysBack = 1;
  if (today.getDay() === 0) daysBack = 2;       // Sunday → Friday
  else if (today.getDay() === 1) daysBack = 3;  // Monday → Friday

  const lastTrading = new Date(today);
  lastTrading.setDate(today.getDate() - daysBack);
  return lastTrading.toISOString().split('T')[0];
}

/**
 * Get yesterday's prices for change calculation.
 * Checks in-memory cache first, then falls back to price_log in Supabase.
 */
async function getYesterdayPrices() {
  const today = new Date().toISOString().split('T')[0];

  // Check in-memory first
  if (previousDayPrices.date && previousDayPrices.date < today && previousDayPrices.gold > 0) {
    return previousDayPrices;
  }

  // Fallback: check price_log for last trading day
  try {
    const lastTradingDay = getLastTradingDay();
    const dayStart = `${lastTradingDay}T00:00:00.000Z`;
    const dayEnd = `${lastTradingDay}T23:59:59.999Z`;

    const { data, error } = await supabase
      .from('price_log')
      .select('gold_price, silver_price, platinum_price, palladium_price')
      .gte('timestamp', dayStart)
      .lte('timestamp', dayEnd)
      .order('timestamp', { ascending: false })
      .limit(1)
      .single();

    if (!error && data && data.gold_price > 0) {
      const result = {
        gold: parseFloat(data.gold_price),
        silver: parseFloat(data.silver_price),
        platinum: data.platinum_price ? parseFloat(data.platinum_price) : 0,
        palladium: data.palladium_price ? parseFloat(data.palladium_price) : 0,
        date: lastTradingDay,
      };
      previousDayPrices = result;
      return result;
    }
  } catch (err) {
    console.log('   Could not fetch last trading day prices:', err.message);
  }

  return null;
}

/**
 * Save current prices for tomorrow's change calculation.
 * Only saves once per day.
 */
function savePreviousDayPrices(gold, silver, platinum, palladium) {
  const today = new Date().toISOString().split('T')[0];
  if (lastSavedDate === today || !gold || !silver) return;
  lastSavedDate = today;
  previousDayPrices = { gold, silver, platinum: platinum || 0, palladium: palladium || 0, date: today };
}

// ============================================
// CHANGE CALCULATION
// ============================================

/**
 * Calculate change data for all 4 metals given current prices and yesterday's prices.
 */
function calculateChanges(current, yesterday) {
  const calc = (cur, prev) => {
    if (!prev || prev === 0) return {};
    const amount = Math.round((cur - prev) * 100) / 100;
    const percent = Math.round(((cur - prev) / prev) * 10000) / 100;
    return { amount, percent, prevClose: prev };
  };

  return {
    gold: calc(current.gold, yesterday?.gold),
    silver: calc(current.silver, yesterday?.silver),
    platinum: calc(current.platinum, yesterday?.platinum),
    palladium: calc(current.palladium, yesterday?.palladium),
    source: yesterday ? 'calculated' : 'unavailable',
  };
}

// ============================================
// FRIDAY CLOSE
// ============================================

/**
 * Save current prices as Friday close for weekend use.
 * Persists to Supabase so it survives Railway redeploys.
 */
async function saveFridayClose(data) {
  fridayCloseData = { ...data, savedAt: new Date().toISOString() };
  try {
    await supabase
      .from('app_state')
      .upsert({ key: 'friday_close', value: fridayCloseData }, { onConflict: 'key' });
    console.log('   Saved Friday close prices to Supabase');
  } catch (err) {
    console.log('   Could not persist Friday close:', err.message);
  }
}

/**
 * Load Friday close data from Supabase (called on startup).
 */
async function loadFridayClose() {
  try {
    const { data, error } = await supabase
      .from('app_state')
      .select('value')
      .eq('key', 'friday_close')
      .single();
    if (!error && data && data.value) {
      fridayCloseData = data.value;
      console.log('   Loaded Friday close from Supabase');
    }
  } catch (err) {
    console.log('   No Friday close data in Supabase:', err.message);
  }
}

function getFridayClose() {
  return fridayCloseData;
}

// ============================================
// PRICE FETCHING: PRIORITY CHAIN
// ============================================

/**
 * Priority 1: MetalPriceAPI
 */
async function fetchFromMetalPriceAPI() {
  const apiKey = process.env.METAL_PRICE_API_KEY;
  if (!apiKey) throw new Error('No METAL_PRICE_API_KEY configured');

  console.log('   Attempting MetalPriceAPI (primary)...');
  const response = await axios.get(
    `https://api.metalpriceapi.com/v1/latest?api_key=${apiKey}&base=USD&currencies=XAU,XAG,XPT,XPD`,
    { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; StackTrackerGold/1.0)', Accept: 'application/json' }, timeout: 10000 }
  );

  const data = response.data;
  let gold, silver, platinum, palladium;

  if (data.rates) {
    gold = data.rates.XAU ? Math.round((1 / data.rates.XAU) * 100) / 100 : null;
    silver = data.rates.XAG ? Math.round((1 / data.rates.XAG) * 100) / 100 : null;
    platinum = data.rates.XPT ? Math.round((1 / data.rates.XPT) * 100) / 100 : null;
    palladium = data.rates.XPD ? Math.round((1 / data.rates.XPD) * 100) / 100 : null;
  }

  if (!gold || !silver) throw new Error('MetalPriceAPI returned no gold/silver prices');

  return {
    gold, silver,
    platinum: platinum || 2700,
    palladium: palladium || 2000,
    source: 'metalpriceapi',
  };
}

/**
 * Priority 2: GoldAPI.io (gold + silver only, includes change data)
 */
async function fetchFromGoldAPI() {
  const apiKey = process.env.GOLD_API_KEY;
  if (!apiKey) throw new Error('No GOLD_API_KEY configured');

  console.log('   Attempting GoldAPI.io (fallback)...');
  const headers = { 'x-access-token': apiKey, 'Content-Type': 'application/json' };

  const [goldRes, silverRes] = await Promise.all([
    axios.get('https://www.goldapi.io/api/XAU/USD', { headers, timeout: 10000 }),
    axios.get('https://www.goldapi.io/api/XAG/USD', { headers, timeout: 10000 }),
  ]);

  if (!goldRes.data?.price || !silverRes.data?.price) {
    throw new Error('GoldAPI returned no price data');
  }

  // GoldAPI provides change data directly
  const change = {
    gold: {
      amount: goldRes.data.ch ? Math.round(goldRes.data.ch * 100) / 100 : null,
      percent: goldRes.data.chp ? Math.round(goldRes.data.chp * 100) / 100 : null,
      prevClose: goldRes.data.prev_close_price ? Math.round(goldRes.data.prev_close_price * 100) / 100 : null,
    },
    silver: {
      amount: silverRes.data.ch ? Math.round(silverRes.data.ch * 100) / 100 : null,
      percent: silverRes.data.chp ? Math.round(silverRes.data.chp * 100) / 100 : null,
      prevClose: silverRes.data.prev_close_price ? Math.round(silverRes.data.prev_close_price * 100) / 100 : null,
    },
    platinum: {},
    palladium: {},
    source: 'goldapi-io',
  };

  return {
    gold: Math.round(goldRes.data.price * 100) / 100,
    silver: Math.round(silverRes.data.price * 100) / 100,
    platinum: 2700,
    palladium: 2000,
    source: 'goldapi-io',
    change,
  };
}

// ============================================
// MAIN FETCH FUNCTION
// ============================================

/**
 * Fetch live spot prices with priority fallback chain.
 * Updates the in-memory cache, logs to price_log, handles Friday close.
 */
async function fetchLiveSpotPrices() {
  try {
    console.log('\n💰 [Price Fetcher] Fetching live spot prices...');

    let fetched = null;

    // Priority 1: MetalPriceAPI
    try {
      fetched = await fetchFromMetalPriceAPI();
      console.log(`   MetalPriceAPI: Gold $${fetched.gold}, Silver $${fetched.silver}, Pt $${fetched.platinum}, Pd $${fetched.palladium}`);
    } catch (err) {
      console.log(`   MetalPriceAPI failed: ${err.message}`);
    }

    // Priority 2: GoldAPI.io
    if (!fetched) {
      try {
        fetched = await fetchFromGoldAPI();
        console.log(`   GoldAPI.io: Gold $${fetched.gold}, Silver $${fetched.silver}`);
      } catch (err) {
        console.log(`   GoldAPI.io failed: ${err.message}`);
      }
    }

    // Priority 3: Use last cached prices
    if (!fetched && spotPriceCache.lastUpdated) {
      console.log('   Using last cached prices (all APIs failed)');
      fetched = {
        ...spotPriceCache.prices,
        source: 'cached-fallback',
      };
    }

    // Priority 4: Static fallback
    if (!fetched) {
      console.log('   All APIs failed, no cache — using static fallback');
      fetched = {
        gold: 5100, silver: 107, platinum: 2700, palladium: 2000,
        source: 'static-fallback',
      };
    }

    // Calculate change data (if not provided by GoldAPI)
    let changeData = fetched.change || null;
    if (!changeData || changeData.source !== 'goldapi-io') {
      const yesterday = await getYesterdayPrices();
      changeData = calculateChanges(fetched, yesterday);
    }

    // Save for tomorrow's change calc
    savePreviousDayPrices(fetched.gold, fetched.silver, fetched.platinum, fetched.palladium);

    const marketsClosed = areMarketsClosed();

    // Update cache
    spotPriceCache = {
      prices: { gold: fetched.gold, silver: fetched.silver, platinum: fetched.platinum, palladium: fetched.palladium },
      lastUpdated: new Date(),
      source: fetched.source,
      change: changeData,
      marketsClosed,
    };

    console.log(`   Prices updated: Gold $${fetched.gold}, Silver $${fetched.silver} [${fetched.source}]${marketsClosed ? ' [MARKETS CLOSED]' : ''}`);

    // Save as Friday close if it's Friday afternoon (after 4pm ET)
    const etFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour12: false, weekday: 'short', hour: 'numeric' });
    const etParts = {};
    for (const p of etFmt.formatToParts(new Date())) etParts[p.type] = p.value;
    const dayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    if (dayMap[etParts.weekday] === 5 && parseInt(etParts.hour) >= 16) {
      console.log('   Friday afternoon — saving as Friday close');
      await saveFridayClose({
        prices: spotPriceCache.prices,
        timestamp: spotPriceCache.lastUpdated.toISOString(),
        source: spotPriceCache.source,
        change: spotPriceCache.change,
      });
    }

    // Log to price_log (non-blocking)
    logPriceToSupabase(spotPriceCache.prices, fetched.source).catch(err => {
      console.log('   Price log skipped:', err.message);
    });

    return spotPriceCache;

  } catch (error) {
    console.error('   Failed to fetch spot prices:', error.message);

    if (spotPriceCache.lastUpdated) {
      console.log('   Using last cached prices (fetch error)');
      return spotPriceCache;
    }

    spotPriceCache.prices = { gold: 5100, silver: 107, platinum: 2700, palladium: 2000 };
    spotPriceCache.lastUpdated = new Date();
    spotPriceCache.source = 'static-fallback';
    return spotPriceCache;
  }
}

// ============================================
// PRICE_LOG WRITER
// ============================================

/**
 * Write current prices to price_log table in Supabase.
 */
async function logPriceToSupabase(prices, source) {
  if (!prices || !prices.gold || !prices.silver) return;

  const now = new Date().toISOString();
  const { error } = await supabase
    .from('price_log')
    .insert({
      timestamp: now,
      gold_price: prices.gold,
      silver_price: prices.silver,
      platinum_price: prices.platinum || null,
      palladium_price: prices.palladium || null,
      source: source || 'unknown',
    });

  if (error) {
    console.log('   price_log insert error:', error.message);
  } else {
    console.log(`   price_log: Gold $${prices.gold}, Silver $${prices.silver} [${source}]`);
  }
}

// ============================================
// PUBLIC API: GET CACHED OR FRESH PRICES
// ============================================

/**
 * Get prices — returns cached if fresh (<10min), otherwise fetches.
 * This is the main function called by the /v1/prices route.
 */
async function getSpotPrices() {
  const marketsClosed = areMarketsClosed();

  // If markets closed, return Friday close data if available
  if (marketsClosed) {
    let friday = getFridayClose();

    // If no Friday close but we have cached data, save it as Friday close
    if (!friday && spotPriceCache.lastUpdated) {
      await saveFridayClose({
        prices: spotPriceCache.prices,
        timestamp: spotPriceCache.lastUpdated.toISOString(),
        source: spotPriceCache.source,
        change: spotPriceCache.change,
      });
      friday = getFridayClose();
    }

    if (friday) {
      return {
        prices: friday.prices,
        timestamp: friday.timestamp,
        source: friday.source + ' (friday-close)',
        cacheAgeMinutes: 0,
        change: friday.change || { gold: {}, silver: {}, platinum: {}, palladium: {}, source: 'unavailable' },
        marketsClosed: true,
      };
    }
    // No Friday close — fall through to fetch
  }

  // Check cache TTL
  const cacheAge = spotPriceCache.lastUpdated
    ? Date.now() - spotPriceCache.lastUpdated.getTime()
    : Infinity;

  if (cacheAge < CACHE_TTL_MS) {
    return {
      prices: spotPriceCache.prices,
      timestamp: spotPriceCache.lastUpdated.toISOString(),
      source: spotPriceCache.source,
      cacheAgeMinutes: Math.round((cacheAge / 60000) * 10) / 10,
      change: spotPriceCache.change,
      marketsClosed,
    };
  }

  // Cache stale — fetch fresh
  await fetchLiveSpotPrices();

  return {
    prices: spotPriceCache.prices,
    timestamp: spotPriceCache.lastUpdated ? spotPriceCache.lastUpdated.toISOString() : new Date().toISOString(),
    source: spotPriceCache.source,
    cacheAgeMinutes: 0,
    change: spotPriceCache.change,
    marketsClosed: spotPriceCache.marketsClosed,
  };
}

/**
 * Get raw cached prices (for other modules like alerts).
 */
function getCachedPrices() {
  return spotPriceCache.prices;
}

/**
 * Initialize the price fetcher: load Friday close, fetch initial prices.
 */
async function initPriceFetcher() {
  await loadFridayClose();
  await fetchLiveSpotPrices();
  console.log('💰 [Price Fetcher] Initialized');
}

module.exports = {
  getSpotPrices,
  getCachedPrices,
  fetchLiveSpotPrices,
  initPriceFetcher,
  areMarketsClosed,
  logPriceToSupabase,
};
