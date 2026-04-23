// Grok (xAI) TTS adapter — wired against the real documented endpoint.
//
// Docs: https://docs.x.ai/docs/guides/voice (retrieved 2026-04-22)
//   POST https://api.x.ai/v1/tts
//   Authorization: Bearer $XAI_API_KEY
//   Content-Type: application/json
//   Body: { text, voice_id, language }
//   Response: audio/mpeg stream (MP3)
//   Voices: eve, ara, rex, sal, leo
//
// Notes from docs that DIFFER from the VOICE-1 guess:
//   - Field names are `text` + `voice_id` (not `input` + `voice`).
//   - No `model` field is documented in the REST body. WebSocket realtime API
//     has its own shape at wss://api.x.ai/v1/realtime — out of scope here.
//   - No `format` / `response_format` field documented; MP3 is the default.
//   - Max 15,000 chars per REST request (per VOICE-2 spec); longer text is
//     expected to go through the WebSocket streaming API — future work.
//
// Pricing: $4.20 per 1M characters. Rounded up to the nearest cent per call.

const axios = require('axios');

const ENDPOINT = 'https://api.x.ai/v1/tts';
const MODEL_LABEL = 'grok-tts'; // for return metadata only — not sent in request
const DEFAULT_VOICE = 'leo'; // Troy's voice per VOICE-1 spec (British accent)
const MAX_CHARS = 15000;

async function tts({ text, voiceId, options = {} }) {
  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) throw new Error('XAI_API_KEY not configured');

  const charCount = text.length;
  if (charCount > MAX_CHARS) {
    throw new Error(
      `xAI TTS REST endpoint max is ${MAX_CHARS} chars (got ${charCount}). ` +
      'For longer text, use the WebSocket realtime API at wss://api.x.ai/v1/realtime.'
    );
  }

  const resolvedVoice = voiceId || process.env.XAI_TTS_VOICE_ID || DEFAULT_VOICE;

  const response = await axios({
    method: 'POST',
    url: ENDPOINT,
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'Accept': 'audio/mpeg',
    },
    data: {
      text,
      voice_id: resolvedVoice,
      language: options.language || 'en',
    },
    responseType: 'stream',
    validateStatus: () => true,
  });

  if (response.status !== 200) {
    const chunks = [];
    for await (const chunk of response.data) chunks.push(chunk);
    const errorBody = Buffer.concat(chunks).toString('utf-8');
    const err = new Error(`xAI TTS error ${response.status}: ${errorBody}`);
    err.status = response.status;
    err.body = errorBody;
    throw err;
  }

  return {
    audioStream: response.data,
    mimeType: 'audio/mpeg',
    provider: 'grok',
    model: options.model || MODEL_LABEL,
    charCount,
    costCents: Math.ceil((charCount / 1_000_000) * 420),
  };
}

module.exports = { tts };
