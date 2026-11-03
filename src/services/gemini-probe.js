// A one-time live check of the Gemini model that takes over on 12/1/2026.
//
// Google retires gemini-2.5-flash on 12/1 and sends its traffic to
// gemini-3.5-flash-lite. Before the API's default moves, every request shape
// the API sends should be seen working on that model. This runs each shape
// once against the candidate model, a while after the server starts, and
// writes one [GeminiProbe] line per shape to the log. No user request goes to
// the candidate and nothing is stored. The key stays in the request URL and
// is never logged.
//
// GEMINI_CANDIDATE_MODEL picks a different candidate. GEMINI_PROBE=off turns
// the probe off. It skips itself when the candidate is already the live model.

const axios = require('axios');
const {
  flashModel,
  CANDIDATE_FLASH,
  candidateFlashModel,
  thinkingOffConfig,
  generationConfig,
  historyContents,
  geminiUrl,
  responseText,
} = require('./gemini-models');
const receipt = require('./gemini-probe-receipt');
const { EXTRACTION_PROMPT } = require('./extraction-prompt');

const START_DELAY_MS = 90 * 1000;

// The probe only matters until the default moves. Past this date Google has
// redirected 2.5 Flash anyway, so it stops calling on its own.
const PROBE_UNTIL = Date.parse('2026-12-15T00:00:00Z');

function candidateModel(env = process.env) {
  return candidateFlashModel(env);
}

function probeEnabled(env = process.env, now = Date.now()) {
  if (!env.GEMINI_API_KEY) return false;
  if (now >= PROBE_UNTIL) return false;
  if (String(env.GEMINI_PROBE || '').trim().toLowerCase() === 'off') return false;
  return candidateModel(env) !== flashModel(env);
}

function stripFences(text) {
  return String(text || '').replace(/^```(?:json)?\s*\n?/g, '').replace(/\n?```\s*$/g, '').trim();
}

// geminiSearch's parse: fences stripped, then plain JSON.parse, nothing else.
function parseStrict(text) {
  try { return JSON.parse(stripFences(text)); } catch { return undefined; }
}

// The looser parse the scoring and receipt callers fall back to, which also
// pulls the JSON out of words around it.
function parseJson(text) {
  const cleaned = stripFences(text);
  try {
    return JSON.parse(cleaned);
  } catch {
    const m = cleaned.match(/[[{][\s\S]*[\]}]/);
    if (!m) return undefined;
    try { return JSON.parse(m[0]); } catch { return undefined; }
  }
}

