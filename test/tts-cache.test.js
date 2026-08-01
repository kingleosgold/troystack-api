// Tests for the TTS audio cache (Phase A).
//   node --test test/
// Key-derivation tests are pure. The round-trip test talks to the REAL
// troy-voice-cache bucket (needs SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in
// .env) and cleans up after itself; it is skipped when env is absent so the
// suite still passes in a bare checkout.

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');

require('dotenv').config();
// hasEnv MUST be computed before the dummy defaults below — it gates the
// real-bucket round-trip test, which must skip when only dummies are present.
const hasEnv = !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
// Env guard (same pattern as sanitizer.test.js): the require below transitively
// loads src/lib/supabase.js, whose createClient throws in a clean checkout
// with no env. Key-derivation tests are pure — dummies keep the load safe.
process.env.SUPABASE_URL ||= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-dummy-service-role-key';

const { buildCacheKey, get, put } = require('../src/services/tts-cache');

const baseParts = {
  sanitizedText: 'Your total gain is one hundred twenty-six thousand, one hundred sixty-six dollars and twenty-three cents.',
  version: 'v1',
  provider: 'grok',
  voice: 'leo',
  model: 'grok-tts',
  format: 'mp3-24000-128000',
};

test('identical text + config → identical key', () => {
  assert.strictEqual(buildCacheKey({ ...baseParts }), buildCacheKey({ ...baseParts }));
});

test('key shape is {version}/{provider}/{voice}/{model}-{format}/{sha256}.mp3', () => {
  const key = buildCacheKey(baseParts);
  const hash = crypto.createHash('sha256').update(baseParts.sanitizedText, 'utf8').digest('hex');
  assert.strictEqual(key, `v1/grok/leo/grok-tts-mp3-24000-128000/${hash}.mp3`);
});

test('changed text → different key', () => {
  const other = buildCacheKey({ ...baseParts, sanitizedText: baseParts.sanitizedText + ' Keep stacking.' });
  assert.notStrictEqual(other, buildCacheKey(baseParts));
});

test('changed SANITIZER_VERSION → different key', () => {
  assert.notStrictEqual(buildCacheKey({ ...baseParts, version: 'v2' }), buildCacheKey(baseParts));
});

test('changed provider parts → different key', () => {
  const key = buildCacheKey(baseParts);
  assert.notStrictEqual(buildCacheKey({ ...baseParts, provider: 'elevenlabs' }), key);
  assert.notStrictEqual(buildCacheKey({ ...baseParts, voice: 'ara' }), key);
  assert.notStrictEqual(buildCacheKey({ ...baseParts, model: 'grok-tts-2' }), key);
  assert.notStrictEqual(buildCacheKey({ ...baseParts, format: 'mp3-44100-192000' }), key);
});

test('provider cacheKeyParts feed distinct keys per provider', () => {
  const grok = require('../src/services/voice-providers/grok');
  const eleven = require('../src/services/voice-providers/elevenlabs');
  const a = buildCacheKey({ sanitizedText: 'x', version: 'v1', ...grok.cacheKeyParts() });
  const b = buildCacheKey({ sanitizedText: 'x', version: 'v1', ...eleven.cacheKeyParts() });
  assert.notStrictEqual(a, b);
});

test('get/put round-trip against the real bucket', { skip: !hasEnv && 'SUPABASE env not configured' }, async () => {
  const supabase = require('../src/lib/supabase');
  // Distinct test prefix so the round-trip object can never collide with a
  // real cache entry; removed in finally.
  const key = buildCacheKey({
    ...baseParts,
    version: 'test',
    sanitizedText: `round-trip ${process.pid}`,
  });
  const payload = Buffer.concat([Buffer.from('ID3'), crypto.randomBytes(1024)]);
  try {
    const missing = await get(key);
    assert.strictEqual(missing, null, 'expected a miss before put');
    assert.strictEqual(await put(key, payload), true, 'put should succeed');
    const roundTripped = await get(key);
    assert.ok(roundTripped, 'expected a hit after put');
    assert.ok(payload.equals(roundTripped), 'bytes must round-trip unchanged');
  } finally {
    await supabase.storage.from('troy-voice-cache').remove([key]);
  }
});
