// Tests for the Gemini cost fix in the 15-minute Stack Signal run: the daily
// cap is checked before scoring, the short structured calls run with thinking
// off, and no tweet text is generated while X distribution is off.
// Supabase, RSS and axios are faked, so nothing leaves the machine.
//   node --test

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const Module = require('node:module');

process.env.GEMINI_API_KEY = 'gemini-test-key';

let dailyCount = 0;
const today = () => new Date().toISOString().split('T')[0];

const fakeSupabase = {
  from(table) {
    const q = { table, filters: {} };
    const api = {
      select() { return api; },
      eq(col, val) { q.filters[col] = val; return api; },
      gte() { return api; },
      order() { return api; },
      limit() { return Promise.resolve({ data: [], error: null }); },
      single() {
        if (table === 'app_state' && q.filters.key === 'commentary_daily_count') {
          return Promise.resolve({ data: { value: { date: today(), count: dailyCount } }, error: null });
        }
        return Promise.resolve({ data: null, error: { code: 'PGRST116' } });
      },
      insert() { return Promise.resolve({ error: null }); },
      upsert() { return Promise.resolve({ error: null }); },
    };
    return api;
  },
};

function stub(rel, exportsObj) {
  const file = require.resolve(path.join(__dirname, '..', rel));
  const m = new Module(file, null);
  m.filename = file;
  m.loaded = true;
  m.exports = exportsObj;
  require.cache[file] = m;
}

const rssArticles = [
  { title: 'Gold holds near record as dollar slips', description: 'Spot gold steady', signal_score: 80, link: 'https://example.com/1', source: 'Wire' },
  { title: 'COMEX silver registered stocks fall', description: 'Registered down again', signal_score: 75, link: 'https://example.com/2', source: 'Wire' },
  { title: 'Central banks keep buying gold', description: 'Purchases continue', signal_score: 70, link: 'https://example.com/3', source: 'Wire' },
];

stub('src/lib/supabase', fakeSupabase);
stub('src/services/rss-fetcher', { fetchNewArticles: async () => rssArticles.map(a => ({ ...a })) });
stub('src/services/price-fetcher', { getCachedPrices: () => ({ gold: 4000, silver: 48 }) });
stub('src/services/auto-tweet', { enqueueTweet: async () => {} });

const axios = require('axios');
const ssp = require('../src/services/stack-signal-processor');

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

test('a run past the daily cap makes no Gemini call at all', async () => {
  dailyCount = 8;
  await withFakePost(() => { throw new Error('Gemini should not be called'); }, async calls => {
    const result = await ssp.runStackSignalPipeline();
    assert.strictEqual(calls.length, 0);
    assert.strictEqual(result.skipped, true);
    assert.strictEqual(result.scored, 0);
  });
});

test('under the cap, scoring runs with thinking off', async () => {
  dailyCount = 0;
  // Scores under 50 leave nothing to cluster or write, so the run stops after scoring.
  const lowScores = JSON.stringify(rssArticles.map((_, i) => ({ index: i + 1, score: 20, category: 'macro' })));
  await withFakePost(() => geminiText(lowScores), async calls => {
    const result = await ssp.runStackSignalPipeline();
    assert.strictEqual(calls.length, 1, 'just the scoring call');
    assert.deepStrictEqual(calls[0].body.generationConfig.thinkingConfig, { thinkingBudget: 0 });
    assert.strictEqual(result.synthesized, 0);
  });
});

test('clustering runs with thinking off', async () => {
  const worthy = rssArticles.map(a => ({ ...a, relevance_score: 80, category: 'gold' }));
  const clusters = JSON.stringify([{ theme: 'Gold and silver tighten', importance: 90, article_indices: [0, 1, 2], suggested_angle: 'Physical tightness', category: 'gold' }]);
  await withFakePost(() => geminiText(clusters), async calls => {
    const out = await ssp.clusterArticles(worthy);
    assert.strictEqual(calls.length, 1);
    assert.deepStrictEqual(calls[0].body.generationConfig.thinkingConfig, { thinkingBudget: 0 });
    assert.strictEqual(out[0].articles.length, 3);
  });
});

test('the one-liner runs with thinking off inside its 100-token cap', async () => {
  const cluster = { theme: 'Gold and silver tighten', importance: 90, category: 'gold', articles: rssArticles };
  await withFakePost(() => geminiText('Physical metal is tighter than the screens say'), async calls => {
    const meta = await ssp.generateArticleMetadata(cluster, 'Article body '.repeat(50));
    assert.strictEqual(meta.troy_one_liner, 'Physical metal is tighter than the screens say');
    assert.strictEqual(calls[0].body.generationConfig.maxOutputTokens, 100);
    assert.deepStrictEqual(calls[0].body.generationConfig.thinkingConfig, { thinkingBudget: 0 });
  });
});

test('no tweet text is generated while X distribution is off', async () => {
  const { X_DISTRIBUTION_ENABLED } = require('../src/config/feature-flags');
  assert.strictEqual(X_DISTRIBUTION_ENABLED, false);
  await withFakePost(() => { throw new Error('Gemini should not be called'); }, async calls => {
    const tweet = await ssp.generateTweetText('Gold holds', 'A long enough analysis to react to. '.repeat(10));
    assert.strictEqual(tweet, null);
    assert.strictEqual(calls.length, 0);
  });
});
