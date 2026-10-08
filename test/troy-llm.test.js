// Tests for Troy chat model routing (src/services/troy-llm.js), the editorial
// model switch (src/services/ai-router.js) and the Stack Signal JSON parser.
// Injected fakes only, no network.
//   node --test

const test = require('node:test');
const assert = require('node:assert');

// Requiring stack-signal-processor.js loads src/lib/supabase.js, which throws
// with no env. Same harmless defaults sanitizer.test.js uses.
process.env.SUPABASE_URL ||= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-dummy-service-role-key';

const llm = require('../src/services/troy-llm');

const PROMPT = {
  persona: 'You are Troy Stack.\n\n',
  stack: "THE USER'S STACK:\nTotal Value: $100.00\n\n",
  knowledge: 'APP GUIDE (when users ask how to do things in the app):\n- Add holding\n\n',
  community: 'WHAT THE COMMUNITY IS DISCUSSING TODAY:\nSchiff on X',
};
const ENV_BOTH = { GEMINI_API_KEY: 'gemini-test', ANTHROPIC_API_KEY: 'anthropic-test' };
const USER = '2b7f3c1e-8d4a-4f6b-9c2d-1a5e7b9c0d3f';

function fakeHttp(responder) {
  const calls = [];
  return {
    calls,
    post: async (url, body, opts) => {
      calls.push({ url, body, opts });
      return responder(url, body, opts);
    },
  };
}

function fakeAnthropic(responder) {
  const calls = [];
  return {
    calls,
    messages: {
      create: async (params, opts) => {
        calls.push({ params, opts });
        return responder(params, opts);
      },
    },
  };
}

const geminiOk = text => ({ data: { candidates: [{ content: { parts: [{ text }] } }] } });
const claudeOk = text => ({ content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 12, output_tokens: 7 } });

// ---------- provider choice ----------

test('defaults to Gemini first with Claude as the fallback', () => {
  assert.deepStrictEqual(llm.providerOrder({ env: ENV_BOTH }), ['gemini', 'claude']);
  assert.deepStrictEqual(llm.providerOrder({ userId: USER, env: ENV_BOTH }), ['gemini', 'claude']);
});

test('TROY_CHAT_PROVIDER=claude puts Claude first for everyone', () => {
  assert.deepStrictEqual(llm.providerOrder({ env: { ...ENV_BOTH, TROY_CHAT_PROVIDER: ' Claude ' } }), ['claude', 'gemini']);
});

test('the canary list moves only the listed users to Claude', () => {
  const env = { ...ENV_BOTH, TROY_CHAT_CLAUDE_USER_IDS: ` ${USER.toUpperCase()} , someone-else ` };
  assert.deepStrictEqual(llm.providerOrder({ userId: USER, env }), ['claude', 'gemini']);
  assert.deepStrictEqual(llm.providerOrder({ userId: '00000000-0000-4000-8000-000000000000', env }), ['gemini', 'claude']);
  assert.deepStrictEqual(llm.providerOrder({ env }), ['gemini', 'claude']);
});

test('a provider without its key is skipped', () => {
  assert.deepStrictEqual(llm.providerOrder({ env: { GEMINI_API_KEY: 'g', TROY_CHAT_PROVIDER: 'claude' } }), ['gemini']);
  assert.deepStrictEqual(llm.providerOrder({ env: { ANTHROPIC_API_KEY: 'a' } }), ['claude']);
  assert.deepStrictEqual(llm.providerOrder({ env: {} }), []);
  assert.strictEqual(llm.isConfigured({}), false);
  assert.strictEqual(llm.isConfigured({ ANTHROPIC_API_KEY: 'a' }), true);
  assert.strictEqual(llm.isConfigured({ GEMINI_API_KEY: 'g' }), true);
});

// ---------- request shapes ----------

test('Gemini contents keep the old mapping', () => {
  const prior = [
    { role: 'user', content: 'Q1' },
    { role: 'assistant', content: 'A1' },
    { role: 'system', content: 'ignored' },
  ];
  assert.deepStrictEqual(llm.geminiContents(prior, 'Q2'), [
    { role: 'user', parts: [{ text: 'Q1' }] },
    { role: 'model', parts: [{ text: 'A1' }] },
    { role: 'user', parts: [{ text: 'Q2' }] },
  ]);
});

