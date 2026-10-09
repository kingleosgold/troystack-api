// Troy for visitors on troystack.ai who haven't signed in.
//
// POST /v1/troy/ask        { message, history? }  -> { reply, questionsUsed, questionsLimit, resetsAt }
// GET  /v1/troy/ask/status                         -> { questionsUsed, questionsLimit, resetsAt }
//
// Single answers with no saved history. The page keeps the last few turns and
// sends them back so a follow-up question has context. Each visitor (keyed by
// IP, the same key the public rate limiter uses) gets TROY_ASK_LIMIT answers
// per rolling 24 hours, the same 3 a free account gets. A process-wide daily
// budget caps total spend across all visitors, the way the MCP chat's
// anonymous budget does. Both counters live in memory, so a restart resets
// them, which errs toward answering people.

const express = require('express');
const { ipKeyGenerator } = require('express-rate-limit');
const { createDailyBudget } = require('../lib/daily-budget');
const { TROY_PERSONA, TROY_KNOWLEDGE } = require('../services/troy-prompt');

const DEFAULT_LIMIT = 3;
const DEFAULT_DAILY_BUDGET = 200;
const WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_MESSAGE_CHARS = 500;
const MAX_HISTORY_TURNS = 6;
const MAX_HISTORY_CHARS = 1500;
const SWEEP_AT = 5000;

function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function visitorKey(req) {
  return ipKeyGenerator(req.ip || req.socket?.remoteAddress || 'unknown');
}

// Keep only well-formed user and assistant turns, trimmed, newest last.
function cleanHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter((t) => t && (t.role === 'user' || t.role === 'assistant') && typeof t.content === 'string' && t.content.trim())
    .slice(-MAX_HISTORY_TURNS)
    .map((t) => ({ role: t.role, content: t.content.trim().slice(0, MAX_HISTORY_CHARS) }));
}

function money(n) {
  return Number.isFinite(n) && n > 0 ? `$${n}` : 'unavailable';
}

function visitorBlock(prices) {
  const ratio = prices.gold > 0 && prices.silver > 0 ? (prices.gold / prices.silver).toFixed(1) : 'unavailable';
  return `THE PERSON YOU'RE TALKING TO:
A visitor on troystack.ai who hasn't signed in. You don't know what they hold, so never invent a stack for them. If they ask about their own stack, tell them they can add it at troystack.ai/stack or in the TroyStack iPhone app, and you'll know it from then on. Keep this answer under 180 words.

CURRENT SPOT:
Gold: ${money(prices.gold)}, Silver: ${money(prices.silver)}, Platinum: ${money(prices.platinum)}, Palladium: ${money(prices.palladium)}
Gold/Silver Ratio: ${ratio}

`;
}

function communityBlock(intel) {
  return intel ? `WHAT THE COMMUNITY IS DISCUSSING TODAY:
${intel}

Reference these community discussions naturally when relevant.` : '';
}

/**
 * @param {object} deps
 * @param {object} deps.llm - { isConfigured(), generateTroyReply(args) }
 * @param {() => Promise<object>} deps.getPrices - resolves { gold, silver, platinum, palladium }
 * @param {() => Promise<string>} [deps.getIntel] - community chatter, '' when none
 * @param {() => number} [deps.now]
 * @param {object} [deps.env]
 */
function createTroyAskRouter({ llm, getPrices, getIntel = async () => '', now = () => Date.now(), env = process.env }) {
  const router = express.Router();
  const limit = positiveInt(env.TROY_ASK_LIMIT, DEFAULT_LIMIT);
  const budget = createDailyBudget(positiveInt(env.TROY_ASK_DAILY_BUDGET, DEFAULT_DAILY_BUDGET));
  const asked = new Map(); // visitor key -> timestamps of answered questions

  function recent(key, at) {
    const kept = (asked.get(key) || []).filter((t) => at - t < WINDOW_MS);
    if (kept.length) asked.set(key, kept);
    else asked.delete(key);
    return kept;
  }

  function sweep(at) {
    if (asked.size < SWEEP_AT) return;
    for (const key of [...asked.keys()]) recent(key, at);
  }

  function status(key, at) {
    const times = recent(key, at);
    const resetsAt = new Date((times[0] ?? at) + WINDOW_MS).toISOString();
    return { questionsUsed: times.length, questionsLimit: limit, resetsAt };
  }

  router.get('/ask/status', (req, res) => {
    res.json(status(visitorKey(req), now()));
  });

  router.post('/ask', async (req, res) => {
    const { message, history } = req.body || {};
    if (typeof message !== 'string' || !message.trim() || message.length > MAX_MESSAGE_CHARS) {
      return res.status(400).json({ error: `Message is required (max ${MAX_MESSAGE_CHARS} characters)` });
    }
    if (!llm.isConfigured()) {
      return res.status(503).json({ error: 'Troy is unavailable right now' });
    }

    const at = now();
    sweep(at);
    const key = visitorKey(req);
    const before = status(key, at);
    if (before.questionsUsed >= limit) {
      return res.status(429).json({ error: 'Visitor question limit reached', ...before });
    }
    if (!budget.take(new Date(at))) {
      return res.status(503).json({ error: 'Troy is answering too many visitors right now. Try again later.' });
    }

    // Hold the slot now so two questions sent at once can't both slip under
    // the limit. It's handed back if Troy doesn't answer.
    asked.set(key, [...recent(key, at), at]);
    const release = () => {
      const times = asked.get(key) || [];
      const i = times.lastIndexOf(at);
      if (i !== -1) times.splice(i, 1);
      if (times.length) asked.set(key, times);
      else asked.delete(key);
    };

    try {
      let prices = {};
      try {
        prices = (await getPrices()) || {};
      } catch (e) {
        console.error('[Troy Ask] Price fetch failed:', e.message);
      }
      let intel = '';
      try {
        intel = await getIntel();
      } catch (e) {
        console.log(`[Troy Ask] Intelligence fetch error (non-fatal): ${e.message}`);
      }

      const reply = await llm.generateTroyReply({
        userId: null,
        priorMessages: cleanHistory(history),
        message: message.trim(),
        prompt: {
          persona: TROY_PERSONA,
          stack: visitorBlock(prices),
          knowledge: TROY_KNOWLEDGE,
          community: communityBlock(intel),
        },
      });

      const text = (reply && reply.text || '').trim();
      if (!text) {
        release();
        return res.status(502).json({ error: 'Troy could not answer right now' });
      }

      console.log(`[Troy Ask] Visitor answer: ${text.length} chars, ${reply.provider}/${reply.model}${reply.fellBack ? ' (fallback)' : ''}`);
      return res.json({ reply: text, ...status(key, at) });
    } catch (error) {
      release();
      console.error('[Troy Ask] Error:', error.message);
      return res.status(502).json({ error: 'Troy could not answer right now' });
    }
  });

  return router;
}

module.exports = { createTroyAskRouter, cleanHistory, visitorBlock, DEFAULT_LIMIT, MAX_MESSAGE_CHARS };
