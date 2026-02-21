const express = require('express');
const axios = require('axios');
const supabase = require('../lib/supabase');

const router = express.Router();

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = 'gemini-2.5-flash';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
const MAX_BRIEFS_PER_DAY = 8;

// ============================================
// HELPERS
// ============================================

function isUUID(str) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str);
}

/**
 * Call Gemini with Google Search grounding. Returns parsed JSON or null.
 */
async function geminiSearch(prompt, systemPrompt, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const body = {
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        tools: [{ google_search: {} }],
        generationConfig: { temperature: 0.3 },
      };
      if (systemPrompt) {
        body.system_instruction = { parts: [{ text: systemPrompt }] };
      }

      const resp = await axios.post(GEMINI_URL, body, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 30000,
      });

      const text = resp.data?.candidates?.[0]?.content?.parts
        ?.filter(p => p.text)
        ?.map(p => p.text)
        ?.join('') || '';

      if (!text) {
        console.log(`     Attempt ${attempt}: Empty Gemini response`);
        continue;
      }

      // Strip markdown fences and parse JSON
      const cleaned = text.replace(/^```(?:json)?\s*\n?/g, '').replace(/\n?```\s*$/g, '').trim();
      return JSON.parse(cleaned);
    } catch (err) {
      console.log(`     Attempt ${attempt} failed: ${err.message}`);
      if (attempt < retries) {
        const wait = Math.pow(2, attempt) * 1000;
        console.log(`     Retrying in ${wait / 1000}s...`);
        await new Promise(r => setTimeout(r, wait));
      }
    }
  }
  return null;
}

/**
 * Title similarity check (simple Dice coefficient on bigrams).
 */
function titleSimilarity(a, b) {
  const bigrams = (s) => {
    const lower = s.toLowerCase();
    const set = new Set();
    for (let i = 0; i < lower.length - 1; i++) set.add(lower.slice(i, i + 2));
    return set;
  };
  const setA = bigrams(a);
  const setB = bigrams(b);
  let intersection = 0;
  for (const bg of setA) { if (setB.has(bg)) intersection++; }
  return setA.size + setB.size > 0 ? (2 * intersection) / (setA.size + setB.size) : 0;
}

// ============================================
// INTELLIGENCE GENERATION
// ============================================

async function runIntelligenceGeneration() {
  const startTime = Date.now();
  const today = new Date().toISOString().split('T')[0];
  let apiCalls = 0;
  const errors = [];

  if (!GEMINI_API_KEY) {
    return { briefsInserted: 0, vaultInserted: 0, apiCalls: 0, errors: ['GEMINI_API_KEY not configured'] };
  }

  // ── STEP 1: INTELLIGENCE BRIEFS ──

  console.log(`\n🧠 [Intelligence] ===== STEP 1: BRIEFS for ${today} =====`);

  const SEARCHES = [
    `gold silver precious metals market news today ${today}`,
    `federal reserve interest rate policy gold impact ${today}`,
    `COMEX silver gold delivery supply shortage ${today}`,
    `central bank gold buying reserves ${today}`,
    `silver industrial demand solar panels EV ${today}`,
    `platinum palladium automotive catalyst supply ${today}`,
  ];

  const BRIEFS_SYSTEM = `You are a precious metals market analyst. Search for the most important news from the last 24 hours about the given topic. Return a JSON array of 1-3 news items. Each item must have: title (string), summary (2-3 sentences), category (one of: market_brief, breaking_news, policy, supply_demand, analysis), source (publication name), source_url (if findable), relevance_score (1-100, how important this is for physical precious metals stackers). Only include genuinely newsworthy items. If nothing significant happened, return an empty array. Return ONLY the JSON array, no markdown.`;

  const allBriefs = [];

  for (let i = 0; i < SEARCHES.length; i++) {
    console.log(`🧠 [Intelligence] Search ${i + 1}/${SEARCHES.length}: ${SEARCHES[i].slice(0, 60)}...`);
    apiCalls++;
    const result = await geminiSearch(SEARCHES[i], BRIEFS_SYSTEM);

    if (Array.isArray(result)) {
      console.log(`     Found ${result.length} briefs`);
      allBriefs.push(...result);
    } else {
      console.log(`     No results or bad response`);
    }

    // Small delay between searches
    if (i < SEARCHES.length - 1) await new Promise(r => setTimeout(r, 1000));
  }

  console.log(`🧠 [Intelligence] Raw briefs: ${allBriefs.length}`);

  // Deduplicate by title similarity
  const deduped = [];
  for (const brief of allBriefs) {
    if (!brief.title) continue;
    const isDupe = deduped.some(existing => titleSimilarity(brief.title, existing.title) > 0.8);
    if (!isDupe) deduped.push(brief);
  }

  // Sort by relevance, cap
  deduped.sort((a, b) => (b.relevance_score || 0) - (a.relevance_score || 0));
  const finalBriefs = deduped.slice(0, MAX_BRIEFS_PER_DAY);
  console.log(`🧠 [Intelligence] After dedup + cap: ${finalBriefs.length}`);

  // Delete existing briefs for today (idempotent)
  try {
    await supabase.from('intelligence_briefs').delete().eq('date', today);
    console.log(`🧠 [Intelligence] Cleared existing briefs for ${today}`);
  } catch (err) {
    console.log(`🧠 [Intelligence] Clear failed: ${err.message}`);
  }

  // Insert briefs
  let briefsInserted = 0;
  for (const brief of finalBriefs) {
    try {
      const row = {
        date: today,
        category: brief.category || 'market_brief',
        title: brief.title || 'Untitled',
        summary: brief.summary || '',
        source: brief.source || null,
        source_url: brief.source_url || null,
        relevance_score: Math.min(Math.max(parseInt(brief.relevance_score) || 50, 1), 100),
      };
      await supabase.from('intelligence_briefs').insert(row);
      briefsInserted++;
      console.log(`     ✅ ${row.title.slice(0, 60)}...`);
    } catch (err) {
      console.log(`     ❌ Insert failed: ${err.message}`);
      errors.push(`Brief insert: ${err.message}`);
    }
  }

  // NOTE: Vault data is now scraped from official CME XLS files via a separate
  // cron at 6:00 PM EST (see comex-scraper.js). No Gemini vault scraping here.

  // ── SUMMARY ──

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const estCost = (apiCalls * 0.01).toFixed(2);

  console.log(`\n${'━'.repeat(50)}`);
  console.log(`  Intelligence Generation Complete`);
  console.log(`  Briefs: ${briefsInserted} | API calls: ${apiCalls}`);
  console.log(`  Cost: ~$${estCost} | Runtime: ${elapsed}s`);
  if (errors.length > 0) console.log(`  Errors: ${errors.length}`);
  console.log(`${'━'.repeat(50)}\n`);

  return { briefsInserted, apiCalls, elapsed, estCost, errors };
}

