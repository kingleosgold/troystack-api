const axios = require('axios');
const XLSX = require('xlsx');
const supabase = require('../lib/supabase');

const CME_URLS = {
  gold: 'https://www.cmegroup.com/delivery_reports/Gold_Stocks.xls',
  silver: 'https://www.cmegroup.com/delivery_reports/Silver_stocks.xls',
  'platinum-palladium': 'https://www.cmegroup.com/delivery_reports/PA-PL_Stck_Rprt.xls',
};

const USER_AGENT = 'Mozilla/5.0 (compatible; StackTrackerGold/1.0)';

/**
 * Download an XLS file from CME and return parsed rows.
 */
async function fetchAndParseXLS(url) {
  const resp = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 30000,
    headers: { 'User-Agent': USER_AGENT },
  });

  const wb = XLSX.read(resp.data, { type: 'buffer' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json(ws, { header: 1 });
}

/**
 * Extract totals from a section of rows.
 * Looks for TOTAL REGISTERED, TOTAL ELIGIBLE, COMBINED TOTAL.
 * Column index 7 = "TOTAL TODAY".
 */
function extractTotals(rows, startRow = 0) {
  let registered = null;
  let eligible = null;
  let combined = null;

  for (let i = startRow; i < rows.length; i++) {
    const label = String(rows[i][0] || '').trim().toUpperCase();
    const todayValue = rows[i][7];

    if (label === 'TOTAL REGISTERED' && todayValue != null) {
      registered = parseFloat(todayValue) || 0;
    } else if (label === 'TOTAL ELIGIBLE' && todayValue != null) {
      eligible = parseFloat(todayValue) || 0;
    } else if (label === 'COMBINED TOTAL' && todayValue != null) {
      combined = parseFloat(todayValue) || 0;
      // Combined total marks end of a metal section
      break;
    }
  }

  return { registered, eligible, combined };
}

/**
 * Get today's date as YYYY-MM-DD in UTC.
 */
function getTodayUTC() {
  const now = new Date();
  return now.toISOString().split('T')[0];
}

/**
 * Parse gold or silver XLS (single metal per file).
 * Uses today's date — the report represents the current vault state.
 */
function parseSingleMetalXLS(rows, metalName) {
  const totals = extractTotals(rows);
  if (totals.registered === null) return null;

  return {
    metal: metalName,
    date: getTodayUTC(),
    registered_oz: totals.registered,
    eligible_oz: totals.eligible || 0,
    combined_oz: totals.combined || (totals.registered + (totals.eligible || 0)),
  };
}

/**
 * Parse platinum/palladium XLS (two metals in one file).
 * Platinum section starts first, palladium section starts at "PALLADIUM" row.
 */
function parsePlatPalXLS(rows) {
  const date = getTodayUTC();

  const results = [];

  // Find where PLATINUM and PALLADIUM sections start
  let platStart = 0;
  let pallStart = null;

  for (let i = 0; i < rows.length; i++) {
    const label = String(rows[i][0] || '').trim().toUpperCase();
    if (label === 'PLATINUM') platStart = i;
    if (label === 'PALLADIUM') { pallStart = i; break; }
  }

  // Platinum totals
  const platTotals = extractTotals(rows, platStart);
  if (platTotals.registered !== null) {
    results.push({
      metal: 'platinum',
      date,
      registered_oz: platTotals.registered,
      eligible_oz: platTotals.eligible || 0,
      combined_oz: platTotals.combined || (platTotals.registered + (platTotals.eligible || 0)),
    });
  }

  // Palladium totals
  if (pallStart !== null) {
    const pallTotals = extractTotals(rows, pallStart);
    if (pallTotals.registered !== null) {
      results.push({
        metal: 'palladium',
        date,
        registered_oz: pallTotals.registered,
        eligible_oz: pallTotals.eligible || 0,
        combined_oz: pallTotals.combined || (pallTotals.registered + (pallTotals.eligible || 0)),
      });
    }
  }

  return results;
}

/**
 * Fetch previous day's vault data for a metal to compute daily changes.
 */
async function getPreviousDay(metal, date) {
  const { data } = await supabase
    .from('vault_data')
    .select('registered_oz, eligible_oz, combined_oz')
    .eq('metal', metal)
    .eq('source', 'comex')
    .lt('date', date)
    .order('date', { ascending: false })
    .limit(1)
    .single();

  return data;
}

/**
 * Run the full COMEX XLS scrape: download all 3 files, parse, compute changes, upsert.
 */
async function scrapeComexVaultData() {
  const startTime = Date.now();
  const results = { inserted: 0, errors: [], metals: [] };

  console.log('\n🏦 [COMEX Scraper] Starting XLS vault data scrape...');

  // Clean up bad Gemini-generated rows (eligible_oz = 0 with real registered data)
  try {
    const { data: badRows, error: cleanErr } = await supabase
      .from('vault_data')
      .delete()
      .eq('metal', 'silver')
      .eq('source', 'comex')
      .eq('eligible_oz', 0)
      .gt('registered_oz', 0)
      .select('date');

    if (cleanErr) {
      console.log(`   ⚠️ Cleanup query error: ${cleanErr.message}`);
    } else if (badRows && badRows.length > 0) {
      console.log(`   🧹 Cleaned up ${badRows.length} bad silver rows (eligible_oz=0)`);
    }
  } catch (err) {
    console.log(`   ⚠️ Cleanup skipped: ${err.message}`);
  }

  // Collect parsed data from all 3 files
  const allMetalData = [];

  // Gold
  try {
    console.log('🏦 [COMEX Scraper] Fetching Gold stocks...');
    const rows = await fetchAndParseXLS(CME_URLS.gold);
    const parsed = parseSingleMetalXLS(rows, 'gold');
    if (parsed) {
      allMetalData.push(parsed);
      console.log(`   ✅ Gold: registered=${parsed.registered_oz.toLocaleString()}, eligible=${parsed.eligible_oz.toLocaleString()}, date=${parsed.date}`);
    } else {
      results.errors.push('Gold: Failed to parse XLS');
      console.log('   ❌ Gold: Failed to parse');
    }
  } catch (err) {
    results.errors.push(`Gold: ${err.message}`);
    console.error('   ❌ Gold fetch error:', err.message);
  }

  // Silver
  try {
    console.log('🏦 [COMEX Scraper] Fetching Silver stocks...');
    const rows = await fetchAndParseXLS(CME_URLS.silver);
    const parsed = parseSingleMetalXLS(rows, 'silver');
    if (parsed) {
      allMetalData.push(parsed);
      console.log(`   ✅ Silver: registered=${parsed.registered_oz.toLocaleString()}, eligible=${parsed.eligible_oz.toLocaleString()}, date=${parsed.date}`);
    } else {
      results.errors.push('Silver: Failed to parse XLS');
      console.log('   ❌ Silver: Failed to parse');
    }
  } catch (err) {
    results.errors.push(`Silver: ${err.message}`);
    console.error('   ❌ Silver fetch error:', err.message);
  }

  // Platinum + Palladium
  try {
    console.log('🏦 [COMEX Scraper] Fetching Platinum/Palladium stocks...');
    const rows = await fetchAndParseXLS(CME_URLS['platinum-palladium']);
    const parsed = parsePlatPalXLS(rows);
    for (const p of parsed) {
      allMetalData.push(p);
      console.log(`   ✅ ${p.metal}: registered=${p.registered_oz.toLocaleString()}, eligible=${p.eligible_oz.toLocaleString()}, date=${p.date}`);
    }
    if (parsed.length === 0) {
      results.errors.push('Platinum/Palladium: Failed to parse XLS');
      console.log('   ❌ Platinum/Palladium: Failed to parse');
    }
  } catch (err) {
    results.errors.push(`Platinum/Palladium: ${err.message}`);
    console.error('   ❌ Platinum/Palladium fetch error:', err.message);
  }

  // Compute daily changes and upsert
  for (const metalData of allMetalData) {
    try {
      const prev = await getPreviousDay(metalData.metal, metalData.date);

      const registeredChange = prev ? metalData.registered_oz - prev.registered_oz : 0;
      const eligibleChange = prev ? metalData.eligible_oz - prev.eligible_oz : 0;
      const combinedChange = prev ? metalData.combined_oz - prev.combined_oz : 0;

      const row = {
        date: metalData.date,
        source: 'comex',
        metal: metalData.metal,
        registered_oz: metalData.registered_oz,
        eligible_oz: metalData.eligible_oz,
        combined_oz: metalData.combined_oz,
        registered_change_oz: Math.round(registeredChange * 1000) / 1000,
        eligible_change_oz: Math.round(eligibleChange * 1000) / 1000,
        combined_change_oz: Math.round(combinedChange * 1000) / 1000,
        open_interest_oz: 0,
        oversubscribed_ratio: 0,
      };

      // Upsert: delete existing row for this metal+date+source, then insert
      await supabase
        .from('vault_data')
        .delete()
        .eq('date', metalData.date)
        .eq('metal', metalData.metal)
        .eq('source', 'comex');

      const { error } = await supabase
        .from('vault_data')
        .insert(row);

      if (error) throw error;

      results.inserted++;
      results.metals.push(metalData.metal);

      const changePct = prev && prev.registered_oz > 0
        ? ((registeredChange / prev.registered_oz) * 100).toFixed(2)
        : 'N/A';
      console.log(`   💾 ${metalData.metal}: upserted (reg change: ${registeredChange >= 0 ? '+' : ''}${Math.round(registeredChange).toLocaleString()} oz, ${changePct}%)`);

    } catch (err) {
      results.errors.push(`${metalData.metal} upsert: ${err.message}`);
      console.error(`   ❌ ${metalData.metal} upsert error:`, err.message);
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n🏦 [COMEX Scraper] Done: ${results.inserted}/4 metals upserted in ${elapsed}s`);
  if (results.errors.length > 0) {
    console.log(`   Errors: ${results.errors.join('; ')}`);
  }

  return { ...results, elapsed };
}

module.exports = { scrapeComexVaultData };
