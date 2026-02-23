const express = require('express');
const path = require('path');
const fs = require('fs');
const router = express.Router();
const supabase = require('../lib/supabase');
const { getSpotPrices, getCachedPrices } = require('../services/price-fetcher');

// ============================================
// HISTORICAL DATA — loaded at require() time
// ============================================

const historicalData = {
  gold: {},
  silver: {},
  loaded: false,
};

function loadHistoricalData() {
  try {
    const dataPath = path.join(__dirname, '..', '..', 'data', 'historical-prices.json');

    if (!fs.existsSync(dataPath)) {
      console.error('historical-prices.json NOT FOUND at:', dataPath);
      loadFallbackHistoricalData();
      return;
    }

    const rawData = fs.readFileSync(dataPath, 'utf8');
    const monthlyPrices = JSON.parse(rawData);

    // Expand monthly data to daily (every day in the month gets the same price)
    Object.entries(monthlyPrices).forEach(([month, prices]) => {
      const [year, monthNum] = month.split('-');
      const daysInMonth = new Date(parseInt(year), parseInt(monthNum), 0).getDate();

      for (let day = 1; day <= daysInMonth; day++) {
        const date = `${year}-${monthNum}-${day.toString().padStart(2, '0')}`;
        historicalData.gold[date] = prices.gold;
        historicalData.silver[date] = prices.silver;
      }
    });

    historicalData.loaded = true;
    console.log(`Historical prices loaded: ${Object.keys(monthlyPrices).length} months, ${Object.keys(historicalData.gold).length} daily entries`);
  } catch (error) {
    console.error('Failed to load historical data:', error.message);
    loadFallbackHistoricalData();
  }
}

// Hardcoded fallback (2022-2024 monthly averages) if JSON file is missing
function loadFallbackHistoricalData() {
  console.log('Loading fallback historical data...');

  const fallbackGold = {
    '2024-12': 2650, '2024-11': 2700, '2024-10': 2750, '2024-09': 2650,
    '2024-08': 2500, '2024-07': 2400, '2024-06': 2350, '2024-05': 2350,
    '2024-04': 2350, '2024-03': 2200, '2024-02': 2050, '2024-01': 2050,
    '2023-12': 2050, '2023-11': 2000, '2023-10': 1980, '2023-09': 1920,
    '2023-08': 1940, '2023-07': 1960, '2023-06': 1920, '2023-05': 1980,
    '2023-04': 2000, '2023-03': 1980, '2023-02': 1850, '2023-01': 1920,
    '2022-12': 1800, '2022-11': 1750, '2022-10': 1650, '2022-09': 1680,
    '2022-08': 1750, '2022-07': 1730, '2022-06': 1830, '2022-05': 1850,
    '2022-04': 1920, '2022-03': 1950, '2022-02': 1900, '2022-01': 1820,
  };

  const fallbackSilver = {
    '2024-12': 31, '2024-11': 32, '2024-10': 33, '2024-09': 31,
    '2024-08': 28, '2024-07': 29, '2024-06': 29, '2024-05': 27,
    '2024-04': 27, '2024-03': 25, '2024-02': 23, '2024-01': 23,
    '2023-12': 24, '2023-11': 24, '2023-10': 23, '2023-09': 23,
    '2023-08': 24, '2023-07': 25, '2023-06': 23, '2023-05': 24,
    '2023-04': 25, '2023-03': 23, '2023-02': 22, '2023-01': 24,
    '2022-12': 24, '2022-11': 21, '2022-10': 19, '2022-09': 19,
    '2022-08': 20, '2022-07': 19, '2022-06': 21, '2022-05': 22,
    '2022-04': 24, '2022-03': 25, '2022-02': 24, '2022-01': 24,
  };

  Object.entries(fallbackGold).forEach(([month, price]) => {
    const [year, monthNum] = month.split('-');
    const daysInMonth = new Date(parseInt(year), parseInt(monthNum), 0).getDate();
    for (let day = 1; day <= daysInMonth; day++) {
      const date = `${month}-${day.toString().padStart(2, '0')}`;
      historicalData.gold[date] = price;
    }
  });

  Object.entries(fallbackSilver).forEach(([month, price]) => {
    const [year, monthNum] = month.split('-');
    const daysInMonth = new Date(parseInt(year), parseInt(monthNum), 0).getDate();
    for (let day = 1; day <= daysInMonth; day++) {
      const date = `${month}-${day.toString().padStart(2, '0')}`;
      historicalData.silver[date] = price;
    }
  });

  historicalData.loaded = true;
  console.log('Fallback historical data loaded');
}

// Load immediately on require
loadHistoricalData();

// ============================================
// GET /v1/prices — Live spot prices
// ============================================