test('Claude messages alternate and open with the user', () => {
  const prior = [
    { role: 'assistant', content: 'cut off by the 10-message window' },
    { role: 'user', content: 'Q1' },
    { role: 'assistant', content: 'A1' },
    { role: 'assistant', content: '   ' },
    { role: 'system', content: 'ignored' },
    { role: 'user', content: 'Q2 that never got an answer' },
  ];
  assert.deepStrictEqual(llm.claudeMessages(prior, 'Q3'), [
    { role: 'user', content: 'Q1' },
    { role: 'assistant', content: 'A1' },
    { role: 'user', content: 'Q2 that never got an answer\n\nQ3' },
  ]);
  assert.deepStrictEqual(llm.claudeMessages([], 'Hi'), [{ role: 'user', content: 'Hi' }]);
});

test('Gemini gets the prompt in its original order', () => {
  assert.strictEqual(llm.geminiSystemPrompt(PROMPT), PROMPT.persona + PROMPT.stack + PROMPT.knowledge + PROMPT.community);
});

test('Claude caches the fixed sections and sends the live ones after', () => {
  const blocks = llm.claudeSystemBlocks(PROMPT);
  assert.strictEqual(blocks.length, 2);
  assert.strictEqual(blocks[0].text, (PROMPT.persona + PROMPT.knowledge).trimEnd());
  assert.deepStrictEqual(blocks[0].cache_control, { type: 'ephemeral' });
  assert.strictEqual(blocks[1].text, (PROMPT.stack + PROMPT.community).trim());
  assert.strictEqual(blocks[1].cache_control, undefined);

  const noLive = llm.claudeSystemBlocks({ ...PROMPT, stack: '', community: '' });
  assert.strictEqual(noLive.length, 1);
});

// ---------- generateTroyReply ----------

test('default path calls Gemini exactly as troy-chat.js did', async () => {
  const http = fakeHttp(() => geminiOk('Sounds like a sale.'));
  const anthropic = fakeAnthropic(() => { throw new Error('should not be called'); });
  const prior = [{ role: 'user', content: 'Q1' }, { role: 'assistant', content: 'A1' }];
  const out = await llm.generateTroyReply({ userId: USER, priorMessages: prior, message: 'Q2', prompt: PROMPT, env: ENV_BOTH, deps: { http, anthropic } });

  assert.deepStrictEqual(out, { text: 'Sounds like a sale.', provider: 'gemini', model: 'gemini-2.5-flash', fellBack: false });
  assert.strictEqual(anthropic.calls.length, 0);
  assert.strictEqual(http.calls.length, 1);
  const { url, body, opts } = http.calls[0];
  assert.ok(url.startsWith('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key='));
  assert.deepStrictEqual(body, {
    contents: llm.geminiContents(prior, 'Q2'),
    system_instruction: { parts: [{ text: llm.geminiSystemPrompt(PROMPT) }] },
    generationConfig: { temperature: 0.7, maxOutputTokens: 8192 },
  });
  assert.deepStrictEqual(opts, { headers: { 'Content-Type': 'application/json' }, timeout: 30000 });
});

test('Claude path sends Sonnet 5.5 with cached system blocks, low effort and no temperature', async () => {
  const http = fakeHttp(() => { throw new Error('should not be called'); });
  const anthropic = fakeAnthropic(() => claudeOk('Paper games, same as always.'));
  const prior = [{ role: 'user', content: 'Q1' }, { role: 'assistant', content: 'A1' }];
  const env = { ...ENV_BOTH, TROY_CHAT_PROVIDER: 'claude' };
  const out = await llm.generateTroyReply({ userId: USER, priorMessages: prior, message: 'Q2', prompt: PROMPT, env, deps: { http, anthropic } });

  assert.deepStrictEqual(out, { text: 'Paper games, same as always.', provider: 'claude', model: 'claude-sonnet-5-5', fellBack: false });
  assert.strictEqual(http.calls.length, 0);
  const { params, opts } = anthropic.calls[0];
  assert.deepStrictEqual(params, {
    model: 'claude-sonnet-5-5',
    max_tokens: 6000,
    system: llm.claudeSystemBlocks(PROMPT),
    messages: [
      { role: 'user', content: 'Q1' },
      { role: 'assistant', content: 'A1' },
      { role: 'user', content: 'Q2' },
    ],
    output_config: { effort: 'low' },
  });
  assert.ok(!('temperature' in params), 'Sonnet 5.5 rejects a non-default temperature');
  assert.deepStrictEqual(opts, { timeout: 30000, maxRetries: 0 });
});

