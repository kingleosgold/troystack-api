const axios = require('axios');
const supabase = require('../lib/supabase');

// ============================================
// IN-MEMORY CACHE
// ============================================

const CACHE_TTL_MS = 90 * 1000; // 90 seconds (Yahoo Finance is free, so we poll every 60s)

let spotPriceCache = {
  prices: { gold: 5150, silver: 87, platinum: 2170, palladium: 1780 },
  lastUpdated: null,
  // When the prices were last read from a live source, as an ISO string, or
  // null if they never were. lastUpdated moves with every fetch, failed ones
  // too, so it can't say how old the prices are.
  quotedAt: null,
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
const marketFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  weekday: 'short',
  hour: 'numeric',
  hourCycle: 'h23',
});

function areMarketsClosed() {
  const parts = {};
  for (const p of marketFmt.formatToParts(new Date())) {
    parts[p.type] = p.value;
  }

  const dayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const dayOfWeek = dayMap[parts.weekday];
  const hour = parseInt(parts.hour, 10);

  return (
    dayOfWeek === 6 ||
    (dayOfWeek === 0 && hour < 18) ||
    (dayOfWeek === 5 && hour >= 17)
  );
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
 * `isCurrent` is false once the fetch asking has been replaced by a newer
 * one, and then what it read isn't kept.
 */
async function getYesterdayPrices(isCurrent = () => true) {
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
      if (isCurrent()) previousDayPrices = result;
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

// Friday close writes to app_state go out one at a time, in the order the
// closes were made. A write that stalls holds back the next one until it
// settles, so it can't land after a newer close, and a close that's been
// replaced by the time its write's turn comes isn't written at all.
let fridayCloseWrites = Promise.resolve();

// Whether the startup read of the stored close has come back, found or not.
let storedCloseLoaded = false;

// Built-in prices were never read from a live source, so they're never saved
// as the Friday close or loaded as one.
function isBuiltInClose(close) {
  return close.source === 'static-fallback';
}

/**
 * Save current prices as Friday close for weekend use.
 * Persists to Supabase so it survives Railway redeploys. The close is kept in
 * memory at once and its write waits its turn, so callers don't wait on it.
 * `isCurrent` is false once the fetch saving it has been replaced, and then
 * nothing is saved. Nothing is saved from built-in prices either.
 */
function saveFridayClose(data, isCurrent = () => true) {
  if (!isCurrent()) return;
  if (isBuiltInClose(data)) {
    console.log('   Prices are built-in, so the Friday close is left as it was');
    return;
  }
  const close = { ...data, savedAt: new Date().toISOString() };
  fridayCloseData = close;
  fridayCloseWrites = fridayCloseWrites.then(async () => {
    if (fridayCloseData !== close) return;
    try {
      await supabase
        .from('app_state')
        .upsert({ key: 'friday_close', value: close }, { onConflict: 'key' });
      console.log('   Saved Friday close prices to Supabase');
    } catch (err) {
      console.log('   Could not persist Friday close:', err.message);
    }
  });
}

/**
 * Load Friday close data from Supabase (called on startup).
 * A fetch can save a close while this read is out, and the stored close only
 * replaces that one when it's newer. A stored close on built-in prices isn't
 * used.
 */
async function loadFridayClose() {
  try {
    const { data, error } = await supabase
      .from('app_state')
      .select('value')
      .eq('key', 'friday_close')
      .single();
    if (!error && data && data.value) {
      if (isBuiltInClose(data.value)) {
        console.log("   The stored Friday close is on built-in prices, so it isn't used");
        return;
      }
      if (fridayCloseData && !isNewerFridayClose(data.value, fridayCloseData)) {
        console.log("   Kept the Friday close saved since startup, the stored one isn't newer");
        return;
      }
      fridayCloseData = data.value;
      console.log('   Loaded Friday close from Supabase');
    }
  } catch (err) {
    console.log('   No Friday close data in Supabase:', err.message);
  } finally {
    storedCloseLoaded = true;
  }
}

function getFridayClose() {
  return fridayCloseData;
}

// When a saved Friday close's prices were read live. A close saved before
// quotedAt was kept has only the time it was saved. That's the same time
// when its source was live, and unknown when it was a fallback.
function fridayQuotedAt(friday) {
  if (friday.quotedAt !== undefined) return friday.quotedAt;
  return /fallback/.test(String(friday.source || '')) ? null : friday.timestamp || null;
}

// Whether close `a` is newer than close `b`. The one whose prices were read
// live later wins, and a close with no known live read counts as oldest. On a
// tie, the one saved later wins.
function isNewerFridayClose(a, b) {
  const time = (iso) => Date.parse(iso || '') || 0;
  const quotedA = time(fridayQuotedAt(a));
  const quotedB = time(fridayQuotedAt(b));
  if (quotedA !== quotedB) return quotedA > quotedB;
  return time(a.savedAt || a.timestamp) > time(b.savedAt || b.timestamp);
}

// ============================================
// LAST KNOWN Pt/Pd FROM PRICE_LOG
// ============================================

let lastKnownPtPd = { platinum: 2150, palladium: 1750 };

async function getLastKnownPtPd() {
  try {
    const { data, error } = await supabase
      .from('price_log')
      .select('platinum_price, palladium_price')
      .gt('platinum_price', 0)
      .order('timestamp', { ascending: false })
      .limit(1)
      .single();

    if (!error && data) {
      if (data.platinum_price > 0) lastKnownPtPd.platinum = parseFloat(data.platinum_price);
      if (data.palladium_price > 0) lastKnownPtPd.palladium = parseFloat(data.palladium_price);
    }
  } catch (err) {
    console.log('   Could not fetch last Pt/Pd from price_log:', err.message);
  }
  return lastKnownPtPd;
}

// ============================================
// PRICE FETCHING: PRIORITY CHAIN
// Yahoo Finance (free, unlimited) → MetalPriceAPI (fallback) → cache → static
// ============================================

/**
 * Priority 1: Yahoo Finance futures (free, no API key), all four metals.
 * GC=F, SI=F, PL=F and PA=F are the front-month gold, silver, platinum and
 * palladium contracts. Gold and silver must come back or this source fails.
 * Platinum and palladium fall back to MetalPriceAPI, then to the last live
 * value. They used to come only from MetalPriceAPI, polled every minute,
 * and when that stopped answering they froze at a months-old price.
 */
async function fetchFromYahooFinance(isCurrent = () => true) {
  console.log('   Attempting Yahoo Finance (primary)...');
  const headers = { 'User-Agent': 'Mozilla/5.0 (compatible; TroyStack/1.0)' };
  const quote = (symbol) => axios
    .get(`https://query1.finance.yahoo.com/v8/finance/chart/${symbol}`, { headers, timeout: 8000 })
    .then((res) => res?.data?.chart?.result?.[0]?.meta?.regularMarketPrice || null)
    .catch(() => null);
  const round2 = (n) => Math.round(n * 100) / 100;

  const [goldPrice, silverPrice, platinumPrice, palladiumPrice] = await Promise.all([
    quote('GC=F'), quote('SI=F'), quote('PL=F'), quote('PA=F'),
  ]);

  if (!goldPrice || !silverPrice) throw new Error('Yahoo Finance returned no gold/silver prices');

  let platinum = platinumPrice ? round2(platinumPrice) : null;
  let palladium = palladiumPrice ? round2(palladiumPrice) : null;

  if (!platinum || !palladium) {
    try {
      const ptpdResult = await fetchPtPdFromMetalPriceAPI();
      platinum = platinum || ptpdResult.platinum;
      palladium = palladium || ptpdResult.palladium;
    } catch { /* fall back to the last live value */ }
  }

  // Remember live values, so a later miss falls back to today's price
  // rather than whatever price_log held when the server started. A fetch
  // that's been replaced by a newer one leaves them alone.
  if (isCurrent()) {
    if (platinum) lastKnownPtPd.platinum = platinum;
    if (palladium) lastKnownPtPd.palladium = palladium;
  }

  return {
    gold: round2(goldPrice),
    silver: round2(silverPrice),
    platinum: platinum || lastKnownPtPd.platinum,
    palladium: palladium || lastKnownPtPd.palladium,
    source: 'yahoo_finance',
  };
}

/**
 * Fetch Pt/Pd from MetalPriceAPI (used as supplement to Yahoo Finance).
 */
async function fetchPtPdFromMetalPriceAPI() {
  const apiKey = process.env.METAL_PRICE_API_KEY;
  if (!apiKey) throw new Error('No METAL_PRICE_API_KEY');

  const { data } = await axios.get(
    `https://api.metalpriceapi.com/v1/latest?api_key=${apiKey}&base=USD&currencies=XPT,XPD`,
    { timeout: 8000 }
  );

  return {
    platinum: data.rates?.XPT ? Math.round((1 / data.rates.XPT) * 100) / 100 : null,
    palladium: data.rates?.XPD ? Math.round((1 / data.rates.XPD) * 100) / 100 : null,
  };
}

/**
 * Priority 2: MetalPriceAPI (all 4 metals — fallback when Yahoo is down)
 */
async function fetchFromMetalPriceAPI() {
  const apiKey = process.env.METAL_PRICE_API_KEY;
  if (!apiKey) throw new Error('No METAL_PRICE_API_KEY configured');

  console.log('   Attempting MetalPriceAPI (fallback)...');
  const response = await axios.get(
    `https://api.metalpriceapi.com/v1/latest?api_key=${apiKey}&base=USD&currencies=XAU,XAG,XPT,XPD`,
    { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TroyStack/1.0)', Accept: 'application/json' }, timeout: 10000 }
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
    platinum: platinum || lastKnownPtPd.platinum,
    palladium: palladium || lastKnownPtPd.palladium,
    source: 'metalpriceapi',
  };
}

// ============================================
// MAIN FETCH FUNCTION
// ============================================

/**
 * Fetch live spot prices with priority fallback chain.
 * Updates the in-memory cache, logs to price_log, handles Friday close.
 * Callers use fetchLiveSpotPrices below, which shares a fetch in progress.
 * `generation` is the number fetchLiveSpotPrices gave this fetch. A fetch
 * that's been replaced still runs to the end, so it checks before it writes
 * and writes nothing once a newer fetch has started.
 */
async function fetchLiveSpotPricesNow(generation) {
  const isCurrent = () => generation === liveFetchGeneration;
  try {
    console.log('\n💰 [Price Fetcher] Fetching live spot prices...');

    let fetched = null;

    // Priority 1: Yahoo Finance (free, unlimited)
    try {
      fetched = await fetchFromYahooFinance(isCurrent);
      console.log(`   Yahoo Finance: Gold $${fetched.gold}, Silver $${fetched.silver}, Pt $${fetched.platinum}, Pd $${fetched.palladium}`);
    } catch (err) {
      console.log(`   Yahoo Finance failed: ${err.message}`);
    }

    // Priority 2: MetalPriceAPI (fallback)
    if (!fetched) {
      try {
        fetched = await fetchFromMetalPriceAPI();
        console.log(`   MetalPriceAPI: Gold $${fetched.gold}, Silver $${fetched.silver}, Pt $${fetched.platinum}, Pd $${fetched.palladium}`);
      } catch (err) {
        console.log(`   MetalPriceAPI failed: ${err.message}`);
      }
    }

    // Priority 3: Use last cached prices. Built-in prices stay labeled as
    // built-in, so they're never taken for a real reading after a second failure.
    if (!fetched && spotPriceCache.lastUpdated) {
      console.log('   Using last cached prices (all APIs failed)');
      fetched = {
        ...spotPriceCache.prices,
        source: spotPriceCache.source === 'static-fallback' ? 'static-fallback' : 'cached-fallback',
      };
    }

    // Priority 4: Static fallback
    if (!fetched) {
      console.log('   All APIs failed, no cache — using static fallback');
      fetched = {
        gold: 5150, silver: 87, platinum: 2170, palladium: 1780,
        source: 'static-fallback',
      };
    }

    // Always self-calculate change from last trading day's price_log entry
    const yesterday = await getYesterdayPrices(isCurrent);

    // A newer fetch started while this one waited, and its prices are newer.
    // This one leaves the cache, the Friday close and price_log to it.
    if (!isCurrent()) {
      console.log('   Replaced by a newer fetch, so these prices are dropped');
      return spotPriceCache;
    }

    const changeData = calculateChanges(fetched, yesterday);

    // Save for tomorrow's change calc
    savePreviousDayPrices(fetched.gold, fetched.silver, fetched.platinum, fetched.palladium);

    const marketsClosed = areMarketsClosed();

    // Snapshot previous prices for spike guard (before cache update)
    const prevPrices = { ...spotPriceCache.prices };

    // Update cache. A fallback to the cached prices keeps the time they were
    // read live, and built-in prices were never read live at all.
    const now = new Date();
    let quotedAt = now.toISOString();
    if (fetched.source === 'cached-fallback') quotedAt = spotPriceCache.quotedAt;
    else if (fetched.source === 'static-fallback') quotedAt = null;
    spotPriceCache = {
      prices: { gold: fetched.gold, silver: fetched.silver, platinum: fetched.platinum, palladium: fetched.palladium },
      lastUpdated: now,
      quotedAt,
      source: fetched.source,
      change: changeData,
      marketsClosed,
    };

    console.log(`   Prices updated: Gold $${fetched.gold}, Silver $${fetched.silver} [${fetched.source}]${marketsClosed ? ' [MARKETS CLOSED]' : ''}`);

    // Save as Friday close if it's Friday afternoon (after 4pm ET)
    const fridayParts = {};
    for (const p of marketFmt.formatToParts(new Date())) fridayParts[p.type] = p.value;
    const fridayDayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    if (fridayDayMap[fridayParts.weekday] === 5 && parseInt(fridayParts.hour) >= 16) {
      console.log('   Friday afternoon — saving as Friday close');
      saveFridayClose({
        prices: spotPriceCache.prices,
        timestamp: spotPriceCache.lastUpdated.toISOString(),
        quotedAt: spotPriceCache.quotedAt,
        source: spotPriceCache.source,
        change: spotPriceCache.change,
      }, isCurrent);
    }

    // Log to price_log (non-blocking) — skip fallback data to avoid polluting the log
    if (fetched.source === 'static-fallback' || fetched.source === 'cached-fallback') {
      console.log(`   Skipping price_log — source is ${fetched.source}`);
    } else {
      // Spike guard: reject if gold or silver jumped >10% from previous cache
      const goldPctChange = prevPrices.gold > 0 ? Math.abs((fetched.gold - prevPrices.gold) / prevPrices.gold) : 0;
      const silverPctChange = prevPrices.silver > 0 ? Math.abs((fetched.silver - prevPrices.silver) / prevPrices.silver) : 0;

      if (goldPctChange > 0.10 || silverPctChange > 0.10) {
        console.log(`   ⚠️ Spike guard: Gold ${(goldPctChange * 100).toFixed(1)}%, Silver ${(silverPctChange * 100).toFixed(1)}% — skipping price_log`);
      } else {
        logPriceToSupabase(spotPriceCache.prices, fetched.source).catch(err => {
          console.log('   Price log skipped:', err.message);
        });
      }
    }

    return spotPriceCache;

  } catch (error) {
    console.error('   Failed to fetch spot prices:', error.message);

    if (spotPriceCache.lastUpdated || !isCurrent()) {
      console.log('   Using last cached prices (fetch error)');
      return spotPriceCache;
    }

    spotPriceCache.prices = { gold: 5150, silver: 87, platinum: 2170, palladium: 1780 };
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

// One live fetch at a time. Anyone who asks while one runs, the minute cron,
// startup, or a burst of questions right after a deploy, shares it instead of
// running the whole Yahoo and MetalPriceAPI chain again. A fetch still running
// 30 seconds after it started is taken as hung. Everyone waiting on it gets
// the cached prices then, however late they joined, and the next caller starts
// a fresh one. The hung one can still finish later, so each fetch gets a
// number and only the newest one writes. A late finish can't put back older
// prices.
const LIVE_FETCH_STALL_MS = 30 * 1000;
let liveFetch = null;
let liveFetchStartedAt = 0;
let liveFetchGeneration = 0;
function fetchLiveSpotPrices() {
  if (liveFetch && Date.now() - liveFetchStartedAt >= LIVE_FETCH_STALL_MS) {
    console.log('   [Price Fetcher] Live fetch still running after 30s, starting another');
    liveFetch = null;
  }
  if (!liveFetch) {
    liveFetchStartedAt = Date.now();
    liveFetchGeneration += 1;
    const fetching = fetchLiveSpotPricesNow(liveFetchGeneration);
    // The deadline runs from the fetch's start, not from when a caller joined.
    // The timer's cleared if the fetch settles first, and unref keeps it from
    // holding the process open.
    let timer;
    const deadline = new Promise((resolve) => {
      timer = setTimeout(() => {
        console.log('   [Price Fetcher] Live fetch still running after 30s, its callers get the cached prices');
        resolve(spotPriceCache);
      }, LIVE_FETCH_STALL_MS);
      timer.unref?.();
    });
    const current = Promise.race([fetching, deadline]).finally(() => {
      clearTimeout(timer);
      if (liveFetch === current) liveFetch = null;
    });
    liveFetch = current;
  }
  return liveFetch;
}

/**
 * Get prices — returns cached if fresh (<10min), otherwise fetches.
 * This is the main function called by the /v1/prices route.
 */
async function getSpotPrices() {
  const marketsClosed = areMarketsClosed();

  // If markets closed, return Friday close data if available
  if (marketsClosed) {
    let friday = getFridayClose();

    // If no Friday close but we have cached data, save it as Friday close.
    // Not before the startup read of the stored close is back, though. The
    // cache was read later, so it would win over the stored close, and its
    // change, measured against Friday's own last price, reads as a flat day.
    if (!friday && spotPriceCache.lastUpdated && storedCloseLoaded) {
      saveFridayClose({
        prices: spotPriceCache.prices,
        timestamp: spotPriceCache.lastUpdated.toISOString(),
        quotedAt: spotPriceCache.quotedAt,
        source: spotPriceCache.source,
        change: spotPriceCache.change,
      });
      friday = getFridayClose();
    }

    if (friday) {
      return {
        prices: friday.prices,
        timestamp: friday.timestamp,
        quotedAt: fridayQuotedAt(friday),
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
      quotedAt: spotPriceCache.quotedAt,
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
    quotedAt: spotPriceCache.quotedAt,
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
 * One reading of the prices: the prices, the change measured against them and
 * where they came from, so a prompt built from it agrees with itself. While
 * markets are closed it's the Friday close, the same reading getSpotPrices
 * gives the app. A weekend fetch measures its change against Friday's own
 * last price, so the live cache would read the last session as flat.
 * timestamp is when the reading was last rebuilt, and quotedAt is when its
 * prices were last read from a live source, which a failed fetch doesn't move.
 */
function getPriceSnapshot() {
  const friday = areMarketsClosed() ? getFridayClose() : null;
  if (friday && friday.prices) {
    return {
      prices: { ...friday.prices },
      change: friday.change || { gold: {}, silver: {}, platinum: {}, palladium: {}, source: 'unavailable' },
      source: `${friday.source} (friday-close)`,
      marketsClosed: true,
      timestamp: friday.timestamp || null,
      quotedAt: fridayQuotedAt(friday),
    };
  }
  return {
    prices: { ...spotPriceCache.prices },
    change: spotPriceCache.change,
    source: spotPriceCache.source,
    marketsClosed: areMarketsClosed(),
    timestamp: spotPriceCache.lastUpdated ? spotPriceCache.lastUpdated.toISOString() : null,
    quotedAt: spotPriceCache.quotedAt,
  };
}

/**
 * Initialize the price fetcher: load Friday close, fetch initial prices.
 */
async function initPriceFetcher() {
  await loadFridayClose();
  await getLastKnownPtPd();
  await fetchLiveSpotPrices();
  console.log('💰 [Price Fetcher] Initialized');
}

module.exports = {
  getSpotPrices,
  getPriceSnapshot,
  getCachedPrices,
  fetchLiveSpotPrices,
  initPriceFetcher,
  areMarketsClosed,
  logPriceToSupabase,
  fetchFromYahooFinance,
};