router.get('/', async (req, res) => {
  try {
    const data = await getSpotPrices();
    const { prices, change, timestamp, source, cacheAgeMinutes, marketsClosed } = data;

    res.json({
      success: true,
      timestamp,
      prices: {
        gold: { symbol: 'Au', price: prices.gold, change_pct: change.gold?.percent || 0, unit: 'USD/oz' },
        silver: { symbol: 'Ag', price: prices.silver, change_pct: change.silver?.percent || 0, unit: 'USD/oz' },
        platinum: { symbol: 'Pt', price: prices.platinum, change_pct: change.platinum?.percent || 0, unit: 'USD/oz' },
        palladium: { symbol: 'Pd', price: prices.palladium, change_pct: change.palladium?.percent || 0, unit: 'USD/oz' },
      },
      source,
      cacheAgeMinutes,
      marketsClosed,
      change,
    });
  } catch (err) {
    console.error('Prices error:', err);
    res.status(500).json({ error: 'Failed to fetch prices' });
  }
});

// ============================================
// GET /v1/prices/history — Historical + recent
// ============================================

router.get('/history', async (req, res) => {
  try {
    const { metal = 'gold', range = '1Y', maxPoints = '60' } = req.query;
    const maxPts = Math.min(parseInt(maxPoints) || 60, 1000);

    const validMetals = ['gold', 'silver', 'platinum', 'palladium'];
    const validRanges = ['1M', '3M', '6M', '1Y', '5Y', 'ALL'];
    const rangeUpper = range.toUpperCase();

    if (!validMetals.includes(metal)) {
      return res.status(400).json({ error: `Invalid metal. Use: ${validMetals.join(', ')}` });
    }

    if (!validRanges.includes(rangeUpper)) {
      return res.status(400).json({ error: `Invalid range. Use: ${validRanges.join(', ')}` });
    }

    const now = new Date();
    let startDate;

    switch (rangeUpper) {
      case '1M':
        startDate = new Date(now.getFullYear(), now.getMonth() - 1, now.getDate());
        break;
      case '3M':
        startDate = new Date(now.getFullYear(), now.getMonth() - 3, now.getDate());
        break;
      case '6M':
        startDate = new Date(now.getFullYear(), now.getMonth() - 6, now.getDate());
        break;
      case '1Y':
        startDate = new Date(now.getFullYear() - 1, now.getMonth(), now.getDate());
        break;
      case '5Y':
        startDate = new Date(now.getFullYear() - 5, now.getMonth(), now.getDate());
        break;
      case 'ALL':
        startDate = new Date(1915, 0, 1);
        break;
      default:
        startDate = new Date(now.getFullYear() - 1, now.getMonth(), now.getDate());
    }

    const startStr = startDate.toISOString().split('T')[0];
    const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

    let allPoints = [];

    if (!historicalData.loaded) {
      return res.status(503).json({ success: false, error: 'Historical data not loaded yet' });
    }

    // For short ranges (1M, 3M, 6M), use daily keys; for long ranges, use first-of-month
    if (['1M', '3M', '6M'].includes(rangeUpper)) {
      // Daily resolution from historicalData
      const dates = Object.keys(historicalData.gold)
        .filter(d => d >= startStr && d <= todayStr)
        .sort();

      for (const date of dates) {
        const g = historicalData.gold[date];
        const s = historicalData.silver[date];
        if (g && s) {
          allPoints.push({ date, gold: g, silver: s });
        }
      }
    } else {
      // Monthly resolution: use first-of-month keys (1Y, 5Y, ALL)
      const monthKeys = Object.keys(historicalData.gold)
        .filter(d => d.endsWith('-01') && d >= startStr && d <= todayStr)
        .sort();

      for (const date of monthKeys) {
        const g = historicalData.gold[date];
        const s = historicalData.silver[date];
        if (g && s) {
          allPoints.push({ date, gold: g, silver: s });
        }
      }
    }

    // Overlay price_log for recent accuracy + platinum/palladium data
    try {
      const { data: logData, error: logError } = await supabase
        .from('price_log')
        .select('timestamp, gold_price, silver_price, platinum_price, palladium_price')
        .gte('timestamp', startStr + 'T00:00:00')
        .order('timestamp', { ascending: true });

      if (!logError && logData && logData.length > 0) {
        // Group by date, take first valid entry per day — skip rows with 0/null prices
        const dailyPrices = {};
        for (const row of logData) {
          const d = row.timestamp.split('T')[0];
          const gold = parseFloat(row.gold_price) || 0;
          const silver = parseFloat(row.silver_price) || 0;

          // Skip rows where gold or silver is 0/null (bad data)
          if (gold <= 0 && silver <= 0) continue;

          if (!dailyPrices[d]) {
            dailyPrices[d] = {
              gold: gold,
              silver: silver,
              platinum: row.platinum_price ? parseFloat(row.platinum_price) : 0,
              palladium: row.palladium_price ? parseFloat(row.palladium_price) : 0,
            };
          }
        }

        // Override matching points with more accurate price_log data
        for (const pt of allPoints) {
          if (dailyPrices[pt.date]) {
            if (dailyPrices[pt.date].gold > 0) pt.gold = dailyPrices[pt.date].gold;
            if (dailyPrices[pt.date].silver > 0) pt.silver = dailyPrices[pt.date].silver;
            pt.platinum = dailyPrices[pt.date].platinum || pt.platinum || 0;
            pt.palladium = dailyPrices[pt.date].palladium || pt.palladium || 0;
          }
        }

        // Add any price_log dates not already in allPoints
        const existingDates = new Set(allPoints.map(p => p.date));
        for (const [d, prices] of Object.entries(dailyPrices)) {
          if (d >= startStr && d <= todayStr && !existingDates.has(d)) {
            allPoints.push({ date: d, gold: prices.gold, silver: prices.silver, platinum: prices.platinum, palladium: prices.palladium });
          }
        }
      }
    } catch (err) {
      console.log('price_log overlay failed:', err.message);
    }

    // Append current spot as final point
    const cached = getCachedPrices();
    if (cached.gold > 0 && cached.silver > 0) {
      allPoints.push({
        date: todayStr,
        gold: cached.gold,
        silver: cached.silver,
        platinum: cached.platinum || 0,
        palladium: cached.palladium || 0,
      });
    }

    // Deduplicate by date (keep last entry per date — price_log overrides historical)
    const byDate = {};
    for (const pt of allPoints) {
      byDate[pt.date] = pt;
    }
    allPoints = Object.values(byDate).sort((a, b) => a.date.localeCompare(b.date));

    // Forward-fill then backward-fill platinum/palladium gaps
    // (historical JSON only has gold/silver; price_log covers pt/pd for recent data)
    let lastPt = 0, lastPd = 0;
    for (const pt of allPoints) {
      if (pt.platinum > 0) lastPt = pt.platinum;
      else pt.platinum = lastPt;
      if (pt.palladium > 0) lastPd = pt.palladium;
      else pt.palladium = lastPd;
    }
    lastPt = 0; lastPd = 0;
    for (let i = allPoints.length - 1; i >= 0; i--) {
      if (allPoints[i].platinum > 0) lastPt = allPoints[i].platinum;
      else allPoints[i].platinum = lastPt;
      if (allPoints[i].palladium > 0) lastPd = allPoints[i].palladium;
      else allPoints[i].palladium = lastPd;
    }

    // Sample down to maxPoints using evenly-spaced selection
    let sampled = allPoints;
    if (allPoints.length > maxPts) {
      sampled = [];
      const step = (allPoints.length - 1) / (maxPts - 1);
      for (let i = 0; i < maxPts - 1; i++) {
        sampled.push(allPoints[Math.round(i * step)]);
      }
      sampled.push(allPoints[allPoints.length - 1]);
    }

    res.json({
      success: true,
      metal,
      range: rangeUpper,
      unit: 'USD/oz',
      totalPoints: allPoints.length,
      sampledPoints: sampled.length,
      data_points: sampled.length,
      prices: sampled.map(pt => ({ date: pt.date, price: pt[metal] || 0 })),
      data: sampled,
    });
  } catch (err) {
    console.error('Price history error:', err);
    res.status(500).json({ error: 'Failed to fetch price history' });
  }
});

