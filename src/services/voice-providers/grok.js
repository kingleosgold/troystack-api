// Grok (xAI) TTS adapter — wired against the real documented endpoint.
//
// Docs: https://docs.x.ai/developers/model-capabilities/audio/text-to-speech
//   POST https://api.x.ai/v1/tts
//   Authorization: Bearer $XAI_API_KEY
//   Content-Type: application/json
//   Body: { text, voice_id, language, output_format?,
//           optimize_streaming_latency?, text_normalization? }
//   Response: audio/mpeg raw bytes (described as "Unary & Server-Streamed")
//   Voices: eve, ara, rex, sal, leo
//
// Format params: now sent as the documented nested object
// `output_format: { codec, sample_rate, bit_rate }`. Earlier attempts:
// commit dac4b7a tried this shape (sourced from a third-party openclaw
// integration) and saw it silently ignored. Commit 4e4dad9 reverted to a
// flat top-level `format` / `sample_rate` / `bit_rate` shape, which
// production observation suggests was ALSO silently ignored (~1.1 KB per
// character of audio, consistent with xAI's default ~320 kbps MP3, not
// our requested 128 kbps). xAI's developer-docs page (cited above) now
// explicitly documents the nested shape — either xAI rolled out support
// after Apr 22 or our earlier attempt was off in some other way; sending
// the documented shape is correct now regardless.
//
// optimize_streaming_latency: 1 — documented as "reduced first-chunk size
// for lower time-to-first-audio, with minor quality tradeoff." Default 0.
// We are sending 1 because production end-to-end latency is dominated by
// xAI's first-byte time on the default setting (see tts-xai-recon.md §4).
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

async function tts({ text, voiceId, signal, options = {} }) {
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
    optimize_streaming_latency: 1,
    output_format: {
      codec: options.format || 'mp3',
      sample_rate: options.sampleRate || 24000,
      bit_rate: options.bitRate || 128000,
    },
  };

  let response;
  try {
    // `signal` is optional — undefined means "no abort". When passed from
    // /v1/troy/speak's AbortController, client disconnect cancels the
    // in-flight HTTP request to xAI so we stop billing immediately.
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
      signal,
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
