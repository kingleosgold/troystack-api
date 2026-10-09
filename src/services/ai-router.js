const axios = require('axios');
const Anthropic = require('@anthropic-ai/sdk');

// ============================================
// MODEL CONSTANTS
// ============================================

// editorial writes the Stack Signal articles and the daily brief the podcast
// reads. CLAUDE_EDITORIAL_MODEL overrides it, so going back to
// claude-sonnet-4-6 is a Railway variable, not a deploy.
const MODELS = {
  flash: 'gemini-2.5-flash',
  pro: 'gemini-2.5-pro',
  editorial: (process.env.CLAUDE_EDITORIAL_MODEL || '').trim() || 'claude-sonnet-5-5',
  image: 'dall-e-3',
};

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// Claude 5.x models return a 400 on a non-default temperature, and they think
// before answering by default, so they get an effort level instead. Older
// models such as claude-sonnet-4-6 keep their temperature and get no effort,
// the same request shape they got before.
function isClaude5(model) {
  return /^claude-(sonnet|opus|haiku|fable|mythos)-5/.test(String(model || '').toLowerCase());
}

function claudeTuning(model, { temperature, effort } = {}) {
  if (isClaude5(model)) return effort ? { output_config: { effort } } : {};
  return temperature === undefined ? {} : { temperature };
}

// Lazy-init Anthropic client
let anthropicClient = null;
function getAnthropicClient() {
  if (!anthropicClient) {
    if (!ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not configured');
    anthropicClient = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
  }
  return anthropicClient;
}

// ============================================
// GEMINI
// ============================================

/**
 * Call Gemini REST API.
 * @param {string} model - Model name (e.g. 'gemini-2.5-flash')
 * @param {string} systemPrompt - System instruction text
 * @param {string} userMessage - User message text
 * @param {object} options - { temperature, maxOutputTokens, responseMimeType, timeout, thinking }
 *   thinking: false turns Gemini 2.5 Flash's thinking off. Leave it unset for
 *   prose; set it false for scoring, extraction and other short structured jobs.
 * @returns {string} Raw text response
 */
async function callGemini(model, systemPrompt, userMessage, options = {}) {
  if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY not configured');

  const { temperature = 0.3, maxOutputTokens = 4096, responseMimeType, timeout = 30000, thinking } = options;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;

  const body = {
    contents: [{ role: 'user', parts: [{ text: userMessage }] }],
    generationConfig: { temperature, maxOutputTokens },
  };

  if (systemPrompt) {
    body.system_instruction = { parts: [{ text: systemPrompt }] };
  }

  if (responseMimeType) {
    body.generationConfig.responseMimeType = responseMimeType;
  }

  // Flash thinks by default and bills that thinking as output tokens. The
  // thinking also draws on the output limit, so on a short maxOutputTokens it
  // can leave little or nothing for the answer itself.
  if (thinking === false) {
    body.generationConfig.thinkingConfig = { thinkingBudget: 0 };
  }

  const resp = await axios.post(url, body, {
    headers: { 'Content-Type': 'application/json' },
    timeout,
  });

  const text = resp.data?.candidates?.[0]?.content?.parts
    ?.filter(p => p.text)
    ?.map(p => p.text)
    ?.join('') || '';

  return text;
}

// ============================================
// CLAUDE (Anthropic)
// ============================================

/**
 * Request body for an editorial Claude call.
 * @param {string} model
 * @param {string} systemPrompt
 * @param {string} userMessage
 * @param {object} options - { maxTokens, temperature, effort }
 */
function editorialRequest(model, systemPrompt, userMessage, options = {}) {
  // On 5.x models max_tokens covers the thinking as well as the answer.
  const { maxTokens = 4096, temperature = 0.7, effort = 'medium' } = options;
  return {
    model,
    max_tokens: maxTokens,
    system: systemPrompt,
    messages: [{ role: 'user', content: userMessage }],
    ...claudeTuning(model, { temperature, effort }),
  };
}

/**
 * Call Claude via Anthropic SDK.
 * @param {string} systemPrompt - System prompt
 * @param {string} userMessage - User message
 * @param {object} options - { maxTokens, temperature, effort, client }
 * @returns {string} Raw text response
 */
async function callClaude(systemPrompt, userMessage, options = {}) {
  const client = options.client || getAnthropicClient();

  const message = await client.messages.create(
    editorialRequest(MODELS.editorial, systemPrompt, userMessage, options),
  );

  // A refusal can carry a partial answer. Callers treat an empty string as
  // a failed call, which beats publishing half an article.
  if (message.stop_reason === 'refusal') {
    console.warn(`[Claude] ${MODELS.editorial} declined: ${message.stop_details?.refusal_reason || 'no reason given'}`);
    return '';
  }
  if (message.stop_reason === 'max_tokens') {
    console.warn(`[Claude] ${MODELS.editorial} hit the max_tokens cap`);
  }

  const text = message.content
    ?.filter(b => b.type === 'text')
    ?.map(b => b.text)
    ?.join('') || '';

  return text;
}

// ============================================
// DALL-E 3 (OpenAI)
// ============================================

/**
 * Generate an image via DALL-E 3 API.
 * @param {string} prompt - Image generation prompt
 * @param {object} options - { size, quality, timeout }
 * @returns {string} Image URL
 */
async function generateImage(prompt, options = {}) {
  if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY not configured');

  const { size = '1792x1024', quality = 'standard', timeout = 60000 } = options;

  const resp = await axios.post('https://api.openai.com/v1/images/generations', {
    model: MODELS.image,
    prompt,
    n: 1,
    size,
    quality,
  }, {
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
    },
    timeout,
  });

  const imageUrl = resp.data?.data?.[0]?.url;
  if (!imageUrl) throw new Error('DALL-E returned no image URL');

  return imageUrl;
}

module.exports = {
  MODELS,
  callGemini,
  callClaude,
  generateImage,
  isClaude5,
  claudeTuning,
  editorialRequest,
};