// ============================================
// GET /v1/historical-spot — Single date spot price lookup
// Used by Add/Edit Purchase to get "Spot at Purchase"
// Tiers: price_log → historicalData (monthly) → unavailable
// ============================================

router.get('/historical-spot', async (req, res) => {
  try {
    const { date, time, metal } = req.query;

    if (!date) {
      return res.status(400).json({ success: false, error: 'Date is required (YYYY-MM-DD)' });
    }

    const normalizedDate = date.trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(normalizedDate)) {
      return res.status(400).json({ success: false, error: 'Date must be in YYYY-MM-DD format' });
    }

    if (time && !/^\d{2}:\d{2}$/.test(time)) {
      return res.status(400).json({ success: false, error: 'Time must be in HH:MM format' });
    }

    const requestedDate = new Date(normalizedDate + 'T00:00:00');
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Future dates → return current spot
    if (requestedDate > today) {
      const cached = getCachedPrices();
      return res.json({
        success: true,
        date: normalizedDate,
        time: time || null,
        gold: cached.gold,
        silver: cached.silver,
        platinum: cached.platinum || null,
        palladium: cached.palladium || null,
        granularity: 'current',
        source: 'current-spot',
        note: 'Future date requested, using current spot price',
      });
    }

    const year = requestedDate.getFullYear();
    let goldPrice, silverPrice, platinumPrice, palladiumPrice, granularity, source;
    let note = null;

    // ── TIER 1: Pre-April 2006 — monthly MacroTrends data only ──
    if (year < 2006 || (year === 2006 && requestedDate.getMonth() < 3)) {
      const gp = historicalData.gold[normalizedDate];
      const sp = historicalData.silver[normalizedDate];

      if (gp && sp) {
        goldPrice = gp;
        silverPrice = sp;
        granularity = 'monthly';
        source = 'macrotrends';
        note = 'Pre-2006 data uses monthly averages. Adjust manually if you know the exact price.';
      } else {
        return res.json({
          success: true, date: normalizedDate, gold: null, silver: null,
          price: null, granularity: 'none', source: 'unavailable',
          note: 'Historical price not available for this date',
        });
      }
    }
    // ── TIER 2+: April 2006 to present ──
    else {
      // Check price_log for exact or closest match
      const dayStart = `${normalizedDate}T00:00:00.000Z`;
      const dayEnd = `${normalizedDate}T23:59:59.999Z`;

      if (time) {
        // Time-specific: ±5 minute window
        const ts = new Date(`${normalizedDate}T${time}:00Z`);
        const windowStart = new Date(ts.getTime() - 5 * 60 * 1000).toISOString();
        const windowEnd = new Date(ts.getTime() + 5 * 60 * 1000).toISOString();

        const { data } = await supabase
          .from('price_log')
          .select('gold_price, silver_price, platinum_price, palladium_price')
          .gte('timestamp', windowStart)
          .lte('timestamp', windowEnd)
          .order('timestamp')
          .limit(1)
          .single();

        if (data && data.gold_price > 0) {
          goldPrice = parseFloat(data.gold_price);
          silverPrice = parseFloat(data.silver_price);
          platinumPrice = data.platinum_price ? parseFloat(data.platinum_price) : null;
          palladiumPrice = data.palladium_price ? parseFloat(data.palladium_price) : null;
          granularity = 'minute';
          source = 'price_log';
        }
      }

      if (!goldPrice) {
        // Day-level: find closest row on that date
        const { data: rows } = await supabase
          .from('price_log')
          .select('gold_price, silver_price, platinum_price, palladium_price')
          .gte('timestamp', dayStart)
          .lte('timestamp', dayEnd)
          .gt('gold_price', 0)
          .order('timestamp')
          .limit(1);

        if (rows && rows.length > 0) {
          const row = rows[0];
          goldPrice = parseFloat(row.gold_price);
          silverPrice = parseFloat(row.silver_price);
          platinumPrice = row.platinum_price ? parseFloat(row.platinum_price) : null;
          palladiumPrice = row.palladium_price ? parseFloat(row.palladium_price) : null;
          granularity = 'logged_daily';
          source = 'price_log';
        }
      }

      // Fallback to monthly MacroTrends data
      if (!goldPrice) {
        const gp = historicalData.gold[normalizedDate];
        const sp = historicalData.silver[normalizedDate];

        if (gp && sp) {
          goldPrice = gp;
          silverPrice = sp;
          granularity = 'monthly_fallback';
          source = 'macrotrends';
          note = 'Using monthly average. Adjust manually if you know the exact price.';
        }
      }

      // No data found
      if (!goldPrice) {
        return res.json({
          success: true, date: normalizedDate, gold: null, silver: null,
          price: null, granularity: 'none', source: 'unavailable',
          note: 'Historical price not available for this date',
        });
      }
    }

    // Round
    goldPrice = Math.round(goldPrice * 100) / 100;
    silverPrice = Math.round(silverPrice * 100) / 100;
    if (platinumPrice) platinumPrice = Math.round(platinumPrice * 100) / 100;
    if (palladiumPrice) palladiumPrice = Math.round(palladiumPrice * 100) / 100;

    const response = {
      success: true,
      date: normalizedDate,
      time: time || null,
      gold: goldPrice,
      silver: silverPrice,
      platinum: platinumPrice || null,
      palladium: palladiumPrice || null,
      granularity,
      source,
    };

    if (note) response.note = note;

    // If specific metal requested, include .price for backwards compat
    if (['gold', 'silver', 'platinum', 'palladium'].includes(metal)) {
      response.metal = metal;
      response.price = response[metal];
    }

    res.json(response);
  } catch (err) {
    console.error('Historical spot error:', err);
    res.status(500).json({ success: false, error: 'Failed to lookup historical price' });
  }
});

module.exports = router;
