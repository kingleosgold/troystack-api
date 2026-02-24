const express = require('express');
const axios = require('axios');
const supabase = require('../lib/supabase');

const router = express.Router();

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = 'gemini-2.5-flash';

// Quota constants
const FREE_DAILY_LIMIT = 3;
const GOLD_DAILY_LIMIT = 30;
const QUESTION_PERIOD_DAYS = 1;

// ============================================
// HELPERS
// ============================================

function isUUID(str) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str);
}

function generateTitle(message) {
  const trimmed = message.substring(0, 50);
  if (message.length > 50) {
    const lastSpace = trimmed.lastIndexOf(' ');
    if (lastSpace > 20) return trimmed.substring(0, lastSpace);
  }
  return trimmed;
}

// ============================================
// QUOTA HELPERS (follows scan-usage.js pattern)
// ============================================

async function getQuotaStatus(userId, tier) {
  const limit = (tier === 'gold' || tier === 'lifetime') ? GOLD_DAILY_LIMIT : FREE_DAILY_LIMIT;

  const { data, error } = await supabase
    .from('troy_question_usage')
    .select('questions_used, period_start')
    .eq('user_id', userId)
    .single();

  if (error && error.code !== 'PGRST116') throw error;

  const now = new Date();

  if (!data) {
    return {
      questionsUsed: 0,
      questionsLimit: limit,
      periodStart: now.toISOString(),
      resetsAt: new Date(now.getTime() + QUESTION_PERIOD_DAYS * 86400000).toISOString(),
    };
  }

  const periodStart = new Date(data.period_start);
  const resetsAt = new Date(periodStart.getTime() + QUESTION_PERIOD_DAYS * 86400000);

  if (now > resetsAt) {
    await supabase
      .from('troy_question_usage')
      .update({ questions_used: 0, period_start: now.toISOString() })
      .eq('user_id', userId);

    return {
      questionsUsed: 0,
      questionsLimit: limit,
      periodStart: now.toISOString(),
      resetsAt: new Date(now.getTime() + QUESTION_PERIOD_DAYS * 86400000).toISOString(),
    };
  }

  return {
    questionsUsed: data.questions_used,
    questionsLimit: limit,
    periodStart: data.period_start,
    resetsAt: resetsAt.toISOString(),
  };
}

async function incrementQuota(userId) {
  const now = new Date();

  const { data: existing } = await supabase
    .from('troy_question_usage')
    .select('questions_used, period_start')
    .eq('user_id', userId)
    .single();

  if (!existing) {
    await supabase.from('troy_question_usage').insert({
      user_id: userId,
      questions_used: 1,
      period_start: now.toISOString(),
    });
    return;
  }

  const resetsAt = new Date(new Date(existing.period_start).getTime() + QUESTION_PERIOD_DAYS * 86400000);

  if (now > resetsAt) {
    await supabase
      .from('troy_question_usage')
      .update({ questions_used: 1, period_start: now.toISOString() })
      .eq('user_id', userId);
  } else {
    await supabase
      .from('troy_question_usage')
      .update({ questions_used: existing.questions_used + 1 })
      .eq('user_id', userId);
  }
}

// ============================================
// POST /troy/conversations — Create new conversation
// ============================================

router.post('/conversations', async (req, res) => {
  try {
    const { userId, title } = req.body;

    if (!userId || !isUUID(userId)) {
      return res.status(400).json({ error: 'Valid userId is required' });
    }

    const { data, error } = await supabase
      .from('troy_conversations')
      .insert({
        user_id: userId,
        title: title || 'New conversation',
      })
      .select('id, title, created_at')
      .single();

    if (error) throw error;

    res.json(data);
  } catch (err) {
    console.error('[Troy Chat] Create conversation error:', err.message);
    res.status(500).json({ error: 'Failed to create conversation' });
  }
});

// ============================================
// GET /troy/conversations — List conversations
// ============================================

router.get('/conversations', async (req, res) => {
  try {
    const userId = req.query.userId;

    if (!userId || !isUUID(userId)) {
      return res.status(400).json({ error: 'Valid userId is required' });
    }

    const { data, error } = await supabase
      .from('troy_conversations')
      .select('id, title, created_at, updated_at')
      .eq('user_id', userId)
      .order('updated_at', { ascending: false })
      .limit(50);

    if (error) throw error;

    res.json({ conversations: data || [] });
  } catch (err) {
    console.error('[Troy Chat] List conversations error:', err.message);
    res.status(500).json({ error: 'Failed to list conversations' });
  }
});

// ============================================
// GET /troy/conversations/:id — Get conversation + messages
// ============================================

router.get('/conversations/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.query.userId;

    if (!userId || !isUUID(userId)) {
      return res.status(400).json({ error: 'Valid userId is required' });
    }
    if (!id || !isUUID(id)) {
      return res.status(400).json({ error: 'Valid conversation id is required' });
    }

    // Verify ownership
    const { data: conversation, error: convError } = await supabase
      .from('troy_conversations')
      .select('id, title, created_at, updated_at')
      .eq('id', id)
      .eq('user_id', userId)
      .single();

    if (convError || !conversation) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    // Fetch all messages
    const { data: messages, error: msgError } = await supabase
      .from('troy_messages')
      .select('id, role, content, created_at')
      .eq('conversation_id', id)
      .order('created_at', { ascending: true });

    if (msgError) throw msgError;

    res.json({
      ...conversation,
      messages: messages || [],
    });
  } catch (err) {
    console.error('[Troy Chat] Get conversation error:', err.message);
    res.status(500).json({ error: 'Failed to get conversation' });
  }
});