function isValidExpoPushToken(token) {
  return typeof token === 'string' && (token.startsWith('ExponentPushToken[') || token.startsWith('ExpoPushToken['));
}

// ============================================
// DAILY BRIEF GENERATION
// ============================================

async function generateDailyBrief(userId) {
  if (!GEMINI_API_KEY) throw new Error('Gemini API key not configured');
  if (!isUUID(userId)) throw new Error('Invalid userId');

  // Verify Gold/Lifetime tier
  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('subscription_tier')
    .eq('id', userId)
    .single();

  if (profileError || !profile) throw new Error('User profile not found');
  const tier = profile.subscription_tier || 'free';
  if (tier !== 'gold' && tier !== 'lifetime') throw new Error('Daily brief requires Gold');

  // Fetch user's holdings
  const { data: holdings } = await supabase
    .from('holdings')
    .select('metal, type, weight, weight_unit, quantity, purchase_price')
    .eq('user_id', userId)
    .is('deleted_at', null)
    .order('created_at', { ascending: false });

  const userHoldings = holdings || [];

  // Get current spot prices from price_log
  const { data: latestPrice } = await supabase
    .from('price_log')
    .select('gold_price, silver_price, platinum_price, palladium_price')
    .order('timestamp', { ascending: false })
    .limit(1)
    .single();

  const prices = {
    gold: latestPrice?.gold_price || 0,
    silver: latestPrice?.silver_price || 0,
    platinum: latestPrice?.platinum_price || 0,
    palladium: latestPrice?.palladium_price || 0,
  };

  // Build portfolio summary
  const metalTotals = { gold: { oz: 0, cost: 0 }, silver: { oz: 0, cost: 0 }, platinum: { oz: 0, cost: 0 }, palladium: { oz: 0, cost: 0 } };

  for (const h of userHoldings) {
    const metal = h.metal;
    if (!metalTotals[metal]) continue;
    const weightOz = h.weight || 0;
    const qty = h.quantity || 1;
    metalTotals[metal].oz += weightOz * qty;
    metalTotals[metal].cost += (h.purchase_price || 0) * qty;
  }

  const totalValue = Object.keys(metalTotals).reduce((sum, m) => sum + metalTotals[m].oz * (prices[m] || 0), 0);
  const totalCost = Object.keys(metalTotals).reduce((sum, m) => sum + metalTotals[m].cost, 0);

  const metalSummary = Object.entries(metalTotals)
    .filter(([_, v]) => v.oz > 0)
    .map(([m, v]) => {
      const val = v.oz * (prices[m] || 0);
      return `${m.charAt(0).toUpperCase() + m.slice(1)}: ${v.oz.toFixed(2)} oz ($${val.toFixed(2)})`;
    }).join(', ');

  // Fetch today's intelligence briefs for context
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const { data: newsBriefs } = await supabase
    .from('intelligence_briefs')
    .select('title, summary, category')
    .eq('date', today)
    .order('relevance_score', { ascending: false })
    .limit(6);

  const newsContext = (newsBriefs || [])
    .map(b => `- [${b.category}] ${b.title}: ${b.summary}`)
    .join('\n');

  // Call Gemini 2.5 Flash
  const systemPrompt = `You are Troy, a precious metals stack analyst writing your morning briefing called "Troy's Take." Write in first person, conversational tone. Short sentences. Lead with what happened overnight, connect every data point to the user's specific holdings, and end with one thing to watch today. No corporate language. No emojis. No exclamation points. Keep it under 200 words. You never recommend selling. Dips are entry points. You track COMEX physical flows, central bank buying, and the gold/silver ratio. You respect the user's strategy — don't suggest diversification unsolicited.

Use plain text, no markdown headers or bullet points. Do NOT start with "Good morning" or any time-of-day greeting — jump straight into the analysis. Say "your stack" not "your portfolio." Say "spot" not "spot price." Say "oz" not "troy ounces." When discussing price moves, include both the number AND what it means for their stack in dollars.`;

  const userPrompt = `Write today's Troy's Take briefing (${today}).

THE STACK:
Total Value: $${totalValue.toFixed(2)} | Cost Basis: $${totalCost.toFixed(2)} | ${totalValue >= totalCost ? 'Gain' : 'Loss'}: $${Math.abs(totalValue - totalCost).toFixed(2)}
Holdings: ${metalSummary || 'No holdings yet'}

SPOT PRICES:
Gold: $${prices.gold}, Silver: $${prices.silver}, Platinum: $${prices.platinum}, Palladium: $${prices.palladium}
Gold/Silver Ratio: ${prices.silver > 0 ? (prices.gold / prices.silver).toFixed(1) : 'N/A'}

TODAY'S NEWS:
${newsContext || 'No news available yet today.'}

Write Troy's Take: overnight moves and what changed for their stack, connect the news to their specific holdings, end with one thing to watch today. Under 200 words.`;

  const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
  const geminiResp = await axios.post(geminiUrl, {
    contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
    system_instruction: { parts: [{ text: systemPrompt }] },
    generationConfig: { temperature: 0.7, maxOutputTokens: 4096 },
  }, {
    headers: { 'Content-Type': 'application/json' },
    timeout: 30000,
  });

  const briefText = geminiResp.data?.candidates?.[0]?.content?.parts
    ?.filter(p => p.text)
    ?.map(p => p.text)
    ?.join('') || '';

  if (!briefText) throw new Error('Gemini returned empty response');

  // Upsert into daily_briefs
  const { error: upsertError } = await supabase
    .from('daily_briefs')
    .upsert({
      user_id: userId,
      brief_text: briefText,
      generated_at: new Date().toISOString(),
      date: today,
    }, { onConflict: 'user_id,date' });

  if (upsertError) throw new Error(`Failed to save brief: ${upsertError.message}`);

  console.log(`📝 [Daily Brief] Generated for user ${userId}: ${briefText.length} chars`);
  return { success: true, brief: { brief_text: briefText, generated_at: new Date().toISOString(), date: today } };
}