// Each check builds the same request body its production caller builds, on
// the candidate model, and says whether the answer is usable.
function checks(model) {
  return [
    {
      // The admin health check's ping, callGemini with a 10-token cap and
      // thinking at its default. The health check itself goes green on any
      // answer, so a FAIL here with finish=MAX_TOKENS means thinking used up
      // the 10 tokens, not that the switch is unsafe.
      name: 'ping',
      timeout: 30000,
      body: {
        contents: [{ role: 'user', parts: [{ text: 'ping' }] }],
        system_instruction: { parts: [{ text: 'You are a ping responder. Reply with exactly "pong".' }] },
        generationConfig: generationConfig(model, { temperature: 0.3, maxOutputTokens: 10 }),
      },
      judge: (text) => (text.trim() ? null : 'empty answer'),
    },
    {
      // Signal scoring and clustering, callGemini with thinking off, JSON
      // out and the default 4096 tokens.
      name: 'score',
      timeout: 30000,
      body: {
        contents: [{ role: 'user', parts: [{ text: 'Score this article for precious metals stacker relevance from 0 to 10:\n1. "Silver climbs as industrial demand rises"' }] }],
        system_instruction: { parts: [{ text: 'Return ONLY a JSON array like [{"index":1,"score":7}].' }] },
        generationConfig: {
          ...generationConfig(model, { temperature: 0.2, maxOutputTokens: 4096 }),
          responseMimeType: 'application/json',
          ...(thinkingOffConfig(model) ? { thinkingConfig: thinkingOffConfig(model) } : {}),
        },
      },
      judge: (text, finish) => {
        if (finish !== 'STOP') return `finish was ${finish}`;
        const v = parseJson(text);
        return Array.isArray(v) && v.length ? null : 'answer is not a JSON array';
      },
    },
    {
      // The Signal one-liner, plain text, thinking off, 100 tokens.
      name: 'oneliner',
      timeout: 30000,
      body: {
        contents: [{ role: 'user', parts: [{ text: 'Write one short line for stackers about this headline: "Silver climbs as industrial demand rises"' }] }],
        system_instruction: { parts: [{ text: 'Reply with one sentence, no quotes.' }] },
        generationConfig: {
          ...generationConfig(model, { temperature: 0.5, maxOutputTokens: 100 }),
          ...(thinkingOffConfig(model) ? { thinkingConfig: thinkingOffConfig(model) } : {}),
        },
      },
      judge: (text, finish) => (finish !== 'STOP' ? `finish was ${finish}` : text.trim() ? null : 'empty answer'),
    },
    {
      // The scraper's extraction calls, its own prompt, thinking off at 512
      // tokens. A cut-off answer makes the scraper save empty claims.
      name: 'extract',
      timeout: 30000,
      body: {
        contents: [{ role: 'user', parts: [{ text: 'Source: Kitco News\nArticle: COMEX registered silver fell to 120 million ounces this week, the lowest since 2023. Analysts at two banks raised their year-end gold target to $3,000 and said Fed rate cuts and central bank buying keep demand strong. One fund manager expects silver to reach $40 by the end of 2026 as industrial demand from solar keeps growing.' }] }],
        system_instruction: { parts: [{ text: EXTRACTION_PROMPT }] },
        generationConfig: {
          ...generationConfig(model, { temperature: 0.2, maxOutputTokens: 512 }),
          ...(thinkingOffConfig(model) ? { thinkingConfig: thinkingOffConfig(model) } : {}),
        },
      },
      judge: (text, finish) => {
        if (finish !== 'STOP') return `finish was ${finish}`;
        const v = parseJson(text);
        return v && Array.isArray(v.claims) && v.claims.length ? null : 'no claims array';
      },
    },
    {
      // geminiSearch in routes/intelligence.js, with Google Search grounding.
      name: 'search',
      timeout: 30000,
      body: {
        contents: [{ role: 'user', parts: [{ text: 'What is the latest spot price of gold in US dollars per ounce? Return {"gold_usd": number, "as_of": string}.' }] }],
        tools: [{ google_search: {} }],
        system_instruction: { parts: [{ text: 'Return ONLY valid JSON, no markdown.' }] },
        generationConfig: generationConfig(model, { temperature: 0.3 }),
      },
      judge: (text) => (parseStrict(text) !== undefined ? null : 'answer is not plain JSON, geminiSearch would return null'),
    },
    {
      // Troy chat and the in-app advisor, multi-turn, thinking at its
      // default, 8192 output tokens.
      name: 'chat',
      timeout: 30000,
      body: {
        contents: historyContents(
          [
            { role: 'user', content: 'I have 20 oz of silver.' },
            { role: 'assistant', content: 'Nice start. What are you stacking toward?' },
          ],
          'In one sentence, should I add gold next?',
        ),
        system_instruction: { parts: [{ text: 'You are Troy, a plain-spoken precious metals guide. Keep replies short.' }] },
        generationConfig: generationConfig(model, { temperature: 0.7, maxOutputTokens: 8192 }),
      },
      judge: (text, finish) => (finish !== 'STOP' ? `finish was ${finish}` : text.trim() ? null : 'empty answer'),
    },
    {
      // The receipt scanner's request shape, an image plus an extraction
      // prompt. The prompt is a short stand-in for the route's, so a PASS
      // shows the image path works on the model, not the full prompt's
      // quality on real receipts.
      name: 'receipt',
      timeout: 60000,
      body: {
        contents: [{
          parts: [
            { text: 'Extract precious metals purchase data from this receipt image. Only coins, bars and rounds, no accessories or items under $10. Return ONLY valid JSON: {"dealer": string, "purchaseDate": "YYYY-MM-DD", "items": [{"description": string, "quantity": number, "unitPrice": number, "metal": "gold"|"silver"|"platinum"|"palladium", "ozt": number}]}' },
            { inline_data: { mime_type: receipt.mimeType, data: receipt.data } },
          ],
        }],
        generationConfig: generationConfig(model, { temperature: 0.1, maxOutputTokens: 2048 }),
      },
      judge: (text) => {
        const v = parseJson(text);
        const items = v && Array.isArray(v.items) ? v.items : null;
        if (!items) return 'no items array';
        const silver = items.find(i => i && String(i.metal).toLowerCase() === 'silver');
        const gold = items.find(i => i && String(i.metal).toLowerCase() === 'gold');
        if (items.length !== 2 || !silver || !gold) return `read ${items.length} items, wanted the silver and the gold only`;
        if (Number(silver.quantity) !== 10 || Number(silver.unitPrice) !== 34.5) return 'silver line read wrong';
        if (Number(gold.quantity) !== 1 || Number(gold.unitPrice) !== 2712) return 'gold line read wrong';
        return null;
      },
    },
  ];
}

