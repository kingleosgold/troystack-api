const axios = require('axios');
const Anthropic = require('@anthropic-ai/sdk');

// ============================================
// MODEL CONSTANTS
// ============================================

const MODELS = {
  flash: 'gemini-2.5-flash',
  pro: 'gemini-2.5-pro',
  editorial: 'claude-sonnet-4-6',
  image: 'dall-e-3',
};

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

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
 * @param {object} options - { temperature, maxOutputTokens, responseMimeType, timeout }
 * @returns {string} Raw text response
 */
async function callGemini(model, systemPrompt, userMessage, options = {}) {
  if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY not configured');

  const { temperature = 0.3, maxOutputTokens = 4096, responseMimeType, timeout = 30000 } = options;

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
 * Call Claude via Anthropic SDK.
 * @param {string} systemPrompt - System prompt
 * @param {string} userMessage - User message
 * @param {object} options - { maxTokens, temperature, timeout }
 * @returns {string} Raw text response
 */
async function callClaude(systemPrompt, userMessage, options = {}) {
  const { maxTokens = 4096, temperature = 0.7 } = options;

  const client = getAnthropicClient();

  const message = await client.messages.create({
    model: MODELS.editorial,
    max_tokens: maxTokens,
    system: systemPrompt,
    messages: [{ role: 'user', content: userMessage }],
    temperature,
  });

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
};
