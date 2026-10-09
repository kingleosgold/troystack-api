// Tests for the Gemini cost fix: callGemini's thinking switch and the
// scrapers no longer asking Gemini about the same skipped post every run.
// axios is faked, so nothing leaves the machine.
//   node --test

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const Module = require('node:module');

process.env.GEMINI_API_KEY = 'gemini-test-key';

// Fake Supabase for the scraper: remembers saved source URLs so the
// database dedup behaves like the real table.
const saved = new Set();
const fakeSupabase = {
  from(table) {
    const q = { table, filters: {} };
    const api = {
      select() { return api; },
      eq(col, val) { q.filters[col] = val; return api; },
      limit() {
        const hit = table === 'troy_intelligence' && saved.has(q.filters.source_url);
        return Promise.resolve({ data: hit ? [{ id: 1 }] : [], error: null });
      },
      insert(row) {
        if (table === 'troy_intelligence') saved.add(row.source_url);
        return Promise.resolve({ error: null });
      },
    };
    return api;
  },
};
const supabasePath = require.resolve(path.join(__dirname, '../src/lib/supabase'));
const stub = new Module(supabasePath, null);
stub.filename = supabasePath;
stub.loaded = true;
stub.exports = fakeSupabase;
require.cache[supabasePath] = stub;

const axios = require('axios');
const { callGemini, MODELS } = require('../src/services/ai-router');
const scraper = require('../src/services/intelligence-scraper');

function withFakePost(responder, fn) {
  const real = axios.post;
  const calls = [];
  axios.post = async (url, body, opts) => {
    calls.push({ url, body, opts });
    return responder(url, body, opts);
  };
  return Promise.resolve(fn(calls)).finally(() => { axios.post = real; });
}

const geminiText = text => ({ data: { candidates: [{ content: { parts: [{ text }] } }] } });

test('thinking: false turns Flash thinking off', async () => {
  await withFakePost(() => geminiText('[]'), async calls => {
    await callGemini(MODELS.flash, 'SYS', 'USER', { temperature: 0.2, responseMimeType: 'application/json', thinking: false });
    assert.deepStrictEqual(calls[0].body.generationConfig, {
      temperature: 0.2,
      maxOutputTokens: 4096,
      responseMimeType: 'application/json',
      thinkingConfig: { thinkingBudget: 0 },
    });
  });
});

test('callers that leave thinking unset send the same request as before', async () => {
  await withFakePost(() => geminiText('prose'), async calls => {
    const out = await callGemini(MODELS.flash, 'SYS', 'USER', { temperature: 0.9 });
    assert.strictEqual(out, 'prose');
    assert.deepStrictEqual(calls[0].body, {
      contents: [{ role: 'user', parts: [{ text: 'USER' }] }],
      generationConfig: { temperature: 0.9, maxOutputTokens: 4096 },
      system_instruction: { parts: [{ text: 'SYS' }] },
    });
  });
});

test('Reddit asks Gemini about a skipped post once, and every call has thinking off', async () => {
  const subs = scraper.REDDIT_SUBREDDITS.splice(0);
  scraper.REDDIT_SUBREDDITS.push('Gold'); // one subreddit keeps the 1.5s pause to one per run
  scraper._skippedUrls.clear();
  saved.clear();

  const realGet = axios.get;
  axios.get = async () => ({
    status: 200,
    data: { data: { children: [
      { data: { permalink: '/r/Gold/comments/aaa/meme/', title: 'Look at my cat next to my stack', selftext: 'No market content here at all', score: 5 } },
      { data: { permalink: '/r/Gold/comments/bbb/comex/', title: 'COMEX registered silver drops again', selftext: 'Registered fell 4 million oz this week', score: 250 } },
    ] } },
  });

  try {
    await withFakePost((url, body) => {
      const post = body.contents[0].parts[0].text;
      if (post.includes('cat next to my stack')) return geminiText('{"claims":[],"summary":"Not relevant"}');
      return geminiText('{"claims":["Registered silver fell 4 million oz"],"key_figures":[],"sentiment":"bullish","topics":["comex"],"summary":"COMEX draw"}');
    }, async calls => {
      await scraper.scrapeReddit();
      await scraper.scrapeReddit();

      assert.strictEqual(calls.length, 2, 'one call per post across both runs');
      for (const c of calls) {
        assert.deepStrictEqual(c.body.generationConfig.thinkingConfig, { thinkingBudget: 0 });
      }
      assert.ok(scraper._skippedUrls.has('https://reddit.com/r/Gold/comments/aaa/meme/'));
      assert.ok(saved.has('https://reddit.com/r/Gold/comments/bbb/comex/'));
      assert.ok(!saved.has('https://reddit.com/r/Gold/comments/aaa/meme/'), 'skipped posts still stay out of the table');
    });
  } finally {
    axios.get = realGet;
    scraper.REDDIT_SUBREDDITS.splice(0, scraper.REDDIT_SUBREDDITS.length, ...subs);
  }
});