// Google's own error text, short, never the request URL.
function errorDetail(err) {
  const status = err?.response?.status;
  const msg = err?.response?.data?.error?.message || err?.code || 'request failed';
  return `${status ? `HTTP ${status} ` : ''}${String(msg).slice(0, 200)}`;
}

async function runCandidateProbe({ env = process.env, post = axios.post, log = console.log, now = Date.now() } = {}) {
  if (!probeEnabled(env, now)) return [];
  const model = candidateModel(env);
  const url = geminiUrl(model, env.GEMINI_API_KEY);
  const results = [];
  for (const check of checks(model)) {
    const t0 = Date.now();
    let result;
    try {
      const resp = await post(url, check.body, { headers: { 'Content-Type': 'application/json' }, timeout: check.timeout });
      const data = resp && resp.data;
      const text = responseText(data);
      const finish = data?.candidates?.[0]?.finishReason || 'none';
      let problem;
      try {
        problem = check.judge(text, finish);
      } catch (e) {
        problem = `judge error: ${String(e && e.message).slice(0, 100)}`;
      }
      const usage = data?.usageMetadata || {};
      result = {
        name: check.name,
        ok: !problem,
        detail: `finish=${finish} out=${usage.candidatesTokenCount ?? '?'} thoughts=${usage.thoughtsTokenCount ?? 0}${problem ? ` ${problem}` : ''}`,
      };
    } catch (err) {
      result = { name: check.name, ok: false, detail: errorDetail(err) };
    }
    result.ms = Date.now() - t0;
    results.push(result);
    log(`[GeminiProbe] ${model} ${result.name} ${result.ok ? 'PASS' : 'FAIL'} ${result.ms}ms ${result.detail}`);
  }
  const passed = results.filter(r => r.ok).length;
  log(`[GeminiProbe] ${model} done, ${passed} of ${results.length} passed`);
  return results;
}

// Called once from app.listen. The delay keeps the probe off the boot path
// and out of the first requests after a deploy.
function scheduleCandidateProbe({ env = process.env, delayMs = START_DELAY_MS } = {}) {
  if (!probeEnabled(env)) return null;
  const timer = setTimeout(() => {
    runCandidateProbe({ env }).catch(err => console.log(`[GeminiProbe] stopped: ${String(err && err.message).slice(0, 200)}`));
  }, delayMs);
  if (timer.unref) timer.unref();
  return timer;
}

module.exports = {
  DEFAULT_CANDIDATE: CANDIDATE_FLASH,
  candidateModel,
  probeEnabled,
  parseJson,
  parseStrict,
  checks,
  runCandidateProbe,
  scheduleCandidateProbe,
};