test('TROY_CHAT_MODEL on an older model sends temperature and no effort', async () => {
  for (const model of ['claude-sonnet-4-6', 'claude-haiku-4-5-20251001']) {
    const anthropic = fakeAnthropic(() => claudeOk('ok'));
    const env = { ...ENV_BOTH, TROY_CHAT_PROVIDER: 'claude', TROY_CHAT_MODEL: model };
    const out = await llm.generateTroyReply({ userId: USER, message: 'Q', prompt: PROMPT, env, deps: { anthropic, http: fakeHttp(() => geminiOk('x')) } });
    const { params } = anthropic.calls[0];
    assert.strictEqual(params.model, model);
    assert.strictEqual(params.temperature, 0.7);
    assert.ok(!('output_config' in params));
    assert.strictEqual(out.model, model);
  }
});

test('a Claude refusal lets Gemini answer instead of saving a partial reply', async () => {
  const anthropic = fakeAnthropic(() => ({ content: [{ type: 'text', text: 'I can' }], stop_reason: 'refusal', stop_details: { refusal_reason: 'test' } }));
  const http = fakeHttp(() => geminiOk('Gemini answered.'));
  const env = { ...ENV_BOTH, TROY_CHAT_PROVIDER: 'claude' };
  const out = await llm.generateTroyReply({ userId: USER, message: 'Q', prompt: PROMPT, env, deps: { anthropic, http } });
  assert.deepStrictEqual(out, { text: 'Gemini answered.', provider: 'gemini', model: 'gemini-2.5-flash', fellBack: true });
});

test('thinking blocks are left out of the reply text', async () => {
  const anthropic = fakeAnthropic(() => ({
    content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: 'Stack on.' }],
    stop_reason: 'end_turn',
  }));
  const env = { ...ENV_BOTH, TROY_CHAT_PROVIDER: 'claude' };
  const out = await llm.generateTroyReply({ userId: USER, message: 'Q', prompt: PROMPT, env, deps: { anthropic, http: fakeHttp(() => geminiOk('x')) } });
  assert.strictEqual(out.text, 'Stack on.');
});

test('a Claude error falls back to Gemini', async () => {
  const anthropic = fakeAnthropic(() => { const e = new Error('Overloaded'); e.status = 529; throw e; });
  const http = fakeHttp(() => geminiOk('Gemini answered.'));
  const env = { ...ENV_BOTH, TROY_CHAT_PROVIDER: 'claude' };
  const out = await llm.generateTroyReply({ userId: USER, message: 'Q', prompt: PROMPT, env, deps: { anthropic, http } });
  assert.deepStrictEqual(out, { text: 'Gemini answered.', provider: 'gemini', model: 'gemini-2.5-flash', fellBack: true });
});

test('an empty Claude reply falls back to Gemini', async () => {
  const anthropic = fakeAnthropic(() => ({ content: [], stop_reason: 'end_turn' }));
  const http = fakeHttp(() => geminiOk('Gemini answered.'));
  const env = { ...ENV_BOTH, TROY_CHAT_CLAUDE_USER_IDS: USER };
  const out = await llm.generateTroyReply({ userId: USER, message: 'Q', prompt: PROMPT, env, deps: { anthropic, http } });
  assert.strictEqual(out.provider, 'gemini');
  assert.strictEqual(out.fellBack, true);
});

test('a Gemini error on the default path falls back to Claude', async () => {
  const http = fakeHttp(() => { const e = new Error('Request failed with status code 400'); e.status = 400; throw e; });
  const anthropic = fakeAnthropic(() => claudeOk('Claude answered.'));
  const out = await llm.generateTroyReply({ userId: USER, message: 'Q', prompt: PROMPT, env: ENV_BOTH, deps: { anthropic, http } });
  assert.deepStrictEqual(out, { text: 'Claude answered.', provider: 'claude', model: 'claude-sonnet-5-5', fellBack: true });
});

test('both failing rejects with the last error', async () => {
  const http = fakeHttp(() => { throw new Error('gemini down'); });
  const anthropic = fakeAnthropic(() => { throw new Error('claude down'); });
  await assert.rejects(
    llm.generateTroyReply({ userId: USER, message: 'Q', prompt: PROMPT, env: ENV_BOTH, deps: { anthropic, http } }),
    /claude down/,
  );
});

test('both empty returns an empty reply for the route to handle', async () => {
  const http = fakeHttp(() => geminiOk(''));
  const anthropic = fakeAnthropic(() => claudeOk('   '));
  const out = await llm.generateTroyReply({ userId: USER, message: 'Q', prompt: PROMPT, env: ENV_BOTH, deps: { anthropic, http } });
  assert.deepStrictEqual(out, { text: '', provider: null, model: null, fellBack: true });
});

