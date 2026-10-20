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
let geminiReply = 'Gold held while the dollar slipped';

function stub(rel, exportsObj) {
  const file = require.resolve(path.join(__dirname, '..', rel));
  const m = new Module(file, null);
  m.filename = file;
  m.loaded = true;
  m.exports = exportsObj;
  require.cache[file] = m;
}

stub('src/services/ai-router', {
  callGemini: async (model, system) => { prompts.push(system); return geminiReply; },
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

test('findTakeBreaks catches a banned opening only at the start and a trade call anywhere', () => {
  const { findTakeBreaks } = require('../src/services/take-rules');
  assert.deepStrictEqual(findTakeBreaks('Gold held while the dollar slipped.'), []);
  assert.deepStrictEqual(findTakeBreaks(''), []);
  assert.deepStrictEqual(findTakeBreaks(null), []);
  assert.deepStrictEqual(findTakeBreaks('"The Real Story here is rates.'), ['the real story']);
  const late = 'Gold slid 1% after CPI. '.repeat(10) + 'Some call the real story rates.';
  assert.deepStrictEqual(findTakeBreaks(late), []);
  assert.deepStrictEqual(findTakeBreaks('Spot fell. Honestly, it sounds like a sale.'), ['sounds like a sale']);
  assert.deepStrictEqual(findTakeBreaks('Don’t get distracted by the CPI print.'), ["don't get distracted"]);
  for (const text of [
    'Gold fell 2%. Nothing here says it is time to sell.',
    "Gold fell 2%. This isn't a crash, it's a buying opportunity.",
    'Gold fell 2%. There is never a bad time to buy gold.',
    "Gold fell 2%. Don't miss a buying opportunity like this.",
    'Gold fell 2%. Prices are not falling; buy the dip.',
  ]) assert.ok(findTakeBreaks(text).length, text);
  assert.deepStrictEqual(findTakeBreaks('Gold fell 2%. Miners say it is time to buyback stock.'), []);
  assert.deepStrictEqual(findTakeBreaks('Gold fell 2%. Time to buy, said the desk.'), ['time to buy']);
});

test('a feed reaction that makes a trade call is set aside like a failed draft', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'stack-signal-processor.js'), 'utf8');
  assert.match(src, /const breaks = findTakeBreaks\(articleText\);/);
  assert.match(src, /articleText\.length < MIN_ARTICLE_CHARS \|\| breaks\.length\)/);
  assert.match(src, /logTakeBreaks\('Claude Synthesis', articleText\)/);
  assert.match(src, /logTakeBreaks\('Stack Signal'/);
});

test('a one-liner that makes a trade call falls back to the theme', async () => {
  geminiReply = 'Buy the dip while it lasts';
  try {
    const meta = await ssp.generateArticleMetadata(cluster, 'Gold slipped after the print.');
    assert.strictEqual(meta.troy_one_liner, cluster.theme);
  } finally {
    geminiReply = 'Gold held while the dollar slipped';
  }
});

test('an order to buy, sell, add or wait counts in any wording', () => {
  const { findTakeBreaks } = require('../src/services/take-rules');
  for (const t of [
    'Buy gold before the next leg higher.',
    'Add to your stack.',
    'Gold slid. Sell your silver now.',
    'Wait for a lower price.',
    'You should add here.',
    'Consider buying while it lasts.',
    "Now's the time to load up.",
  ]) {
    assert.ok(findTakeBreaks(t).length > 0, t);
  }
});

test('reporting what others buy or sell is not a call', () => {
  const { findTakeBreaks } = require('../src/services/take-rules');
  for (const t of [
    'Central banks buy gold every quarter.',
    'The U.S. sell-off deepened as yields rose.',
    'Buyback programs grew at the majors.',
    'Gold traded at $2,650.50. Silver followed.',
  ]) {
    assert.deepStrictEqual(findTakeBreaks(t), [], t);
  }
});
