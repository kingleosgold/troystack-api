// Grok (xAI) TTS adapter — wired against the real documented endpoint.
//
// Docs: https://docs.x.ai/docs/guides/voice (retrieved 2026-04-22)
//   POST https://api.x.ai/v1/tts
//   Authorization: Bearer $XAI_API_KEY
//   Content-Type: application/json
//   Body: { text, voice_id, language, output_format? }
//   Response: audio/mpeg stream (MP3)
//   Voices: eve, ara, rex, sal, leo
//
// output_format (undocumented in the public REST docs but confirmed by the
// openclaw xAI-TTS integration, PR #50544, and xAI's broader snake_case
// field convention). Omitting it returns xAI's default which is ~1KB/char of
// audio — roughly 320kbps MP3. Setting codec=mp3, sample_rate=24000,
// bit_rate=128000 brings a typical 2000-char Troy response from ~2.25 MB to
// ~350-500 KB, which is what mobile cellular needs.
//
// Streaming contract: responseType: 'stream' is REQUIRED. Without it axios
// buffers the whole body and tries to decode it — that corrupts binary MP3
// bytes and the route pipes a dead stream to the client (silent playback).
// maxBodyLength / maxContentLength are set to Infinity because axios has
// historically capped buffered responses at 10MB even in stream mode on some
// code paths; belt + suspenders.
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

  const requestBody = {
    text,
    voice_id: resolvedVoice,
    language: options.language || 'en',
    output_format: options.outputFormat || {
      codec: 'mp3',
      sample_rate: 24000,
      bit_rate: 128000,
    },
  };

  let response;
  try {
    response = await axios.post(ENDPOINT, requestBody, {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Accept': 'audio/mpeg',
      },
      responseType: 'stream',
      timeout: 30000,
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
    });
  } catch (err) {
    // axios throws on non-2xx when validateStatus isn't overridden. For stream
    // responses the body is on err.response.data; consume it so we surface a
    // readable error instead of masking it with a generic stack trace.
    if (err.response) {
      const status = err.response.status;
      let body = '';
      try {
        const chunks = [];
        for await (const chunk of err.response.data) chunks.push(chunk);
        body = Buffer.concat(chunks).toString('utf-8');
      } catch (_) { /* stream already consumed or not readable */ }
      console.error(`[Grok TTS] ${status}: ${body.slice(0, 500)}`);
      const wrapped = new Error(`xAI TTS error ${status}: ${body}`);
      wrapped.status = status;
      wrapped.body = body;
      throw wrapped;
    }
    console.error('[Grok TTS] request failed:', err.message);
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
