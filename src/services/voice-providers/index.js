// Voice provider factory (VOICE-1 scaffolding)
//
// Selects TTS and STT implementations at runtime via env vars so we can swap
// vendors without touching any route code. Pattern will be extracted to
// @mts/voice-kit for Jewel/Penny/Ace/Sage/Hank.
//
// Canonical TTS interface:
//   async tts({ text, voiceId, options }) => {
//     audioStream,    // Node.js Readable (audio/mpeg by default)
//     mimeType,       // 'audio/mpeg'
//     provider,       // 'elevenlabs' | 'grok'
//     model,          // e.g. 'eleven_turbo_v2_5'
//     charCount,      // integer — used for cost/quota
//     costCents,      // number — cost of this call
//   }
//
// Canonical STT interface:
//   async stt({ audioBuffer, mimeType, filename, options }) => {
//     text,           // transcribed string
//     provider,       // 'openai' | 'grok'
//     model,          // e.g. 'whisper-1'
//     durationSec,    // number — best-effort; 0 if unknown
//     costCents,      // number — cost of this call
//   }
//
// Each provider returns costCents on every call so future FIN-3 can wire
// per-call spend into api_usage_log without touching routes again.

const KNOWN_TTS = {
  elevenlabs: () => require('./elevenlabs'),
  grok: () => require('./grok'),
};

const KNOWN_STT = {
  openai: () => require('./openai-whisper'),
  grok: () => require('./grok-stt'),
};

function getTTSProvider() {
  const name = (process.env.VOICE_PROVIDER || 'elevenlabs').toLowerCase();
  const loader = KNOWN_TTS[name];
  if (!loader) {
    throw new Error(
      `Unknown VOICE_PROVIDER="${name}". Known: ${Object.keys(KNOWN_TTS).join(', ')}`
    );
  }
  return loader();
}

function getSTTProvider() {
  const name = (process.env.STT_PROVIDER || 'openai').toLowerCase();
  const loader = KNOWN_STT[name];
  if (!loader) {
    throw new Error(
      `Unknown STT_PROVIDER="${name}". Known: ${Object.keys(KNOWN_STT).join(', ')}`
    );
  }
  return loader();
}

module.exports = { getTTSProvider, getSTTProvider };
