// Tests for the shared Gemini model setting ahead of Google's 12/1/2026
// retirement of gemini-2.5-flash and gemini-2.5-pro. axios is faked, so
// nothing leaves the machine.
//   node --test

const test = require('node:test');
const assert = require('node:assert');

const gm = require('../src/services/gemini-models');

test('defaults stay on 2.5 until a successor passes a live test', () => {
  assert.strictEqual(gm.flashModel({}), 'gemini-2.5-flash');
  assert.strictEqual(gm.proModel({}), 'gemini-2.5-pro');
});

test('GEMINI_FLASH_MODEL and GEMINI_PRO_MODEL pick the model', () => {
  assert.strictEqual(gm.flashModel({ GEMINI_FLASH_MODEL: ' gemini-3.5-flash-lite ' }), 'gemini-3.5-flash-lite');
  assert.strictEqual(gm.proModel({ GEMINI_PRO_MODEL: 'Gemini-3.8-Flash' }), 'gemini-3.8-flash');
});

test('a value that is not a model id falls back to the default', () => {
  for (const bad of ['', '   ', 'gemini-3/../x', 'gemini?key=1', 'a b', 'gemini-3-' + 'x'.repeat(49), '-gemini', 'gemini-flash-latest', 'claude-sonnet-5-5', 'gemini-3']) {
    assert.strictEqual(gm.flashModel({ GEMINI_FLASH_MODEL: bad }), 'gemini-2.5-flash', bad);
  }
});

test('thinking off follows the model generation', () => {
  assert.deepStrictEqual(gm.thinkingOffConfig('gemini-2.5-flash'), { thinkingBudget: 0 });
  assert.deepStrictEqual(gm.thinkingOffConfig('gemini-2.0-flash'), { thinkingBudget: 0 });
  assert.deepStrictEqual(gm.thinkingOffConfig('gemini-3.5-flash-lite'), { thinkingLevel: 'minimal' });
  assert.deepStrictEqual(gm.thinkingOffConfig('gemini-3-flash-preview'), { thinkingLevel: 'minimal' });
  assert.deepStrictEqual(gm.thinkingOffConfig('gemini-10.0-flash'), { thinkingLevel: 'minimal' });
  assert.deepStrictEqual(gm.thinkingOffConfig('gemini-3-pro-preview'), { thinkingLevel: 'low' });
  assert.deepStrictEqual(gm.thinkingOffConfig('gemini-3.8-pro'), { thinkingLevel: 'low' });
  assert.deepStrictEqual(gm.thinkingOffConfig('gemini-3.5-flash-lite-preview'), { thinkingLevel: 'minimal' });
  assert.strictEqual(gm.thinkingOffConfig('gemini-flash-latest'), null);
  assert.strictEqual(gm.thinkingOffConfig(''), null);
});

test('responseText joins every text part and skips thought summaries', () => {
  const data = { candidates: [{ content: { parts: [
    { text: 'thinking out loud', thought: true },
    { text: '{"a":' },
    { thoughtSignature: 'abc' },
    { text: '1}' },
  ] } }] };
  assert.strictEqual(gm.responseText(data), '{"a":1}');
  assert.strictEqual(gm.responseText({}), '');
  assert.strictEqual(gm.responseText(null), '');
});

test('callGemini sends thinkingLevel to a 3.x model and thinkingBudget to 2.5', async () => {
  process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'gemini-test-key';
  const axios = require('axios');
  const { callGemini } = require('../src/services/ai-router');
  const real = axios.post;
  const calls = [];
  axios.post = async (url, body) => {
    calls.push({ url, body });
    return { data: { candidates: [{ content: { parts: [{ text: 'ok' }] } }] } };
  };
  try {
    assert.strictEqual(await callGemini('gemini-3.5-flash-lite', 'S', 'U', { thinking: false }), 'ok');
    assert.strictEqual(await callGemini('gemini-2.5-flash', 'S', 'U', { thinking: false }), 'ok');
    await callGemini('gemini-3.5-flash-lite', 'S', 'U', {});
  } finally {
    axios.post = real;
  }
  assert.match(calls[0].url, /\/models\/gemini-3\.5-flash-lite:generateContent\?key=/);
  assert.deepStrictEqual(calls[0].body.generationConfig.thinkingConfig, { thinkingLevel: 'minimal' });
  assert.deepStrictEqual(calls[1].body.generationConfig.thinkingConfig, { thinkingBudget: 0 });
  assert.strictEqual(calls[2].body.generationConfig.thinkingConfig, undefined);
});

test('no Gemini model id is written outside gemini-models.js', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const root = path.join(__dirname, '../src');
  const hits = [];
  const walk = dir => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (p.endsWith('.js') && !p.endsWith('gemini-models.js')) {
        fs.readFileSync(p, 'utf8').split('\n').forEach((line, i) => {
          if (/['"`]gemini-\d/.test(line) || /models\/gemini-\d/.test(line)) hits.push(`${p}:${i + 1}`);
        });
      }
    }
  };
  walk(root);
  assert.deepStrictEqual(hits, []);
});
