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

  // ── STEP 2: VAULT DATA (2 targeted searches + open interest) ──

  console.log(`\n🏦 [Vault] ===== STEP 2: COMEX VAULT DATA =====`);

  const VAULT_SYSTEM = `You are a COMEX warehouse data analyst. Search for the most recent COMEX vault / warehouse inventory numbers posted online. Reddit communities like r/WallstreetSilver and r/SilverDegenClub post these daily, as do sites like Kitco, SilverSeek, and GoldSeek. Return precise numbers in troy ounces. Only return data if you find actual reported numbers — do not estimate or fabricate. Return ONLY valid JSON, no markdown.`;

  const VAULT_AG_AU_PROMPT = `COMEX silver gold registered eligible inventory ounces today ${today} site:reddit.com OR site:kitco.com OR site:silverseek.com OR site:goldseek.com`;
  const VAULT_AG_AU_SYSTEM = `${VAULT_SYSTEM} Search for the latest COMEX warehouse inventory numbers for silver and gold. Look for posts or articles from the last 48 hours that report registered, eligible, and total inventory in troy ounces, plus daily changes. Return JSON: { "gold": { "registered_oz": number, "eligible_oz": number, "registered_change_oz": number, "eligible_change_oz": number }, "silver": { "registered_oz": number, "eligible_oz": number, "registered_change_oz": number, "eligible_change_oz": number } }. Use real numbers from actual reports. If you cannot find real numbers for a metal, omit that key entirely. Return ONLY JSON.`;

  const VAULT_PT_PD_PROMPT = `COMEX NYMEX platinum palladium registered eligible warehouse inventory ounces ${today}`;
  const VAULT_PT_PD_SYSTEM = `${VAULT_SYSTEM} Search for the latest COMEX/NYMEX warehouse inventory numbers for platinum and palladium. Return JSON: { "platinum": { "registered_oz": number, "eligible_oz": number, "registered_change_oz": number, "eligible_change_oz": number }, "palladium": { "registered_oz": number, "eligible_oz": number, "registered_change_oz": number, "eligible_change_oz": number } }. Use real numbers from actual reports. If you cannot find real numbers for a metal, omit that key entirely. Return ONLY JSON.`;

  const VAULT_OI_PROMPT = `COMEX gold silver platinum palladium open interest contracts today ${today} site:cmegroup.com OR site:barchart.com OR site:kitco.com`;
  const VAULT_OI_SYSTEM = `Search for the latest COMEX open interest for gold, silver, platinum, and palladium futures (active front month). Convert contracts to troy ounces (gold=100oz/contract, silver=5000oz/contract, platinum=50oz/contract, palladium=100oz/contract). Return JSON: { "gold": { "open_interest_oz": number }, "silver": { "open_interest_oz": number }, "platinum": { "open_interest_oz": number }, "palladium": { "open_interest_oz": number } }. Use real numbers. Omit metals you cannot find. Return ONLY JSON.`;

  // Run vault searches
  apiCalls += 3;
  console.log(`🏦 [Vault] Search 1/3: Silver & Gold inventory...`);
  const agAuResult = await geminiSearch(VAULT_AG_AU_PROMPT, VAULT_AG_AU_SYSTEM);
  await new Promise(r => setTimeout(r, 1000));

  console.log(`🏦 [Vault] Search 2/3: Platinum & Palladium inventory...`);
  const ptPdResult = await geminiSearch(VAULT_PT_PD_PROMPT, VAULT_PT_PD_SYSTEM);
  await new Promise(r => setTimeout(r, 1000));

  console.log(`🏦 [Vault] Search 3/3: Open interest...`);
  const oiResult = await geminiSearch(VAULT_OI_PROMPT, VAULT_OI_SYSTEM);

  // Merge results
  const vaultMerged = {};
  for (const result of [agAuResult, ptPdResult]) {
    if (result && typeof result === 'object' && !Array.isArray(result)) {
      for (const metal of ['gold', 'silver', 'platinum', 'palladium']) {
        if (result[metal]) vaultMerged[metal] = { ...(vaultMerged[metal] || {}), ...result[metal] };
      }
    }
  }
  // Merge open interest
  if (oiResult && typeof oiResult === 'object' && !Array.isArray(oiResult)) {
    for (const metal of ['gold', 'silver', 'platinum', 'palladium']) {
      if (oiResult[metal]?.open_interest_oz) {
        vaultMerged[metal] = { ...(vaultMerged[metal] || {}), open_interest_oz: oiResult[metal].open_interest_oz };
      }
    }
  }

  let vaultInserted = 0;
  const metalsWithData = Object.keys(vaultMerged).filter(m => {
    const d = vaultMerged[m];
    return d && (parseFloat(d.registered_oz) > 0 || parseFloat(d.eligible_oz) > 0);
  });

  console.log(`🏦 [Vault] Found data for: ${metalsWithData.length > 0 ? metalsWithData.join(', ') : 'none'}`);

  if (metalsWithData.length > 0) {
    try {
      await supabase.from('vault_data').delete().eq('date', today).eq('source', 'comex');
      console.log(`🏦 [Vault] Cleared existing data for ${today}`);
    } catch (err) {
      console.log(`🏦 [Vault] Clear failed: ${err.message}`);
    }

    for (const metal of metalsWithData) {
      const md = vaultMerged[metal];
      try {
        const registered = parseFloat(md.registered_oz) || 0;
        const eligible = parseFloat(md.eligible_oz) || 0;
        const regChange = parseFloat(md.registered_change_oz) || 0;
        const eligChange = parseFloat(md.eligible_change_oz) || 0;
        const openInterest = parseFloat(md.open_interest_oz) || 0;

        if (registered === 0 && eligible === 0) {
          console.log(`     ${metal}: Skipped (zero inventory)`);
          continue;
        }

        const combined = registered + eligible;
        const combinedChange = regChange + eligChange;
        const oversubscribed = registered > 0 && openInterest > 0 ? Math.round((openInterest / registered) * 100) / 100 : 0;

        const row = {
          date: today,
          source: 'comex',
          metal,
          registered_oz: registered,
          eligible_oz: eligible,
          combined_oz: combined,
          registered_change_oz: regChange,
          eligible_change_oz: eligChange,
          combined_change_oz: combinedChange,
          open_interest_oz: openInterest,
          oversubscribed_ratio: oversubscribed,
        };

        await supabase.from('vault_data').insert(row);
        vaultInserted++;
        console.log(`     ✅ ${metal}: registered=${registered.toLocaleString()} oz${openInterest > 0 ? `, ratio=${oversubscribed}x` : ', no OI'}`);
      } catch (err) {
        console.log(`     ❌ ${metal}: ${err.message}`);
        errors.push(`Vault ${metal}: ${err.message}`);
      }
    }

    // ── COMEX AUTO-ALERTS: check for >2% registered inventory changes ──
    if (vaultInserted > 0) {
      try {
        const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
        const { data: yesterdayData } = await supabase.from('vault_data')
          .select('metal, registered_oz')
          .eq('date', yesterday)
          .eq('source', 'comex');

        if (yesterdayData && yesterdayData.length > 0) {
          const yesterdayMap = {};
          for (const row of yesterdayData) {
            yesterdayMap[row.metal] = row.registered_oz;
          }

          const comexAlerts = [];
          for (const metal of metalsWithData) {
            const todayReg = parseFloat(vaultMerged[metal].registered_oz) || 0;
            const yestReg = yesterdayMap[metal];
            if (!yestReg || yestReg === 0 || todayReg === 0) continue;

            const changePct = ((todayReg - yestReg) / yestReg) * 100;
            if (Math.abs(changePct) >= 2) {
              const changeOz = todayReg - yestReg;
              const direction = changePct > 0 ? 'rose' : 'dropped';
              const metalName = metal.charAt(0).toUpperCase() + metal.slice(1);
              const fmtOz = (v) => {
                const abs = Math.abs(v);
                if (abs >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
                if (abs >= 1e3) return `${(v / 1e3).toFixed(0)}K`;
                return v.toLocaleString();
              };
              comexAlerts.push({
                title: `🏦 ${metalName} COMEX Alert`,
                body: `Registered inventory ${direction} ${fmtOz(Math.abs(changeOz))} oz (${changePct > 0 ? '+' : ''}${changePct.toFixed(1)}%) today`,
                metal,
                severity: Math.abs(changePct) >= 5 ? 'high' : 'medium',
              });
            }
          }

          if (comexAlerts.length > 0) {
            console.log(`🏦 [COMEX Alert] ${comexAlerts.length} metals with >2% change detected`);

            const { data: tokens } = await supabase.from('push_tokens')
              .select('expo_push_token, user_id')
              .order('last_active', { ascending: false });

            const { data: disabledPrefs } = await supabase
              .from('notification_preferences')
              .select('user_id')
              .eq('breaking_news', false);

            const disabledUserIds = new Set((disabledPrefs || []).map(p => p.user_id));

            const seenUsers = new Set();
            const validTokens = [];
            for (const t of (tokens || [])) {
              if (!isValidExpoPushToken(t.expo_push_token)) continue;
              if (t.user_id && disabledUserIds.has(t.user_id)) continue;
              const key = t.user_id || t.expo_push_token;
              if (seenUsers.has(key)) continue;
              seenUsers.add(key);
              validTokens.push(t.expo_push_token);
            }

            for (const alert of comexAlerts) {
              try {
                await supabase.from('breaking_news').insert({
                  title: alert.title,
                  body: alert.body,
                  metal: alert.metal,
                  severity: alert.severity,
                });
              } catch (e) { console.log(`🏦 [COMEX Alert] Insert error: ${e.message}`); }

              if (validTokens.length > 0) {
                try {
                  const { sendBatchPush } = require('./push');
                  await sendBatchPush(validTokens, {
                    title: alert.title,
                    body: alert.body,
                    data: { type: 'breaking_news' },
                  });
                } catch (pushErr) {
                  console.error(`🏦 [COMEX Alert] Push error for ${alert.metal}: ${pushErr.message}`);
                }
              }
            }
          }
        }
      } catch (alertErr) {
        console.error(`🏦 [COMEX Alert] Error: ${alertErr.message}`);
      }
    }
  } else {
    console.log(`🏦 [Vault] ⚠️ No vault data found — previous day's data remains`);
  }

  // ── SUMMARY ──

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const estCost = (apiCalls * 0.01).toFixed(2);

  console.log(`\n${'━'.repeat(50)}`);
  console.log(`  Intelligence Generation Complete`);
  console.log(`  Briefs: ${briefsInserted} | Vault: ${vaultInserted}/4 | API calls: ${apiCalls}`);
  console.log(`  Cost: ~$${estCost} | Runtime: ${elapsed}s`);
  if (errors.length > 0) console.log(`  Errors: ${errors.length}`);
  console.log(`${'━'.repeat(50)}\n`);

  return { briefsInserted, vaultInserted, apiCalls, elapsed, estCost, errors };
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
  const systemPrompt = `You are a senior precious metals market analyst writing a personalized daily briefing for an investor. Be concise, insightful, and specific to their portfolio. Write 3-4 short paragraphs. Use plain text, no markdown headers or bullet points. Address the reader as "you" and reference their actual holdings. Do NOT start with "Good morning" or any time-of-day greeting — jump straight into the market analysis.`;

  const userPrompt = `Write a daily market brief for today (${today}).

PORTFOLIO:
Total Value: $${totalValue.toFixed(2)} | Cost Basis: $${totalCost.toFixed(2)} | ${totalValue >= totalCost ? 'Gain' : 'Loss'}: $${Math.abs(totalValue - totalCost).toFixed(2)}
Holdings: ${metalSummary || 'No holdings yet'}

SPOT PRICES:
Gold: $${prices.gold}, Silver: $${prices.silver}, Platinum: $${prices.platinum}, Palladium: $${prices.palladium}
Gold/Silver Ratio: ${prices.silver > 0 ? (prices.gold / prices.silver).toFixed(1) : 'N/A'}

TODAY'S NEWS:
${newsContext || 'No news available yet today.'}

Write a personalized briefing covering: 1) How today's market moves affect their specific portfolio, 2) Key news and what it means for their metals, 3) One brief forward-looking thought. Keep it under 250 words.`;

  const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
  const geminiResp = await axios.post(geminiUrl, {
    contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
    system_instruction: { parts: [{ text: systemPrompt }] },
    generationConfig: { temperature: 0.7, maxOutputTokens: 1024 },
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
      return `${m.charAt(0).toUpperCase() + m.slice(1)}: ${v.oz.toFixed(2)} oz, $${val.toFixed(0)} (${pct}% of portfolio), cost basis $${v.cost.toFixed(0)}, ${gain >= 0 ? '+' : ''}$${gain.toFixed(0)} (${gainPct}%)`;
    }).join('\n');

  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

  const systemPrompt = `You are a senior precious metals portfolio strategist. Return a JSON object with exactly three keys: "portfolio", "costBasis", and "purchaseStats". Each value is a plain-text paragraph (2-3 sentences). Do NOT use markdown, headers, or bullet points. Do NOT start with any greeting. Address the reader as "you".

- "portfolio": Allocation and diversification analysis — concentration risk, metal mix assessment, strategic positioning.
- "costBasis": Cost basis insights — unrealized gains/losses by metal, which positions are performing best/worst, average cost vs current spot.
- "purchaseStats": Buying patterns — purchase frequency observations, dollar-cost averaging assessment, timing insights.

Return ONLY valid JSON, no other text.`;

  const userPrompt = `Analyze this precious metals portfolio (${today}).

PORTFOLIO OVERVIEW:
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
    generationConfig: { temperature: 0.7, maxOutputTokens: 1024, responseMimeType: 'application/json' },
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
              title: '☀️ Your Daily Brief is Ready',
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

    const systemPrompt = `You are the Stack Advisor, an AI assistant for precious metals investors inside the Stack Tracker Gold app. You have access to the user's portfolio and current market data.

PORTFOLIO SUMMARY:
Total Value: $${totalValue.toFixed(2)}
Total Cost Basis: $${totalCost.toFixed(2)}
Overall ${totalValue >= totalCost ? 'Gain' : 'Loss'}: ${totalValue >= totalCost ? '+' : ''}$${(totalValue - totalCost).toFixed(2)} (${totalCost > 0 ? (((totalValue - totalCost) / totalCost) * 100).toFixed(1) : '0'}%)

BY METAL:
${metalSummary || 'No holdings'}

INDIVIDUAL HOLDINGS:
${holdingsText}

CURRENT SPOT PRICES:
Gold: $${prices.gold}, Silver: $${prices.silver}, Platinum: $${prices.platinum}, Palladium: $${prices.palladium}

MARKET CONTEXT:
Gold/Silver Ratio: ${gsRatio}

RULES:
- Give specific, actionable advice based on their actual portfolio
- Reference their holdings by name when relevant (e.g. "Your 1832 American Silver Eagles are up 64%...")
- Use current spot prices in calculations
- When discussing buying: mention current premiums and cost-per-oz context
- Be concise but thorough — this is for serious stackers, not beginners
- Never guarantee returns or make definitive price predictions
- Add a brief disclaimer at the end of financial advice responses
- Format responses with clear sections when appropriate using markdown (bold, bullet points)
- You can use dollar amounts and percentages freely
- Keep responses under 600 words`;

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