test('no configured provider rejects', async () => {
  await assert.rejects(
    llm.generateTroyReply({ userId: USER, message: 'Q', prompt: PROMPT, env: {}, deps: {} }),
    /no AI provider configured/,
  );
});

// ---------- editorial model ----------

function loadRouterWith(value) {
  const saved = process.env.CLAUDE_EDITORIAL_MODEL;
  if (value === undefined) delete process.env.CLAUDE_EDITORIAL_MODEL;
  else process.env.CLAUDE_EDITORIAL_MODEL = value;
  const id = require.resolve('../src/services/ai-router');
  delete require.cache[id];
  try {
    return require('../src/services/ai-router');
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_EDITORIAL_MODEL;
    else process.env.CLAUDE_EDITORIAL_MODEL = saved;
    delete require.cache[id];
  }
}

test('editorial runs on Sonnet 5.5 unless CLAUDE_EDITORIAL_MODEL says otherwise', () => {
  assert.strictEqual(loadRouterWith(undefined).MODELS.editorial, 'claude-sonnet-5-5');
  assert.strictEqual(loadRouterWith('  ').MODELS.editorial, 'claude-sonnet-5-5');
  assert.strictEqual(loadRouterWith('claude-sonnet-4-6').MODELS.editorial, 'claude-sonnet-4-6');
});

test('only 5.x models drop temperature and take an effort level', () => {
  const router = require('../src/services/ai-router');
  for (const m of ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-fable-5-1', 'claude-sonnet-5']) {
    assert.strictEqual(router.isClaude5(m), true, m);
    assert.deepStrictEqual(router.claudeTuning(m, { temperature: 0.7, effort: 'medium' }), { output_config: { effort: 'medium' } });
  }
  for (const m of ['claude-sonnet-4-6', 'claude-haiku-4-5-20251001', 'claude-opus-4-5', '', undefined]) {
    assert.strictEqual(router.isClaude5(m), false, String(m));
    assert.deepStrictEqual(router.claudeTuning(m, { temperature: 0.7, effort: 'medium' }), { temperature: 0.7 });
  }
});

test('editorial request on Sonnet 5.5 has no temperature, on 4.6 it matches the old request', () => {
  const { editorialRequest } = require('../src/services/ai-router');
  assert.deepStrictEqual(editorialRequest('claude-sonnet-5-5', 'SYS', 'USER', { maxTokens: 16000 }), {
    model: 'claude-sonnet-5-5',
    max_tokens: 16000,
    system: 'SYS',
    messages: [{ role: 'user', content: 'USER' }],
    output_config: { effort: 'medium' },
  });
  // Same shape callClaude sent before this change, so a rollback to 4.6 works.
  assert.deepStrictEqual(editorialRequest('claude-sonnet-4-6', 'SYS', 'USER', { maxTokens: 2048 }), {
    model: 'claude-sonnet-4-6',
    max_tokens: 2048,
    system: 'SYS',
    messages: [{ role: 'user', content: 'USER' }],
    temperature: 0.7,
  });
});

test('callClaude returns the text and drops a refused partial answer', async () => {
  const router = require('../src/services/ai-router');
  const ok = fakeAnthropic(() => ({ content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: 'Article body.' }], stop_reason: 'end_turn' }));
  assert.strictEqual(await router.callClaude('SYS', 'USER', { maxTokens: 16000, client: ok }), 'Article body.');
  assert.deepStrictEqual(ok.calls[0].params, router.editorialRequest(router.MODELS.editorial, 'SYS', 'USER', { maxTokens: 16000 }));

  const refused = fakeAnthropic(() => ({ content: [{ type: 'text', text: 'Half an art' }], stop_reason: 'refusal' }));
  assert.strictEqual(await router.callClaude('SYS', 'USER', { client: refused }), '');
});

// ---------- Stack Signal JSON ----------

test('parseJsonObject reads the daily Stack Signal reply', () => {
  const { parseJsonObject } = require('../src/services/stack-signal-processor');
  const obj = { title: 'The Stack Signal', commentary: 'Para one.\n\nPara two.', one_liner: 'Gold holds.' };
  assert.deepStrictEqual(parseJsonObject(JSON.stringify(obj)), obj);
  assert.deepStrictEqual(parseJsonObject('```json\n' + JSON.stringify(obj) + '\n```'), obj);
  assert.deepStrictEqual(parseJsonObject("Here's today's brief.\n" + JSON.stringify(obj) + '\nHope that helps.'), obj);
  assert.throws(() => parseJsonObject('no json here'));
  assert.throws(() => parseJsonObject('{ "title": "cut off'));
});
