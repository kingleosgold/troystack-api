// Tests for the one-time Gemini candidate probe. The HTTP post is faked, so
// nothing leaves the machine.
//   node --test

const test = require('node:test');
const assert = require('node:assert');

const probe = require('../src/services/gemini-probe');

const KEY = 'test-key-123';
const NOW = Date.parse('2026-11-03T12:00:00Z');

function answer(text, extra = {}) {
  return { data: { candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }], usageMetadata: { candidatesTokenCount: 5, thoughtsTokenCount: 0 }, ...extra } };
}

const GOOD = {
  ping: 'pong',
  oneliner: 'Silver keeps working for stackers.',
  score: '[{"index":1,"score":8}]',
  extract: '{"metal":"silver","amount_oz":1200000}',
  search: '```json\n{"gold_usd": 2700, "as_of": "2026-11-03"}\n```',
  chat: 'Adding a little gold balances a silver-heavy stack.',
  receipt: '{"dealer":"Sample Coin Dealer","purchaseDate":"2026-10-14","items":[{"description":"1 oz American Silver Eagle","quantity":10,"unitPrice":34.5,"metal":"silver","ozt":1},{"description":"1 oz Gold Maple Leaf","quantity":1,"unitPrice":2712,"metal":"gold","ozt":1}]}',
};

function fakePost(answers) {
  const calls = [];
  const names = probe.checks('gemini-3.5-flash-lite').map(c => c.name);
  const post = async (url, body) => {
    const name = names[calls.length];
    calls.push({ url, body, name });
    const a = answers[name];
    if (a instanceof Error) throw a;
    return answer(a);
  };
  return { post, calls };
}

test('the probe is off without a key, when turned off, or when the candidate is already live', () => {
  assert.strictEqual(probe.probeEnabled({}), false);
  assert.strictEqual(probe.probeEnabled({ GEMINI_API_KEY: KEY, GEMINI_PROBE: ' OFF ' }), false);
  assert.strictEqual(probe.probeEnabled({ GEMINI_API_KEY: KEY, GEMINI_FLASH_MODEL: 'gemini-3.5-flash-lite' }, NOW), false);
  assert.strictEqual(probe.probeEnabled({ GEMINI_API_KEY: KEY }, Date.parse('2026-11-03T12:00:00Z')), true);
});

test('the candidate defaults to gemini-3.5-flash-lite and refuses a bad id', () => {
  assert.strictEqual(probe.candidateModel({}), 'gemini-3.5-flash-lite');
  assert.strictEqual(probe.candidateModel({ GEMINI_CANDIDATE_MODEL: 'gemini-3-flash' }), 'gemini-3-flash');
  assert.strictEqual(probe.candidateModel({ GEMINI_CANDIDATE_MODEL: 'gemini?key=x' }), 'gemini-3.5-flash-lite');
});

test('every check passes on good answers and each request goes to the candidate', async () => {
  const { post, calls } = fakePost(GOOD);
  const lines = [];
  const results = await probe.runCandidateProbe({ env: { GEMINI_API_KEY: KEY }, now: NOW, post, log: l => lines.push(l) });
  assert.deepStrictEqual(results.map(r => [r.name, r.ok]), [['ping', true], ['score', true], ['oneliner', true], ['extract', true], ['search', true], ['chat', true], ['receipt', true]]);
  for (const c of calls) assert.match(c.url, /models\/gemini-3\.5-flash-lite:generateContent/);
  assert.match(lines[lines.length - 1], /7 of 7 passed/);
});

test('requests carry the 3.x shapes: no temperature, minimal thinking where callers turn it off, grounding on search', async () => {
  const { post, calls } = fakePost(GOOD);
  await probe.runCandidateProbe({ env: { GEMINI_API_KEY: KEY }, now: NOW, post, log: () => {} });
  const by = Object.fromEntries(calls.map(c => [c.name, c.body]));
  for (const b of Object.values(by)) assert.strictEqual(b.generationConfig.temperature, undefined);
  assert.deepStrictEqual(by.score.generationConfig.thinkingConfig, { thinkingLevel: 'minimal' });
  assert.strictEqual(by.score.generationConfig.maxOutputTokens, 4096);
  assert.strictEqual(by.score.generationConfig.responseMimeType, 'application/json');
  assert.deepStrictEqual(by.oneliner.generationConfig.thinkingConfig, { thinkingLevel: 'minimal' });
  assert.strictEqual(by.oneliner.generationConfig.maxOutputTokens, 100);
  assert.deepStrictEqual(by.extract.generationConfig.thinkingConfig, { thinkingLevel: 'minimal' });
  assert.strictEqual(by.extract.generationConfig.maxOutputTokens, 512);
  assert.strictEqual(by.chat.generationConfig.thinkingConfig, undefined);
  assert.strictEqual(by.chat.generationConfig.maxOutputTokens, 8192);
  assert.deepStrictEqual(by.chat.contents.map(c => c.role), ['user', 'model', 'user']);
  assert.deepStrictEqual(by.search.tools, [{ google_search: {} }]);
  assert.ok(by.receipt.contents[0].parts[1].inline_data.data.length > 1000);
});

