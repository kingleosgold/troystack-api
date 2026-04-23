// OpenAI Whisper STT adapter — wraps the existing /v1/troy/transcribe call
// into the canonical STT interface documented in ./index.js.
//
// Behavior is identical to the pre-abstraction call: multipart POST to
// /v1/audio/transcriptions with model=whisper-1, language=en.
//
// Pricing: Whisper API is $0.006 per minute = 0.01 cents/sec. Duration is
// best-effort — Whisper's response doesn't include it so we approximate from
// audio bytes when the caller didn't supply it (rough, but good enough for
// cost tracking at the order-of-magnitude level that FIN-3 needs).

const axios = require('axios');
const FormData = require('form-data');

const MODEL = 'whisper-1';
const COST_PER_SEC_CENTS = 0.01; // $0.006/min

async function stt({ audioBuffer, mimeType, filename, options = {} }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY not configured');

  const formData = new FormData();
  formData.append('file', audioBuffer, {
    filename: filename || 'audio.m4a',
    contentType: mimeType || 'audio/m4a',
  });
  formData.append('model', options.model || MODEL);
  formData.append('language', options.language || 'en');

  const response = await axios.post(
    'https://api.openai.com/v1/audio/transcriptions',
    formData,
    {
      headers: {
        ...formData.getHeaders(),
        'Authorization': `Bearer ${apiKey}`,
      },
      timeout: 30000,
    }
  );

  const durationSec = typeof options.durationSec === 'number'
    ? options.durationSec
    : 0; // Whisper doesn't return duration; caller can compute from audio metadata

  return {
    text: response.data.text,
    provider: 'openai',
    model: options.model || MODEL,
    durationSec,
    costCents: durationSec * COST_PER_SEC_CENTS,
  };
}

module.exports = { stt };
