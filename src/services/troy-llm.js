// Troy chat model routing.
//
// Troy's in-app chat runs on Gemini by default. Setting TROY_CHAT_PROVIDER=claude
// moves every user to Claude, and TROY_CHAT_CLAUDE_USER_IDS (comma-separated
// user ids) moves only those users, so one account can test Claude in
// production before everyone gets it. TROY_CHAT_MODEL overrides the Claude
// model. If the chosen provider errors or comes back empty, the other one
// answers when its key is set.
//
// The Gemini request is built exactly as troy-chat.js built it before this
// module existed, so the default path is unchanged.

const axios = require('axios');
const Anthropic = require('@anthropic-ai/sdk');
const { claudeTuning } = require('./ai-router');

const GEMINI_MODEL = 'gemini-2.5-flash';
const DEFAULT_CLAUDE_MODEL = 'claude-sonnet-5-5';
// Sonnet 5.5 thinks before it answers and max_tokens covers both. Low effort
// keeps that short so chat and voice replies come back fast.
const CLAUDE_MAX_TOKENS = 6000;
const CLAUDE_EFFORT = 'low';
const CLAUDE_TEMPERATURE = 0.7; // only sent to models older than 5.x
const CLAUDE_TIMEOUT_MS = 30000;
const GEMINI_TIMEOUT_MS = 30000;

let cachedClient = null;
let cachedClientKey = null;

function anthropicClient(apiKey) {
  if (!cachedClient || cachedClientKey !== apiKey) {
    cachedClient = new Anthropic({ apiKey });
    cachedClientKey = apiKey;
  }
  return cachedClient;
}

function canaryIds(env) {
  return String(env.TROY_CHAT_CLAUDE_USER_IDS || '')
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);
}

// Providers to try, in order. Empty means Troy chat isn't configured.
function providerOrder({ userId, env = process.env } = {}) {
  const wantsClaude = String(env.TROY_CHAT_PROVIDER || 'gemini').trim().toLowerCase() === 'claude'
    || (userId ? canaryIds(env).includes(String(userId).toLowerCase()) : false);
  const primary = wantsClaude ? 'claude' : 'gemini';
  const secondary = wantsClaude ? 'gemini' : 'claude';
  const available = {
    claude: Boolean(env.ANTHROPIC_API_KEY),
    gemini: Boolean(env.GEMINI_API_KEY),
  };
  return [primary, secondary].filter(p => available[p]);
}

function isConfigured(env = process.env) {
  return providerOrder({ env }).length > 0;
}

// The Gemini system prompt keeps the original section order.
function geminiSystemPrompt(prompt) {
  return `${prompt.persona}${prompt.stack}${prompt.knowledge}${prompt.community}`;
}

// Claude gets the fixed sections first so they can be cached across requests,
// then the per-user stack and today's community chatter.
function claudeSystemBlocks(prompt) {
  const fixed = `${prompt.persona}${prompt.knowledge}`.trimEnd();
  const live = `${prompt.stack}${prompt.community}`.trim();
  const blocks = [{ type: 'text', text: fixed, cache_control: { type: 'ephemeral' } }];
  if (live) blocks.push({ type: 'text', text: live });
  return blocks;
}

// Same mapping troy-chat.js used: user stays user, assistant becomes model,
// anything else is skipped, and the new message goes last.
function geminiContents(priorMessages, message) {
  const contents = [];
  for (const msg of priorMessages) {
    if (msg.role === 'user') {
      contents.push({ role: 'user', parts: [{ text: msg.content }] });
    } else if (msg.role === 'assistant') {
      contents.push({ role: 'model', parts: [{ text: msg.content }] });
    }
  }
  contents.push({ role: 'user', parts: [{ text: message }] });
  return contents;
}

// Claude wants alternating turns that open with the user. History can break
// that when an earlier reply failed after the user's message was saved, or
// when the 10-message window starts on an assistant turn.
function claudeMessages(priorMessages, message) {
  const turns = [];
  const push = (role, text) => {
    const last = turns[turns.length - 1];
    if (last && last.role === role) last.content = `${last.content}\n\n${text}`;
    else turns.push({ role, content: text });
  };
  for (const msg of priorMessages) {
    if (msg.role !== 'user' && msg.role !== 'assistant') continue;
    if (typeof msg.content !== 'string' || !msg.content.trim()) continue;
    push(msg.role, msg.content);
  }
  push('user', message);
  while (turns.length && turns[0].role !== 'user') turns.shift();
  return turns;
}

