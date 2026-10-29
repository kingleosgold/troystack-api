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
  parseHeadlineReply,
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

test('a trade call after a comma or a spaced hyphen is refused', () => {
  for (const headline of [
    'Gold Holds $4,057, Buy Silver Before the Fed',
    'Silver $53.77, Stack More Now',
    'Gold Holds $4,057 as Fed Looms, Sell Now',
    'Gold Holds $4,057, Keep Stacking Silver',
    'Silver Looks Like a Buy at $53.77',
  ]) {
    const problems = headlineProblems(headline, SOURCE, SUFFIX);
    assert.ok(problems.some((p) => p.startsWith('trade call')), `${headline} -> ${problems.join('; ')}`);
  }
  for (const headline of ['Central Banks Keep Buying as Gold Holds $4,057', 'Sell Orders Pile Up as Gold Holds $4,057']) {
    assert.deepStrictEqual(headlineProblems(headline, SOURCE, SUFFIX), [], `${headline} is reporting, not a call`);
  }
});

test('spelled numbers and ordinals need the same fact in the notes', () => {
  const fourth = headlineProblems('Gold Posts Fourth Weekly Gain at $4,057', SOURCE, SUFFIX);
  assert.ok(fourth.some((p) => p.includes('number 4')), fourth.join('; '));
  const half = headlineProblems('Fed Weighs Half-Point Hike as Gold Holds $4,057', SOURCE, SUFFIX);
  assert.ok(half.some((p) => p.includes('number 0.5')), half.join('; '));
  const notes = 'Gold fell for a fourth straight day to $4,057.10 after a half-point hike.';
  assert.deepStrictEqual(headlineProblems('Gold Falls a Fourth Day After Half-Point Hike', notes, SUFFIX), []);
});

test('a percent written out in the notes supports the % in a headline', () => {
  const notes = 'Inflation came in at 3.7 percent and gold ended at $4,057.10.';
  assert.deepStrictEqual(headlineProblems('Gold Whipsaws on 3.7% Inflation Print at $4,057', notes, SUFFIX), []);
});

test('a spaced hyphen, leftover JSON and a one-word reply are refused', () => {
  assert.ok(headlineProblems('Gold Holds $4,057 - Fed Decision Looms', SOURCE, SUFFIX).includes('dash'));
  assert.deepStrictEqual(headlineProblems('Gold Holds $4,057 as Rate-Hike Fears Ease', SOURCE, SUFFIX), [], 'a hyphen inside a word is fine');
  assert.ok(headlineProblems('{"Headline": "Gold Holds $4,057 as Fed', SOURCE, SUFFIX).includes('stray characters'));
  assert.ok(headlineProblems('Null', SOURCE, SUFFIX).includes('too short'));
});

test('a broken or null model reply parses to an empty headline', () => {
  assert.strictEqual(parseHeadlineReply('{"headline": "Gold Holds $4,057 as Fed Decision Looms"}'), 'Gold Holds $4,057 as Fed Decision Looms');
  assert.strictEqual(parseHeadlineReply('{"headline": "Gold Holds $4,057 as Fed'), '');
  assert.strictEqual(parseHeadlineReply('null'), '');
  assert.strictEqual(parseHeadlineReply(''), '');
  assert.strictEqual(parseHeadlineReply('Sure, here you go {"headline": "Gold Holds $4,057"} hope that helps'), 'Gold Holds $4,057');
});

test('market acronyms pass the all-caps check', () => {
  for (const headline of ['CME and LME Stocks Fall as Gold Holds $4,057', 'SGE Premiums and WGC Data Keep Gold at $4,057', 'Weak PMI and a Soft USD Lift Gold to $4,057']) {
    assert.deepStrictEqual(headlineProblems(headline, SOURCE, SUFFIX), [], headline);
  }
});

test('title case covers hyphens and slashes and leaves capitals alone', () => {
  assert.strictEqual(toTitleCase('rate-hike fears lift the gold/silver ratio'), 'Rate-Hike Fears Lift the Gold/Silver Ratio');
  assert.strictEqual(toTitleCase('inflation hits 3-year high'), 'Inflation Hits 3-Year High');
  assert.strictEqual(toTitleCase('iShares silver trust adds ounces'), 'iShares Silver Trust Adds Ounces');
});