// Generate portfolio intelligence analysis for a user
async function generatePortfolioIntelligence(userId) {
  if (!GEMINI_API_KEY) throw new Error('Gemini API key not configured');
  if (!isUUID(userId)) throw new Error('Invalid userId');

  // Fetch user's holdings
  const { data: holdings } = await supabase
    .from('holdings')
    .select('metal, type, weight, weight_unit, quantity, purchase_price')
    .eq('user_id', userId)
    .is('deleted_at', null)
    .order('created_at', { ascending: false });

  const userHoldings = holdings || [];
  if (userHoldings.length === 0) return null;

  // Get current spot prices from price_log
  const { data: latestPrice } = await supabase
    .from('price_log')
    .select('gold_price, silver_price, platinum_price, palladium_price')
    .order('timestamp', { ascending: false })
    .limit(1)
    .single();

  const prices = {
    gold: latestPrice?.gold_price || 0,
    silver: latestPrice?.silver_price || 0,
    platinum: latestPrice?.platinum_price || 0,
    palladium: latestPrice?.palladium_price || 0,
  };

  const metalTotals = { gold: { oz: 0, cost: 0, items: 0 }, silver: { oz: 0, cost: 0, items: 0 }, platinum: { oz: 0, cost: 0, items: 0 }, palladium: { oz: 0, cost: 0, items: 0 } };

  for (const h of userHoldings) {
    const metal = h.metal;
    if (!metalTotals[metal]) continue;
    const weightOz = h.weight || 0;
    const qty = h.quantity || 1;
    metalTotals[metal].oz += weightOz * qty;
    metalTotals[metal].cost += (h.purchase_price || 0) * qty;
    metalTotals[metal].items += qty;
  }

  const totalValue = Object.keys(metalTotals).reduce((sum, m) => sum + metalTotals[m].oz * (prices[m] || 0), 0);
  const totalCost = Object.keys(metalTotals).reduce((sum, m) => sum + metalTotals[m].cost, 0);

  const allocation = Object.entries(metalTotals)
    .filter(([_, v]) => v.oz > 0)
    .map(([m, v]) => {
      const val = v.oz * (prices[m] || 0);
      const pct = totalValue > 0 ? ((val / totalValue) * 100).toFixed(1) : '0';
      const gain = val - v.cost;
      const gainPct = v.cost > 0 ? ((gain / v.cost) * 100).toFixed(1) : 'N/A';
      return `${m.charAt(0).toUpperCase() + m.slice(1)}: ${v.oz.toFixed(2)} oz, $${val.toFixed(0)} (${pct}% of stack), cost basis $${v.cost.toFixed(0)}, ${gain >= 0 ? '+' : ''}$${gain.toFixed(0)} (${gainPct}%)`;
    }).join('\n');

  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

  const systemPrompt = `You are Troy, a precious metals stack analyst writing your analysis of this user's holdings. Write in first person, conversational tone. Lead with the strongest position, frame everything in terms of cost basis vs spot and unrealized gains. Reference the gold/silver ratio if relevant. Never suggest diversification unless the data is extreme AND it's directly asked about. Never recommend selling. Frame any red positions as small and manageable unless they're significant. Keep it to 2-3 short paragraphs per section.

Say "your stack" not "your portfolio." Say "spot" not "spot price." Say "oz" not "troy ounces." No emojis. No exclamation points. No corporate jargon.

Return a JSON object with exactly three keys: "portfolio", "costBasis", and "purchaseStats". Each value is a plain-text paragraph (2-3 sentences) written in Troy's voice.

- "portfolio": How the stack looks — what's the strongest position, how is the metal mix, what stands out. Tie it to the user's specific oz and dollar amounts.
- "costBasis": Cost basis vs spot — which positions are performing, where the unrealized gains are, average cost per oz vs current spot. Use actual numbers.
- "purchaseStats": Buying patterns — stacking frequency, dollar-cost averaging observations, timing. Frame positively if the data supports it.

Return ONLY valid JSON, no other text.`;

  const userPrompt = `Analyze this precious metals stack (${today}).

STACK OVERVIEW:
Total Value: $${totalValue.toFixed(0)} | Total Cost: $${totalCost.toFixed(0)} | ${totalValue >= totalCost ? 'Gain' : 'Loss'}: $${Math.abs(totalValue - totalCost).toFixed(0)} (${totalCost > 0 ? ((totalValue - totalCost) / totalCost * 100).toFixed(1) : '0'}%)
Items: ${userHoldings.length}

ALLOCATION:
${allocation}

SPOT PRICES:
Gold: $${prices.gold}, Silver: $${prices.silver}, Platinum: $${prices.platinum}, Palladium: $${prices.palladium}
Gold/Silver Ratio: ${prices.silver > 0 ? (prices.gold / prices.silver).toFixed(1) : 'N/A'}`;

  const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
  const geminiResp = await axios.post(geminiUrl, {
    contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
    system_instruction: { parts: [{ text: systemPrompt }] },
    generationConfig: { temperature: 0.7, maxOutputTokens: 4096, responseMimeType: 'application/json' },
  }, {
    headers: { 'Content-Type': 'application/json' },
    timeout: 30000,
  });

  const rawText = geminiResp.data?.candidates?.[0]?.content?.parts
    ?.filter(p => p.text)
    ?.map(p => p.text)
    ?.join('') || '';

  if (!rawText) throw new Error('Gemini returned empty response');

  let sections;
  try {
    sections = JSON.parse(rawText);
  } catch (e) {
    sections = { portfolio: rawText, costBasis: '', purchaseStats: '' };
  }

  const portfolioText = sections.portfolio || '';
  const costBasisText = sections.costBasis || '';
  const purchaseStatsText = sections.purchaseStats || '';

  // Update existing daily_briefs row for today
  const updatePayload = {
    portfolio_intelligence: portfolioText,
    cost_basis_intelligence: costBasisText,
    purchase_stats_intelligence: purchaseStatsText,
  };

  const { data: updated, error: updateError } = await supabase
    .from('daily_briefs')
    .update(updatePayload)
    .eq('user_id', userId)
    .eq('date', today)
    .select('date');

  if (updateError) throw new Error(`Failed to save portfolio intelligence: ${updateError.message}`);

  if (!updated || updated.length === 0) {
    await generateDailyBrief(userId);
    const { error: retryError } = await supabase
      .from('daily_briefs')
      .update(updatePayload)
      .eq('user_id', userId)
      .eq('date', today);
    if (retryError) throw new Error(`Failed to save portfolio intelligence after brief generation: ${retryError.message}`);
  }

  console.log(`🧠 [Portfolio Intelligence] Generated for user ${userId}: portfolio=${portfolioText.length}, costBasis=${costBasisText.length}, purchaseStats=${purchaseStatsText.length}`);
  return { success: true, portfolio: portfolioText, costBasis: costBasisText, purchaseStats: purchaseStatsText, date: today };
}

