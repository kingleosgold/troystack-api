// Tests for podcast episode titles (services/podcast-title.js).
//   node --test
// Pure functions plus buildEpisodeTitle with the model call swapped out, so
// nothing here reaches a provider. 1999 fixture dates by policy, like
// test/podcast.test.js.

const test = require('node:test');
const assert = require('node:assert');

const {
  buildEpisodeTitle,
  headlineProblems,
  fallbackTitle,
  titleSuffix,
  toTitleCase,
  MAX_TITLE_CHARS,
} = require('../src/services/podcast-title');

const ARTICLE = {
  title: 'The Stack Signal: January 31, 1999',
  troy_one_liner: 'Gold at $4,057.10 and silver at $53.77 hold steady as the Fed decision and a firm dollar set the tone.',
  troy_commentary: 'Gold is sitting at $4,057.10 and silver at $53.77 with the Fed decision hours away. Inflation sits at a three-year high and the ratio is 75.5.\n\nSecond paragraph with $9,999 that titles may not use.',
  published_at: '1999-01-31T11:15:00+00:00',
  gold_price_at_publish: 4057.1,
  silver_price_at_publish: 53.77,
};
const SOURCE = `${ARTICLE.troy_one_liner}\n${ARTICLE.troy_commentary.split('\n\n')[0]}\n$4057.10 $53.77`;
const SUFFIX = ' | Jan 31';

test('the date suffix is the short America/New_York date', () => {
  assert.strictEqual(titleSuffix('1999-01-31T11:15:00+00:00'), ' | Jan 31');
  assert.strictEqual(titleSuffix('1999-09-05T11:15:00+00:00'), ' | Sep 5');
  // 03:00 UTC is still the previous evening in New York.
  assert.strictEqual(titleSuffix('1999-02-01T03:00:00+00:00'), ' | Jan 31');
});

test('a headline that keeps every rule passes', () => {
  assert.deepStrictEqual(headlineProblems('Gold Holds $4,057, Silver $53.77 as Fed Decision Looms', SOURCE, SUFFIX), []);
  assert.deepStrictEqual(headlineProblems('Inflation Hits 3-Year High as Gold Holds $4,057', SOURCE, SUFFIX), [], 'a spelled number supports its digit');
  assert.deepStrictEqual(headlineProblems('Gold Holds $4,057 as Ratio Sits at 75.5', SOURCE, SUFFIX), []);
});

test('a headline with a number the notes never state is refused', () => {
  const problems = headlineProblems('Gold Holds $4,060 as Fed Decision Looms', SOURCE, SUFFIX);
  assert.ok(problems.some((p) => p.includes('$4060')), problems.join('; '));
  const deep = headlineProblems('Gold Holds $9,999 as Fed Decision Looms', SOURCE, SUFFIX);
  assert.ok(deep.some((p) => p.includes('$9999')), 'only the first paragraph counts as the day\'s data');
});

test('banned words, dashes, shouting and trade calls are refused', () => {
  const cases = {
    'AI Says Gold Holds $4,057 as Fed Decision Looms': 'banned word',
    'Gold Holds $4,057 — Fed Decision Looms': 'dash',
    'SHOCKING Gold Holds $4,057 Before the Fed': 'all caps',
    'Gold Holds $4,057 as Fed Decision Looms!': 'punctuation',
    'Gold Holds $4,057: Buy the Dip Before the Fed': 'trade call',
    'gold holds $4,057 as fed decision looms': 'lowercase start',
  };
  for (const [headline, expected] of Object.entries(cases)) {
    const problems = headlineProblems(headline, SOURCE, SUFFIX);
    assert.ok(problems.some((p) => p.startsWith(expected)), `${headline} -> ${problems.join('; ')}`);
  }
  assert.deepStrictEqual(headlineProblems('COMEX and CPI Keep Gold at $4,057', SOURCE, SUFFIX), [], 'acronyms are fine');
});

test('the title with its date stays within the cap', () => {
  const long = 'Gold Holds $4,057 and Silver Holds $53.77 as the Fed Decision Looms Large';
  assert.ok((long + SUFFIX).length > MAX_TITLE_CHARS);
  assert.ok(headlineProblems(long, SOURCE, SUFFIX).some((p) => p.startsWith('over')));
});

test('title case leaves acronyms, prices and small words alone', () => {
  assert.strictEqual(toTitleCase('gold holds $4,057 as fed decision looms'), 'Gold Holds $4,057 as Fed Decision Looms');
  assert.strictEqual(toTitleCase('COMEX vaults run thin on supply'), 'COMEX Vaults Run Thin on Supply');
  assert.strictEqual(toTitleCase('the dollar firms'), 'The Dollar Firms', 'a small word starting the title is capitalized');
});

test('a good model headline becomes the title with the date added', async () => {
  const calls = [];
  const generate = async (_a, opts) => { calls.push(opts); return 'Gold Holds $4,057, Silver $53.77 as Fed Decision Looms'; };
  const r = await buildEpisodeTitle(ARTICLE, { generate });
  assert.strictEqual(r.title, 'Gold Holds $4,057, Silver $53.77 as Fed Decision Looms | Jan 31');
  assert.strictEqual(r.source, 'generated');
  assert.strictEqual(calls.length, 1);
});

test('a date the model adds itself is replaced by the real one', async () => {
  const generate = async () => 'Gold Holds $4,057 as Fed Decision Looms | Dec 25';
  const r = await buildEpisodeTitle(ARTICLE, { generate });
  assert.strictEqual(r.title, 'Gold Holds $4,057 as Fed Decision Looms | Jan 31');
});

test('one rule break gets one retry that names the rule', async () => {
  const calls = [];
  const replies = ['Gold Holds $4,060 as Fed Decision Looms', 'Gold Holds $4,057 as Fed Decision Looms'];
  const generate = async (_a, opts) => { calls.push(opts); return replies[calls.length - 1]; };
  const r = await buildEpisodeTitle(ARTICLE, { generate });
  assert.strictEqual(r.source, 'generated');
  assert.strictEqual(r.title, 'Gold Holds $4,057 as Fed Decision Looms | Jan 31');
  assert.strictEqual(calls.length, 2);
  assert.ok(calls[1].retryNote.includes('$4060'));
});

test('two rule breaks in a row give the plain price line', async () => {
  let n = 0;
  const generate = async () => { n++; return 'AI Says Gold Is Fine'; };
  const r = await buildEpisodeTitle(ARTICLE, { generate });
  assert.strictEqual(n, 2);
  assert.strictEqual(r.source, 'fallback');
  assert.strictEqual(r.title, 'Gold $4,057, Silver $53.77: Daily Brief | Jan 31');
  assert.ok(r.title.length <= MAX_TITLE_CHARS);
});

test('a provider error gives the fallback without a second call', async () => {
  let n = 0;
  const generate = async () => { n++; throw new Error('GEMINI_API_KEY not configured'); };
  const r = await buildEpisodeTitle(ARTICLE, { generate });
  assert.strictEqual(n, 1);
  assert.strictEqual(r.source, 'fallback');
  assert.strictEqual(r.title, 'Gold $4,057, Silver $53.77: Daily Brief | Jan 31');
});

test('without stored prices the fallback is the dated title, dash-free', () => {
  const noPrices = { ...ARTICLE, gold_price_at_publish: null, silver_price_at_publish: null, title: 'The Stack Signal — January 31, 1999' };
  assert.strictEqual(fallbackTitle(noPrices, SUFFIX), 'The Stack Signal: January 31, 1999');
});