// ============================================
// DELETE /troy/conversations/:id — Delete conversation
// ============================================

router.delete('/conversations/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.query.userId;

    if (!userId || !isUUID(userId)) {
      return res.status(400).json({ error: 'Valid userId is required' });
    }
    if (!id || !isUUID(id)) {
      return res.status(400).json({ error: 'Valid conversation id is required' });
    }

    // Verify ownership and delete
    const { data, error } = await supabase
      .from('troy_conversations')
      .delete()
      .eq('id', id)
      .eq('user_id', userId)
      .select();

    if (error) throw error;

    if (!data || data.length === 0) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    res.json({ success: true });
  } catch (err) {
    console.error('[Troy Chat] Delete conversation error:', err.message);
    res.status(500).json({ error: 'Failed to delete conversation' });
  }
});

// ============================================
// POST /troy/conversations/:id/messages — Send message (core endpoint)
// ============================================

router.post('/conversations/:id/messages', async (req, res) => {
  try {
    if (!GEMINI_API_KEY) {
      return res.status(503).json({ error: 'AI advisor is not configured' });
    }

    const { id } = req.params;
    const { userId, message } = req.body;

    // --- Validation ---
    if (!userId || !isUUID(userId)) {
      return res.status(400).json({ error: 'Valid userId is required' });
    }
    if (!id || !isUUID(id)) {
      return res.status(400).json({ error: 'Valid conversation id is required' });
    }
    if (!message || typeof message !== 'string' || message.length > 2000) {
      return res.status(400).json({ error: 'Message is required (max 2000 characters)' });
    }

    // --- Tier check (same as /v1/advisor/chat) ---
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('subscription_tier')
      .eq('id', userId)
      .single();

    if (profileError || !profile) {
      return res.status(404).json({ error: 'User profile not found' });
    }

    const tier = profile.subscription_tier || 'free';

    // --- Quota check ---
    const quota = await getQuotaStatus(userId, tier);
    if (quota.questionsUsed >= quota.questionsLimit) {
      return res.status(403).json({
        error: 'Daily question limit reached',
        questionsUsed: quota.questionsUsed,
        questionsLimit: quota.questionsLimit,
        resetsAt: quota.resetsAt,
      });
    }

    // --- Verify conversation ownership ---
    const { data: conversation, error: convError } = await supabase
      .from('troy_conversations')
      .select('id, title')
      .eq('id', id)
      .eq('user_id', userId)
      .single();

    if (convError || !conversation) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    // --- Fetch existing messages (last 10 for context) ---
    const { data: existingMessages, error: msgError } = await supabase
      .from('troy_messages')
      .select('role, content')
      .eq('conversation_id', id)
      .order('created_at', { ascending: false })
      .limit(10);

    if (msgError) throw msgError;

    const priorMessages = (existingMessages || []).reverse();
    const isFirstMessage = priorMessages.length === 0;

    // --- Insert user message ---
    const { error: insertUserError } = await supabase
      .from('troy_messages')
      .insert({
        conversation_id: id,
        role: 'user',
        content: message,
      });

    if (insertUserError) throw insertUserError;

    // ====================================================
    // AI CALL — same pattern as /v1/advisor/chat
    // (intelligence.js lines 715-901)
    // ====================================================

    // Fetch user's holdings
    const { data: holdings, error: holdingsError } = await supabase
      .from('holdings')
      .select('metal, type, weight, weight_unit, quantity, purchase_price, purchase_date, notes')
      .eq('user_id', userId)
      .is('deleted_at', null)
      .order('created_at', { ascending: false });

    if (holdingsError) {
      console.error('[Troy Chat] Holdings fetch error:', holdingsError.message);
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

    // Build Gemini contents from stored messages
    const contents = [];
    for (const msg of priorMessages) {
      if (msg.role === 'user') {
        contents.push({ role: 'user', parts: [{ text: msg.content }] });
      } else if (msg.role === 'assistant') {
        contents.push({ role: 'model', parts: [{ text: msg.content }] });
      }
    }
    contents.push({ role: 'user', parts: [{ text: message }] });

    // Call Gemini
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
    const geminiResp = await axios.post(geminiUrl, {
      contents,
      system_instruction: { parts: [{ text: systemPrompt }] },
      generationConfig: { temperature: 0.7, maxOutputTokens: 2048 },
    }, {
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

    // ====================================================
    // END AI CALL
    // ====================================================

    // --- Insert assistant message ---
    const { data: assistantMsg, error: insertAssistantError } = await supabase
      .from('troy_messages')
      .insert({
        conversation_id: id,
        role: 'assistant',
        content: responseText,
      })
      .select('id, role, content, created_at')
      .single();

    if (insertAssistantError) throw insertAssistantError;

    // --- Update conversation updated_at ---
    await supabase
      .from('troy_conversations')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', id);

    // --- Auto-generate title on first message ---
    let title = conversation.title;
    if (isFirstMessage) {
      title = generateTitle(message);
      await supabase
        .from('troy_conversations')
        .update({ title })
        .eq('id', id);
    }

    // --- Increment quota (only after successful response) ---
    await incrementQuota(userId);

    console.log(`[Troy Chat] Response for user ${userId}, conv ${id}: ${responseText.length} chars`);

    res.json({
      message: assistantMsg,
      title,
    });

  } catch (error) {
    console.error('[Troy Chat] Message error:', error.message);
    res.status(500).json({ error: 'Failed to get advisor response' });
  }
});

module.exports = router;
