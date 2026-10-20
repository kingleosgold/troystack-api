// Troy's Stack Signal pieces vary their openings and make no trade calls.
//   node --test
// The model calls are faked and record the system prompt each writer sends.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

process.env.SUPABASE_URL ||= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-dummy-service-role-key';

const prompts = [];

function stub(rel, exportsObj) {
  const file = require.resolve(path.join(__dirname, '..', rel));
  const m = new Module(file, null);
  m.filename = file;
  m.loaded = true;
  m.exports = exportsObj;
  require.cache[file] = m;
}

stub('src/services/ai-router', {
  callGemini: async (model, system) => { prompts.push(system); return 'Gold held while the dollar slipped'; },
  callClaude: async (system) => { prompts.push(system); return 'Gold held while the dollar slipped.'; },
  generateImage: async () => { throw new Error('no images in tests'); },
  MODELS: { flash: 'flash', editorial: 'editorial' },
});
stub('src/services/price-fetcher', { getCachedPrices: () => ({ gold: 4000, silver: 48 }) });
stub('src/services/intelligence-scraper', { getTopIntelligence: async () => '' });

const { TAKE_RULES, BANNED_OPENINGS, BANNED_TRADE_CALLS } = require('../src/services/take-rules');
const ssp = require('../src/services/stack-signal-processor');

const cluster = {
  theme: 'Gold slips on hot CPI',
  suggested_angle: 'What the slide means for people who hold metal',
  articles: [{ source: 'Wire', title: 'Gold slips on hot CPI', description: 'Spot eased after the print' }],
};

test('the rules name the openings and trade calls Troy kept using', () => {
  for (const phrase of ['missing the point', 'what everyone else is missing', 'the real story']) {
    assert.ok(BANNED_OPENINGS.includes(phrase), phrase);
    assert.ok(TAKE_RULES.includes(`"${phrase}"`), phrase);
  }
  for (const phrase of ['buy the dip', 'treat the dip as an opportunity', 'dips are buying opportunities', 'sounds like a sale']) {
    assert.ok(BANNED_TRADE_CALLS.includes(phrase), phrase);
    assert.ok(TAKE_RULES.includes(`"${phrase}"`), phrase);
  }
  assert.match(TAKE_RULES, /Never recommend selling/);
  assert.match(TAKE_RULES, /the dip is a rates trade, not a change in why they hold metal/);
  assert.ok(!TAKE_RULES.includes('—'), 'no em dash in the rules');
});

test('the feed reaction, the synthesis article and its one-liner each carry the rules', async () => {
  prompts.length = 0;
  await ssp.writeFeedReaction(cluster, { gold: 4000, silver: 48 });
  await ssp.writeSynthesisArticle(cluster, { gold: 4000, silver: 48 });
  await ssp.generateArticleMetadata(cluster, 'Gold held while the dollar slipped.');
  assert.strictEqual(prompts.length, 3);
  for (const system of prompts) {
    assert.ok(system.endsWith(TAKE_RULES), system.slice(0, 60));
    assert.ok(!/dips are buying opportunities/i.test(system.replace(TAKE_RULES, '')), system.slice(0, 60));
  }
});

test('the writers no longer tell Troy to call dips buys or say what everyone is missing', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/services/stack-signal-processor.js'), 'utf8');
  assert.strictEqual((src.match(/\$\{TAKE_RULES\}/g) || []).length, 4, 'feed, synthesis, one-liner and the daily Signal');
  assert.ok(!/Dips are buying opportunities/i.test(src));
  assert.ok(!src.includes('what everyone else is missing'));
  assert.ok(!src.includes('was this a good month to stack'));
});