async function askGemini({ prompt, priorMessages, message, env, http }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${env.GEMINI_API_KEY}`;
  const resp = await http.post(url, {
    contents: geminiContents(priorMessages, message),
    system_instruction: { parts: [{ text: geminiSystemPrompt(prompt) }] },
    generationConfig: { temperature: 0.7, maxOutputTokens: 8192 },
  }, {
    headers: { 'Content-Type': 'application/json' },
    timeout: GEMINI_TIMEOUT_MS,
  });
  const text = resp.data?.candidates?.[0]?.content?.parts
    ?.filter(p => p.text)
    ?.map(p => p.text)
    ?.join('') || '';
  return { text, model: GEMINI_MODEL };
}

async function askClaude({ prompt, priorMessages, message, env, anthropic }) {
  const model = String(env.TROY_CHAT_MODEL || '').trim() || DEFAULT_CLAUDE_MODEL;
  const client = anthropic || anthropicClient(env.ANTHROPIC_API_KEY);
  const resp = await client.messages.create({
    model,
    max_tokens: CLAUDE_MAX_TOKENS,
    system: claudeSystemBlocks(prompt),
    messages: claudeMessages(priorMessages, message),
    ...claudeTuning(model, { temperature: CLAUDE_TEMPERATURE, effort: CLAUDE_EFFORT }),
  }, { timeout: CLAUDE_TIMEOUT_MS, maxRetries: 0 });
  if (resp?.stop_reason === 'refusal') {
    // Let the other provider answer rather than save a partial reply.
    console.warn(`[Troy Chat] ${model} declined: ${resp?.stop_details?.refusal_reason || 'no reason given'}`);
    return { text: '', model, usage: resp?.usage || null };
  }
  if (resp?.stop_reason === 'max_tokens') {
    console.warn(`[Troy Chat] ${model} reply hit the ${CLAUDE_MAX_TOKENS}-token cap`);
  }
  const text = (resp?.content || [])
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('');
  return { text, model, usage: resp?.usage || null };
}

/**
 * Get Troy's reply.
 * @param {object} args
 * @param {string} args.userId - used for the canary list
 * @param {Array<{role: string, content: string}>} args.priorMessages - oldest first
 * @param {string} args.message - the new user message
 * @param {{persona: string, stack: string, knowledge: string, community: string}} args.prompt
 * @param {object} [args.env] - defaults to process.env
 * @param {object} [args.deps] - { http, anthropic } for tests
 * @returns {Promise<{text: string, provider: string|null, model: string|null, fellBack: boolean}>}
 */
async function generateTroyReply({ userId, priorMessages = [], message, prompt, env = process.env, deps = {} }) {
  const order = providerOrder({ userId, env });
  if (order.length === 0) throw new Error('Troy chat has no AI provider configured');

  const http = deps.http || axios;
  let lastError = null;
  let fellBack = false;

  for (const provider of order) {
    try {
      const result = provider === 'claude'
        ? await askClaude({ prompt, priorMessages, message, env, anthropic: deps.anthropic })
        : await askGemini({ prompt, priorMessages, message, env, http });
      if (result.text && result.text.trim()) {
        if (result.usage) {
          const u = result.usage;
          console.log(`[Troy Chat] ${result.model} tokens in ${u.input_tokens || 0}, cache read ${u.cache_read_input_tokens || 0}, cache write ${u.cache_creation_input_tokens || 0}, out ${u.output_tokens || 0}`);
        }
        return { text: result.text, provider, model: result.model, fellBack };
      }
      console.warn(`[Troy Chat] ${provider} returned an empty reply`);
    } catch (err) {
      lastError = err;
      console.error(`[Troy Chat] ${provider} error: ${err.status ? `${err.status} ` : ''}${err.message}`);
    }
    fellBack = true;
  }

  if (lastError) throw lastError;
  return { text: '', provider: null, model: null, fellBack };
}

module.exports = {
  generateTroyReply,
  providerOrder,
  isConfigured,
  geminiSystemPrompt,
  claudeSystemBlocks,
  geminiContents,
  claudeMessages,
  GEMINI_MODEL,
  DEFAULT_CLAUDE_MODEL,
  CLAUDE_MAX_TOKENS,
  CLAUDE_EFFORT,
};