test('an order to trade with no metal named, "a buy" and "opportunity" are refused', () => {
  for (const headline of [
    'Buy Before the Fed as Gold Holds $4,057',
    'Gold Holds $4,057, Buy Before the Fed',
    'Gold Holds $4,057: Sell Into the Fed',
    'Stack Before the Fed as Gold Holds $4,057',
    'Load Up Before the Fed as Gold Holds $4,057',
    'Silver Is Still a Buy at $53.77',
    'Silver Remains a Buy at $53.77',
    'Silver Is a Strong Buy at $53.77',
    'Gold Dips to $4,057, an Opportunity for Stackers',
  ]) {
    const problems = headlineProblems(headline, SOURCE, SUFFIX);
    assert.ok(problems.some((p) => p.startsWith('trade call')), `${headline} -> ${problems.join('; ')}`);
  }
});

test('reporting on buying and selling still passes', () => {
  const notes = `${SOURCE}\nGold rose to $4,057.10, adding to today's gains, while central banks kept adding gold.`;
  for (const headline of [
    'Sell Orders Pile Up as Gold Holds $4,057',
    'Central Banks Keep Buying as Gold Holds $4,057',
    'Buying Slows as Gold Holds $4,057',
    "Gold Rises to $4,057, Adding to Today's Gains",
    'Central Banks Keep Buying, Adding Gold at $4,057',
    "Gold's Drop to $4,057 Is a Sell-Off in Paper",
    'Buy-Side Demand Holds Gold at $4,057',
  ]) {
    assert.deepStrictEqual(headlineProblems(headline, notes, SUFFIX), [], headline);
  }
});

test('a headline may open on a word like iShares, and market acronyms pass', () => {
  assert.deepStrictEqual(headlineProblems('iShares Silver Holdings Climb as Gold Holds $4,057', SOURCE, SUFFIX), []);
  const notes = 'Gold sat at $4,057.10 as the S&P 500 slid and CFTC data showed funds trimming.';
  assert.deepStrictEqual(headlineProblems('Gold Holds $4,057 as S&P 500 Slides', notes, SUFFIX), []);
  assert.deepStrictEqual(headlineProblems('CFTC Data Shows Funds Trim Gold at $4,057', notes, SUFFIX), []);
});

test('teens, scale words and rounded dollars are matched strictly', () => {
  const teen = 'Gold hit a thirteen-year high at $4,057.10.';
  assert.deepStrictEqual(headlineProblems('Gold Hits 13-Year High at $4,057', teen, SUFFIX), []);
  assert.ok(headlineProblems('Gold Posts Thirteenth Record Close at $4,057', SOURCE, SUFFIX).some((p) => p.includes('number 13')));
  const millions = 'Gold funds added $2 million while gold sat at $4,057.10.';
  assert.ok(headlineProblems('Gold Funds Add $2 Billion as Gold Holds $4,057', millions, SUFFIX).some((p) => p.includes('not in the day')));
  assert.deepStrictEqual(headlineProblems('Gold Funds Add $2 Million as Gold Holds $4,057', millions, SUFFIX), []);
  // $53.77 rounds to $54 for a price, but a plain 54 isn't a price.
  assert.ok(headlineProblems('Central Banks Add 54 Tonnes as Gold Holds $4,057', SOURCE, SUFFIX).some((p) => p.includes('number 54')));
});

test('chatbot, algorithmic and GenAI are banned, place names ending in ai are not', () => {
  for (const headline of ['Chatbot Buzz Lifts Gold to $4,057', 'Algorithmic Selling Hits Gold at $4,057', 'GenAI Demand Lifts Silver to $53.77']) {
    assert.ok(headlineProblems(headline, SOURCE, SUFFIX).some((p) => p.startsWith('banned word')), headline);
  }
  for (const headline of ['Shanghai Premiums Lift Gold to $4,057', 'Dubai and Mumbai Demand Keeps Gold at $4,057']) {
    assert.deepStrictEqual(headlineProblems(headline, SOURCE, SUFFIX), [], headline);
  }
});
