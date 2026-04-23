// Grok (xAI) STT adapter — wired against the real documented endpoint.
//
// Docs: https://docs.x.ai/docs/guides/voice (retrieved 2026-04-22)
//   POST https://api.x.ai/v1/stt
//   Authorization: Bearer $XAI_API_KEY
//   Body: multipart/form-data with `file` field
//   Response: { text }
//   25 languages supported (auto-detected)
//
// Notes from docs that DIFFER from the VOICE-1 guess:
//   - No `model` field is documented on the multipart request — the example
//     is literally `curl -F file=@recording.mp3`. We accept options.model for
//     forward-compat but only attach it when the caller explicitly passes
//     one, so we don't send an unsupported field by default.
//   - No `language` field in the public example; language is auto-detected.
//   - Response shape is only `{ text }` — no `segments`/`duration` in the
//     documented example. Caller still supplies `durationSec` (same contract
//     as the OpenAI adapter) so cost tracking is symmetric.
//
// Pricing: $0.10 per hour of audio (batch mode). Rounded up to the nearest
// cent per call.

const axios = require('axios');
const FormData = require('form-data');

const ENDPOINT = 'https://api.x.ai/v1/stt';
const MODEL_LABEL = 'grok-stt'; // for return metadata only — not sent in request

async function stt({ audioBuffer, mimeType, filename, options = {} }) {
  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) throw new Error('XAI_API_KEY not configured');

  const formData = new FormData();
  formData.append('file', audioBuffer, {
    filename: filename || 'audio.m4a',
    contentType: mimeType || 'audio/m4a',
  });
  if (options.model) formData.append('model', options.model);
  if (options.language) formData.append('language', options.language);

  const response = await axios.post(ENDPOINT, formData, {
    headers: {
      ...formData.getHeaders(),
      'Authorization': `Bearer ${apiKey}`,
    },
    timeout: 30000,
  });

  const durationSec = typeof options.durationSec === 'number'
    ? options.durationSec
    : 0;

  return {
    text: response.data.text,
    provider: 'grok',
    model: options.model || MODEL_LABEL,
    durationSec,
    costCents: Math.ceil((durationSec / 3600) * 10),
  };
}

module.exports = { stt };