test('a wrong receipt read, a non-JSON score and an HTTP error fail without logging the key', async () => {
  const err = Object.assign(new Error('Request failed with status code 404'), {
    config: { url: `https://x/models/m:generateContent?key=${KEY}` },
    response: { status: 404, data: { error: { message: 'models/gemini-3.5-flash-lite is not found' } } },
  });
  const { post } = fakePost({
    ...GOOD,
    score: 'sure, 8',
    chat: err,
    receipt: '{"items":[{"description":"tube","quantity":1,"unitPrice":3,"metal":"silver"},{"description":"eagle","quantity":10,"unitPrice":34.5,"metal":"silver"},{"description":"maple","quantity":1,"unitPrice":2712,"metal":"gold"}]}',
  });
  const lines = [];
  const results = await probe.runCandidateProbe({ env: { GEMINI_API_KEY: KEY }, now: NOW, post, log: l => lines.push(l) });
  const ok = Object.fromEntries(results.map(r => [r.name, r.ok]));
  assert.deepStrictEqual(ok, { ping: true, score: false, oneliner: true, extract: true, search: true, chat: false, receipt: false });
  assert.ok(lines.some(l => /chat FAIL .*HTTP 404 models\/gemini-3\.5-flash-lite is not found/.test(l)));
  assert.ok(lines.some(l => /receipt FAIL .*read 3 items/.test(l)));
  for (const l of lines) assert.ok(!l.includes(KEY));
  assert.match(lines[lines.length - 1], /4 of 7 passed/);
});

test('search fails on words around the JSON, as geminiSearch would', async () => {
  const { post } = fakePost({ ...GOOD, search: 'Based on current data: {"gold_usd": 2700}' });
  const results = await probe.runCandidateProbe({ env: { GEMINI_API_KEY: KEY }, now: NOW, post, log: () => {} });
  assert.strictEqual(results.find(r => r.name === 'search').ok, false);
});

test('a receipt answer with a null item fails as a judge problem, not a request failure', async () => {
  const { post } = fakePost({ ...GOOD, receipt: '{"items":[null,{"metal":"gold","unitPrice":2712}]}' });
  const lines = [];
  const results = await probe.runCandidateProbe({ env: { GEMINI_API_KEY: KEY }, now: NOW, post, log: l => lines.push(l) });
  assert.strictEqual(results.find(r => r.name === 'receipt').ok, false);
  assert.ok(lines.some(l => /receipt FAIL .*finish=STOP/.test(l)));
});

test('the probe stops on its own after 12/15/2026', () => {
  assert.strictEqual(probe.probeEnabled({ GEMINI_API_KEY: KEY }, Date.parse('2026-12-15T00:00:00Z')), false);
  assert.strictEqual(probe.probeEnabled({ GEMINI_API_KEY: KEY }, Date.parse('2026-11-03T12:00:00Z')), true);
});

test('the probe does nothing when it is off', async () => {
  let posted = 0;
  const results = await probe.runCandidateProbe({ env: {}, post: async () => { posted++; }, log: () => {} });
  assert.deepStrictEqual(results, []);
  assert.strictEqual(posted, 0);
  assert.strictEqual(probe.scheduleCandidateProbe({ env: {} }), null);
});

test('parseJson reads fenced JSON and JSON with words around it', () => {
  assert.deepStrictEqual(probe.parseJson('```json\n[1]\n```'), [1]);
  assert.deepStrictEqual(probe.parseJson('Here you go: {"a":1} done'), { a: 1 });
  assert.strictEqual(probe.parseJson('no json'), undefined);
  assert.strictEqual(probe.parseStrict('Here you go: {"a":1}'), undefined);
  assert.deepStrictEqual(probe.parseStrict('```json\n{"a":1}\n```'), { a: 1 });
});
