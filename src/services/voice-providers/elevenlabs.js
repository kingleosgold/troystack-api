// ElevenLabs TTS adapter — wraps the existing /v1/troy/speak ElevenLabs call
// into the canonical TTS interface documented in ./index.js.
//
// Behavior is byte-for-byte identical to the pre-abstraction call: same model
// (eleven_turbo_v2_5), same streaming audio/mpeg response, same auth header.
// Text sanitization (sanitizeTTSText) still runs in the route BEFORE this
// adapter is called — we do not duplicate it here.
//
// Pricing note: ElevenLabs bills per character against the subscription's
// character quota. We approximate $0.05 per 1,000 characters (Creator-tier
// effective rate — ~$22 / 500K). Keep this as a coarse estimate; the real
// per-plan rate lives in admin/finance/sources/elevenlabs.js, which reads
// the live subscription from the billing API.

const axios = require('axios');

const MODEL = 'eleven_turbo_v2_5';
const COST_PER_CHAR_CENTS = 0.005; // $0.05 / 1000 chars

async function tts({ text, voiceId, signal, options = {} }) {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  const resolvedVoiceId = voiceId || process.env.ELEVENLABS_VOICE_ID;

  if (!apiKey) throw new Error('ELEVENLABS_API_KEY not configured');
  if (!resolvedVoiceId) throw new Error('ELEVENLABS_VOICE_ID not configured');

  const charCount = text.length;

  // `signal` is optional — if undefined, axios treats it as "no abort". When
  // passed (from /v1/troy/speak's AbortController), client disconnect cancels
  // the in-flight HTTP request to ElevenLabs so we stop billing immediately.
  const response = await axios({
    method: 'POST',
    url: `https://api.elevenlabs.io/v1/text-to-speech/${resolvedVoiceId}`,
    headers: {
      'xi-api-key': apiKey,
      'Content-Type': 'application/json',
      'Accept': 'audio/mpeg',
    },
    data: {
      text,
      model_id: options.model || MODEL,
    },
    responseType: 'stream',
    validateStatus: () => true,
    signal,
  });

  if (response.status !== 200) {
    // Collect error body from stream for useful error message
    const chunks = [];
    for await (const chunk of response.data) chunks.push(chunk);
    const errorBody = Buffer.concat(chunks).toString('utf-8');
    const err = new Error(`ElevenLabs API error ${response.status}: ${errorBody}`);
    err.status = response.status;
    err.body = errorBody;
    throw err;
  }

  return {
    audioStream: response.data,
    mimeType: 'audio/mpeg',
    provider: 'elevenlabs',
    model: options.model || MODEL,
    charCount,
    costCents: charCount * COST_PER_CHAR_CENTS,
  };
}

// Cache identity for the TTS audio cache (src/services/tts-cache.js).
// MUST mirror exactly what tts() resolves and sends for a route-originated
// call (no voiceId/options overrides): if the voice/model resolution in
// tts() changes, change this too — otherwise the cache serves stale audio
// recorded under the old settings.
function cacheKeyParts() {
  return {
    provider: 'elevenlabs',
    voice: process.env.ELEVENLABS_VOICE_ID || 'unset',
    model: MODEL,
    format: 'mp3-default', // ElevenLabs default output; no format params sent
  };
}

module.exports = { tts, cacheKeyParts };