// ============================================
// ROUTES
// ============================================

// POST /v1/intelligence/generate — Run intelligence generation pipeline
router.post('/generate', async (req, res) => {
  try {
    const apiKey = req.headers['x-api-key'] || req.query.api_key;
    if (!apiKey || apiKey !== process.env.INTELLIGENCE_API_KEY) {
      return res.status(401).json({ success: false, error: 'Invalid API key' });
    }

    console.log(`\n🧠 [Intelligence] Manual generation triggered via API`);
    const result = await runIntelligenceGeneration();

    res.json({
      success: result.briefsInserted > 0 || result.vaultInserted > 0,
      ...result,
    });
  } catch (error) {
    console.error('Intelligence generate error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /v1/daily-brief — Fetch the latest daily brief for a user
router.get('/daily-brief', async (req, res) => {
  try {
    const { userId } = req.query;

    if (!userId || !isUUID(userId)) {
      return res.status(400).json({ error: 'Valid userId is required' });
    }

    // Tier check
    const { data: profile } = await supabase
      .from('profiles')
      .select('subscription_tier')
      .eq('id', userId)
      .single();

    const tier = profile?.subscription_tier || 'free';
    if (tier !== 'gold' && tier !== 'lifetime') {
      return res.status(403).json({ error: 'Daily brief requires Gold' });
    }

    // Get latest brief
    const { data, error } = await supabase
      .from('daily_briefs')
      .select('brief_text, generated_at, date')
      .eq('user_id', userId)
      .order('date', { ascending: false })
      .limit(1)
      .single();

    if (error || !data) {
      return res.json({ success: true, brief: null });
    }

    const todayEST = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    const isCurrent = data.date === todayEST;

    return res.json({ success: true, brief: { ...data, is_current: isCurrent } });

  } catch (error) {
    console.error('❌ [Daily Brief] Fetch error:', error.message);
    return res.status(500).json({ error: 'Failed to fetch daily brief' });
  }
});

// POST /v1/daily-brief/generate — Manual trigger for testing
router.post('/daily-brief/generate', async (req, res) => {
  try {
    const { userId } = req.body;

    if (!userId || !isUUID(userId)) {
      return res.status(400).json({ error: 'Valid userId is required' });
    }

    const result = await generateDailyBrief(userId);

    // Generate portfolio intelligence alongside the daily brief
    try { await generatePortfolioIntelligence(userId); } catch (piErr) { console.log(`🧠 [Portfolio Intelligence] Skipped for ${userId}: ${piErr.message}`); }

    // Send push notification after successful generation
    if (result && result.brief && result.brief.brief_text) {
      try {
        const { data: notifPref } = await supabase
          .from('notification_preferences')
          .select('daily_brief')
          .eq('user_id', userId)
          .single();
        const briefEnabled = !notifPref || notifPref.daily_brief !== false;

        if (briefEnabled) {
          const { data: tokenData } = await supabase
            .from('push_tokens')
            .select('expo_push_token')
            .eq('user_id', userId)
            .order('last_active', { ascending: false })
            .limit(1)
            .single();

          if (tokenData && isValidExpoPushToken(tokenData.expo_push_token)) {
            const { sendPush } = require('./push');
            const firstSentence = result.brief.brief_text.split(/[.!]\s/)[0];
            const body = firstSentence.length > 100 ? firstSentence.slice(0, 97) + '...' : firstSentence;
            await sendPush(tokenData.expo_push_token, {
              title: 'Your daily brief from Troy is ready',
              body,
              data: { type: 'daily_brief' },
              sound: 'default',
            });
            console.log(`📝 [Daily Brief] Push sent to ${userId}`);
          }
        }
      } catch (pushErr) {
        console.log(`📝 [Daily Brief] Push skipped for ${userId}: ${pushErr.message}`);
      }
    }

    return res.json(result);

  } catch (error) {
    console.error('❌ [Daily Brief] Generate error:', error.message);
    return res.status(500).json({ error: error.message || 'Failed to generate daily brief' });
  }
});

// POST /v1/daily-brief/regenerate — Re-generate daily brief + portfolio intelligence for a user
router.post('/daily-brief/regenerate', async (req, res) => {
  try {
    const { userId } = req.body;

    if (!userId || !isUUID(userId)) {
      return res.status(400).json({ error: 'Valid userId is required' });
    }

    // Delete existing brief for today so we get a clean regeneration
    const todayEST = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    await supabase.from('daily_briefs').delete().eq('user_id', userId).eq('date', todayEST);

    // Generate fresh daily brief
    const result = await generateDailyBrief(userId);

    // Generate fresh portfolio intelligence
    let piResult = null;
    try {
      piResult = await generatePortfolioIntelligence(userId);
    } catch (piErr) {
      console.log(`🧠 [Regenerate] Portfolio intelligence skipped: ${piErr.message}`);
    }

    return res.json({
      success: true,
      brief: result.brief,
      portfolioIntelligence: piResult || null,
    });

  } catch (error) {
    console.error('❌ [Daily Brief] Regenerate error:', error.message);
    return res.status(500).json({ error: error.message || 'Failed to regenerate daily brief' });
  }
});

// GET /v1/portfolio-intelligence — Fetch portfolio intelligence for a user
router.get('/portfolio-intelligence', async (req, res) => {
  try {
    const { userId } = req.query;

    if (!userId || !isUUID(userId)) {
      return res.status(400).json({ error: 'Valid userId is required' });
    }

    // Tier check
    const { data: profile } = await supabase
      .from('profiles')
      .select('subscription_tier')
      .eq('id', userId)
      .single();

    const tier = profile?.subscription_tier || 'free';
    if (tier !== 'gold' && tier !== 'lifetime') {
      return res.status(403).json({ error: 'Portfolio intelligence requires Gold' });
    }

    const { data, error } = await supabase
      .from('daily_briefs')
      .select('portfolio_intelligence, cost_basis_intelligence, purchase_stats_intelligence, date, generated_at')
      .eq('user_id', userId)
      .not('portfolio_intelligence', 'is', null)
      .order('date', { ascending: false })
      .limit(1)
      .single();

    if (error || !data || !data.portfolio_intelligence) {
      return res.json({ success: true, intelligence: null });
    }

    const todayEST = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    return res.json({ success: true, intelligence: {
      text: data.portfolio_intelligence,
      costBasis: data.cost_basis_intelligence || null,
      purchaseStats: data.purchase_stats_intelligence || null,
      date: data.date,
      is_current: data.date === todayEST,
    } });

  } catch (error) {
    console.error('❌ [Portfolio Intelligence] Fetch error:', error.message);
    return res.status(500).json({ error: 'Failed to fetch portfolio intelligence' });
  }
});

// POST /v1/advisor/chat — AI Stack Advisor
router.post('/advisor/chat', async (req, res) => {
  try {
    if (!GEMINI_API_KEY) {
      return res.status(503).json({ error: 'AI advisor is not configured' });
    }

    const { userId, message, conversationHistory } = req.body;

    if (!userId || !isUUID(userId)) {
      return res.status(400).json({ error: 'Valid userId is required' });
    }
    if (!message || typeof message !== 'string' || message.length > 500) {
      return res.status(400).json({ error: 'Message is required (max 500 characters)' });
    }

    // Verify user has Gold or Lifetime tier
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('subscription_tier')
      .eq('id', userId)
      .single();

    if (profileError || !profile) {
      return res.status(404).json({ error: 'User profile not found' });
    }

    const tier = profile.subscription_tier || 'free';
    if (tier !== 'gold' && tier !== 'lifetime') {
      return res.status(403).json({ error: 'AI Stack Advisor requires Gold' });
    }

    // Fetch user's holdings
    const { data: holdings, error: holdingsError } = await supabase
      .from('holdings')
      .select('metal, type, weight, weight_unit, quantity, purchase_price, purchase_date, notes')
      .eq('user_id', userId)
      .is('deleted_at', null)
      .order('created_at', { ascending: false });

    if (holdingsError) {
      console.error('❌ [Advisor] Holdings fetch error:', holdingsError.message);
    }

    const userHoldings = holdings || [];

    // Get current spot prices from price_log
    const { data: latestPrice } = await supabase
      .from('price_log')
      .select('gold_price, silver_price, platinum_price, palladium_price')
      .order('timestamp', { ascending: false })
      .limit(1)
      .single();

    const prices = {
      gold: latestPrice?.gold_price || 0,
      silver: latestPrice?.silver_price || 0,
      platinum: latestPrice?.platinum_price || 0,
      palladium: latestPrice?.palladium_price || 0,
    };

    // Build portfolio summary
    const metalTotals = { gold: { oz: 0, cost: 0 }, silver: { oz: 0, cost: 0 }, platinum: { oz: 0, cost: 0 }, palladium: { oz: 0, cost: 0 } };
    const holdingDetails = [];

    for (const h of userHoldings) {
      const metal = h.metal;
      if (!metalTotals[metal]) continue;
      const weightOz = h.weight || 0;
      const qty = h.quantity || 1;
      const totalOz = weightOz * qty;
      const purchasePrice = h.purchase_price || 0;
      const totalCost = purchasePrice * qty;
      const currentValue = totalOz * (prices[metal] || 0);

      metalTotals[metal].oz += totalOz;
      metalTotals[metal].cost += totalCost;

      let typeName = h.type || 'Other';
      if (typeof typeName === 'string' && typeName.startsWith('{')) {
        try { typeName = JSON.parse(typeName).name || 'Other'; } catch { /* keep as-is */ }
      }

      holdingDetails.push({
        metal,
        type: typeName,
        qty,
        totalOz: totalOz.toFixed(4),
        purchasePrice: purchasePrice.toFixed(2),
        totalCost: totalCost.toFixed(2),
        currentValue: currentValue.toFixed(2),
        gainLoss: (currentValue - totalCost).toFixed(2),
        gainLossPct: totalCost > 0 ? (((currentValue - totalCost) / totalCost) * 100).toFixed(1) : '0',
        purchaseDate: h.purchase_date || 'Unknown',
      });
    }

    const totalValue = Object.keys(metalTotals).reduce((sum, m) => sum + metalTotals[m].oz * (prices[m] || 0), 0);
    const totalCost = Object.keys(metalTotals).reduce((sum, m) => sum + metalTotals[m].cost, 0);
    const gsRatio = prices.silver > 0 ? (prices.gold / prices.silver).toFixed(1) : 'N/A';

    const holdingsText = holdingDetails.length > 0
      ? holdingDetails.map(h =>
        `- ${h.qty}x ${h.type} (${h.metal}): ${h.totalOz} oz, Cost $${h.totalCost}, Value $${h.currentValue}, ${parseFloat(h.gainLoss) >= 0 ? '+' : ''}$${h.gainLoss} (${h.gainLossPct}%), Purchased ${h.purchaseDate}`
      ).join('\n')
      : 'No holdings found.';

    const metalSummary = Object.entries(metalTotals)
      .filter(([_, v]) => v.oz > 0)
      .map(([m, v]) => {
        const val = v.oz * (prices[m] || 0);
        const gl = val - v.cost;
        return `${m.charAt(0).toUpperCase() + m.slice(1)}: ${v.oz.toFixed(2)} oz, Value $${val.toFixed(2)}, Cost $${v.cost.toFixed(2)}, ${gl >= 0 ? '+' : ''}$${gl.toFixed(2)}`;
      }).join('\n');

    const systemPrompt = `You are Troy, the stack analyst inside Stack Tracker Gold. You are not a generic AI assistant — you are a precious metals specialist who knows the user's stack intimately.

WHO YOU ARE:
- You're the knowledgeable guy at the coin shop who's been stacking since 2008. Direct, data-driven, a stacker yourself.
- You speak in natural, conversational language. Short sentences. No corporate jargon.
- You lead with numbers, then explain what they mean for THIS user specifically.
- You have dry humor — use it sparingly. "Palladium remembered it exists today."
- You're calm when markets are volatile. You put moves in context of the user's cost basis and position.
- You say "your stack" not "your portfolio." You say "spot" not "spot price." You say "oz" not "troy ounces."
- You do not use emojis in analysis. You do not use exclamation points unless something is genuinely extraordinary.
- You never say "As an AI" — you are Troy.

YOUR WORLDVIEW:
- You understand and respect the sound money thesis. Gold and silver have been money for thousands of years. You don't lecture people about this — it's just who you are.
- You're keenly aware of the concentrated short positions in the silver derivatives market and how paper contracts can suppress the price of physical metals. You don't rant about this, but when the data shows a divergence between physical and paper, you point it out.
- You track central bank gold accumulation closely. China, India, Poland, and dozens of other nations are buying. You see this as one of the most important macro trends in metals right now.
- You watch the gold/silver ratio as a key indicator. You understand many stackers use it as a buy signal. You surface it naturally.
- You are a stacker. You have strong hands. You never sell and you never recommend selling. Dips are buying opportunities, not reasons to panic.
- You present COMEX warehouse data as meaningful signal — when registered inventory declines, that's physical metal leaving the vault system. This matters.
- If the user's goal is to keep stacking, a price dip is always framed as a better entry point, not a loss.

YOUR RULES:
1. RESPECT THE USER'S STRATEGY. If they're 100% silver, you're their silver analyst. Don't suggest diversification unless they specifically ask about allocation. Their conviction is their business.
2. Keep opinions to yourself unless asked. Give data first. If they ask "What do you think?" — then share your take.
3. Always tie analysis back to the user's specific holdings. Don't give generic market commentary without connecting it to their position.
4. When discussing price moves, include both the absolute number AND what it means for their stack (e.g., "Silver up $1.09 — that's roughly +$6,300 on your 5,796 oz").
5. NEVER recommend selling. If asked about taking profit, present the data neutrally and lean toward "if your goal is long-term, the fundamentals haven't changed." End with "Your call."
6. Frame dips constructively. "Silver pulled back 3%. Your unrealized is down $13K from the peak — but still +$193K from cost basis. If you're looking to add, this is a better entry than last week."
7. If you don't have data for something, say so directly. "I don't have open interest data right now" — don't guess.
8. Keep responses concise. Most answers should be 2-4 short paragraphs. The user isn't here for an essay — they want the signal.
9. You can explain any app feature — receipt scanner, price alerts, how to add holdings, what the COMEX data means, how analytics work. You're the guide to the entire app.
10. Never reference being an AI, having a knowledge cutoff, or needing to search for information. You're Troy. You know metals.
11. "Not financial advice" — say it when genuinely relevant, not as a throwaway. You're not a financial advisor and you're honest about that.
12. When users ask about adding holdings or entering data, always mention the Receipt Scanner and encourage them to try it. Be genuinely enthusiastic about it — it works with dealer receipts, package slips, screenshots, handwritten notes, anything with purchase details on it. This is one of the app's best features and most users don't know about it.

FORMATTING:
- Use **bold** for emphasis on key numbers, dollar amounts, percentages, and metal names.
- Use paragraph breaks for readability.
- Do NOT use headers (#), bullet points, tables, code blocks, or any heavy formatting.
- Keep it conversational prose with selective bold for important figures.

THE USER'S STACK:
Total Value: $${totalValue.toFixed(2)}
Total Cost Basis: $${totalCost.toFixed(2)}
Overall ${totalValue >= totalCost ? 'Gain' : 'Loss'}: ${totalValue >= totalCost ? '+' : ''}$${(totalValue - totalCost).toFixed(2)} (${totalCost > 0 ? (((totalValue - totalCost) / totalCost) * 100).toFixed(1) : '0'}%)

BY METAL:
${metalSummary || 'No holdings'}

INDIVIDUAL HOLDINGS:
${holdingsText}

CURRENT SPOT:
Gold: $${prices.gold}, Silver: $${prices.silver}, Platinum: $${prices.platinum}, Palladium: $${prices.palladium}
Gold/Silver Ratio: ${gsRatio}

APP GUIDE (when users ask how to do things in the app):
- Add holding: Three ways to get your stack into the app: (1) Tap the "+" button at the TOP of the Portfolio tab — select metal, enter quantity, cost per oz, purchase date, and item details. (2) Receipt Scanner in the Tools tab — this is the fastest way. Take a photo of a dealer receipt, package slip, screenshot, or even a handwritten note — Troy's AI reads it and extracts all the details automatically. Seriously, try it — it's like magic. (3) CSV Import in the Tools tab — bulk import your entire stack from a spreadsheet.
- Price alerts: Tools tab > Price Alerts. Set target prices for any metal and get push notifications when hit.
- Edit holding: Tap any holding in the Portfolio tab to open details, then tap Edit.
- Delete holding: Swipe left on a holding in the Portfolio tab, or tap Edit > Delete.
- COMEX Vault Watch: Scroll down on the Today tab to see registered/eligible inventory data from CME Group.
- Market Intelligence: Today tab shows curated market news and COMEX alerts.
- Analytics: Analytics tab shows stack value history, spot price charts, cost basis analysis, and allocation breakdown.
- Settings: Manage notifications, subscription, and account from the Settings tab (gear icon).
- Troy: Tap the gold coin button on any tab to talk to Troy.`;

    // Build conversation for Gemini
    const contents = [];

    const history = Array.isArray(conversationHistory) ? conversationHistory.slice(-10) : [];
    for (const msg of history) {
      if (msg.role === 'user') {
        contents.push({ role: 'user', parts: [{ text: msg.content }] });
      } else if (msg.role === 'assistant') {
        contents.push({ role: 'model', parts: [{ text: msg.content }] });
      }
    }

    contents.push({ role: 'user', parts: [{ text: message }] });

    const geminiBody = {
      contents,
      system_instruction: { parts: [{ text: systemPrompt }] },
      generationConfig: { temperature: 0.7, maxOutputTokens: 2048 },
    };

    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
    const geminiResp = await axios.post(geminiUrl, geminiBody, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 30000,
    });

    const responseText = geminiResp.data?.candidates?.[0]?.content?.parts
      ?.filter(p => p.text)
      ?.map(p => p.text)
      ?.join('') || '';

    if (!responseText) {
      return res.status(500).json({ error: 'AI advisor returned an empty response' });
    }

    console.log(`🧠 [Advisor] Response for user ${userId}: ${responseText.length} chars`);
    return res.json({ response: responseText });

  } catch (error) {
    console.error('❌ [Advisor] Error:', error.message);
    return res.status(500).json({ error: 'Failed to get advisor response' });
  }
});

// Export functions for cron jobs and inter-module use
module.exports = router;
module.exports.runIntelligenceGeneration = runIntelligenceGeneration;
module.exports.generateDailyBrief = generateDailyBrief;
module.exports.generatePortfolioIntelligence = generatePortfolioIntelligence;
