// Episode titles for The Stack Signal podcast.
//
// A title is the day's news the way a search would phrase it, with the
// date after a bar:
//   Gold Holds $4,057, Silver $53.77 as Fed Decision Looms | Oct 28
// Every podcast app already shows the show's name next to the episode, so
// the title carries the story instead of "The Stack Signal: October 28, 2026".
//
// The model writes only the headline, from the day's one-liner, the first
// paragraph and the prices stored on the article. The code adds the date and
// checks every rule below. A headline that breaks one is asked for once more,
// and a second miss gets a plain price line built from the stored prices, so
// a title never holds a number the episode doesn't.
//
// Titles never say AI. The required disclosure lives in the show notes and
// the spoken outro (see routes/podcast.js and buildEpisodeScript).

const { callGemini, MODELS } = require('./ai-router');
const { findTakeBreaks } = require('./take-rules');

const MAX_TITLE_CHARS = 70;

// Whole-word, case-insensitive. "Bot" and "algorithm" read as machine-made
// copy in a news title; AI is the brand rule.
const BANNED_WORDS = [
  /\bai\b/i,
  /\bai-generated\b/i,
  /artificial intelligence/i,
  /\bbots?\b/i,
  /\balgorithms?\b/i,
];

// Acronyms a metals headline uses. Any other all-caps word is shouting.
const ACRONYMS = new Set([
  'COMEX', 'CME', 'LME', 'SGE', 'WGC', 'CPI', 'PPI', 'PCE', 'PMI', 'FOMC', 'GDP',
  'ETF', 'ETFS', 'US', 'USA', 'USD', 'UK', 'EU', 'ECB', 'BOE', 'BOJ', 'PBOC', 'RBI',
  'SNB', 'LBMA', 'SLV', 'GLD', 'OPEC', 'IMF', 'BRICS', 'NFP', 'DXY', 'YTD',
  'Q1', 'Q2', 'Q3', 'Q4',
]);

// Lowercase inside a title unless they start it.
const SMALL_WORDS = new Set([
  'a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'in', 'nor', 'of', 'on',
  'or', 'per', 'the', 'to', 'vs', 'via',
]);

// Spelled numbers and ordinals, so "Third Straight Day" or "Half-Point
// Hike" in a headline needs the same fact in the notes.
const NUMBER_WORDS = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
  nine: 9, ten: 10, eleven: 11, twelve: 12, fifteen: 15, twenty: 20, thirty: 30,
  forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
  hundred: 100, first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6,
  seventh: 7, eighth: 8, ninth: 9, tenth: 10, eleventh: 11, twelfth: 12,
  half: 0.5, quarter: 0.25,
};

// ' | Oct 28' for the episode's America/New_York date.
function titleSuffix(publishedAt) {
  const label = new Date(publishedAt).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', timeZone: 'America/New_York',
  });
  return ` | ${label}`;
}

// Capitalizes an all-lowercase word, each part of it after a hyphen or a
// slash too (rate-hike is Rate-Hike, gold/silver is Gold/Silver), unless it's
// a small word inside the title. A word with any capital already is left as
// written, so COMEX, iShares, Fed's and $4,057 come through unchanged.
function toTitleCase(headline) {
  return headline
    .split(' ')
    .map((word, i) => {
      if (!word || /[A-Z]/.test(word)) return word;
      const bare = word.replace(/[^a-z]/g, '');
      if (i > 0 && SMALL_WORDS.has(bare)) return word;
      return word.replace(/(^|[-/])([^a-z0-9$]*)([a-z])/g, (_, sep, lead, ch) => sep + lead + ch.toUpperCase());
    })
    .join(' ');
}

// Every number a piece of text states, as { kind, value }. In the day's
// notes a dollar amount also counts at its whole-dollar rounding, since gold
// titles drop the cents ($4,057.10 is $4,057), and in any text a spelled
// number counts as its digit (a "three-year high" supports "3-Year High").
function numbersIn(text, { rounding = true } = {}) {
  const out = [];
  const src = String(text || '');
  for (const m of src.matchAll(/(\$?)(\d[\d,]*(?:\.\d+)?)(\s*(?:%|percent\b))?/gi)) {
    const value = Number(m[2].replace(/,/g, ''));
    if (!Number.isFinite(value)) continue;
    const kind = m[1] ? 'usd' : m[3] ? 'pct' : 'num';
    out.push({ kind, value });
    if (rounding && kind === 'usd') out.push({ kind, value: Math.round(value) });
  }
  for (const m of src.toLowerCase().matchAll(/\b([a-z]+)\b/g)) {
    if (NUMBER_WORDS[m[1]] !== undefined) out.push({ kind: 'num', value: NUMBER_WORDS[m[1]] });
  }
  return out;
}

function sourceText(article) {
  const prices = [];
  const gold = Number(article.gold_price_at_publish);
  const silver = Number(article.silver_price_at_publish);
  if (gold > 0) prices.push(`$${gold.toFixed(2)}`);
  if (silver > 0) prices.push(`$${silver.toFixed(2)}`);
  if (gold > 0 && silver > 0) prices.push((gold / silver).toFixed(1));
  const body = String(article.troy_commentary || '').split(/\n\s*\n/)[0] || '';
  return [article.troy_one_liner || '', body, prices.join(' ')].join('\n');
}

// The rules a headline (the title without its date) has to meet. Returns
// the broken ones, empty when the headline is good.
function headlineProblems(headline, source, suffix) {
  const problems = [];
  const h = String(headline || '').trim();
  if (!h) return ['empty'];
  if (h.length + suffix.length > MAX_TITLE_CHARS) problems.push(`over ${MAX_TITLE_CHARS} characters with the date`);
  // A spaced hyphen stands in for a dash. Hyphens inside words (Rate-Hike) stay.
  if (/[—–]|\s-+\s/.test(h)) problems.push('dash');
  if (/[!?]/.test(h)) problems.push('punctuation');
  // Left over from a broken model reply, like {"headline": "Gold Holds
  if (/[{}[\]"\\]/.test(h)) problems.push('stray characters');
  if (h.split(/\s+/).length < 3) problems.push('too short');
  if (h.includes('|')) problems.push('bar');
  if (/^[a-z]/.test(h)) problems.push('lowercase start');
  for (const re of BANNED_WORDS) if (re.test(h)) problems.push(`banned word ${re.source}`);
  for (const word of h.split(/[\s/]+/)) {
    const letters = word.replace(/[^A-Za-z0-9]/g, '');
    if (letters.length >= 2 && /[A-Z]/.test(letters) && letters === letters.toUpperCase()
      && !/^\d+$/.test(letters) && !ACRONYMS.has(letters.replace(/S$/, '')) && !ACRONYMS.has(letters)) {
      problems.push(`all caps ${word}`);
    }
  }
  // findTakeBreaks reads sentence starts, and a headline joins its clauses
  // with commas, so each clause after a comma or a spaced hyphen is checked
  // as a sentence of its own. "Looks like a buy" has no verb to catch.
  const breaks = [
    ...findTakeBreaks(h),
    ...findTakeBreaks(h.replace(/,\s+|\s+-+\s+/g, '. ')),
    ...(/\b(?:is|looks like) an? (?:buy|sell)\b/i.test(h) ? ['a buy or sell call'] : []),
  ];
  if (breaks.length) problems.push(`trade call ${[...new Set(breaks)].join(', ')}`);
  const supported = numbersIn(source);
  for (const n of numbersIn(h, { rounding: false })) {
    const ok = supported.some((s) => s.kind === n.kind && s.value === n.value)
      || (n.kind === 'num' && supported.some((s) => s.value === n.value));
    if (!ok) problems.push(`number ${n.kind === 'usd' ? '$' : ''}${n.value}${n.kind === 'pct' ? '%' : ''} not in the day's data`);
  }
  return [...new Set(problems)];
}

// Gold $4,057, Silver $53.77: Daily Brief | Oct 28, from the stored
// prices. Without them, the article's own dated title, dash-free.
function fallbackTitle(article, suffix) {
  const gold = Number(article.gold_price_at_publish);
  const silver = Number(article.silver_price_at_publish);
  if (gold > 0 && silver > 0) {
    const g = Math.round(gold).toLocaleString('en-US');
    const s = silver.toFixed(2);
    return `Gold $${g}, Silver $${s}: Daily Brief${suffix}`;
  }
  return String(article.title || 'The Stack Signal').replace(/\s*[—–]\s*/g, ': ');
}

const SYSTEM_PROMPT = `You write the episode title for The Stack Signal, a daily gold and silver podcast for people who hold physical metal. Write the headline a stacker would search for, from the day's notes you're given.

Shape: {Subject} {Verb} {Key Level} {as|on|while} {Driver}
- Subject: what the notes lead with, like Gold, Silver, Central Banks, Inflation or COMEX.
- Verb: one plain present-tense move word, like Holds, Slips, Slides, Jumps, Tests, Drops, Rebounds or Breaks.
- Key Level: one price copied from the notes. Gold in whole dollars with a comma ($4,057), silver to the cent ($53.77), or a round level the notes name (Above $4,000, Under $55).
- Driver: the single biggest reason in the notes, three to six words.
- Title Case. At most 58 characters. No date, no year and no show name, since the date is added after you.

Never use a number that isn't in the notes. Never write AI, bot or algorithm. No exclamation points, no question marks, no dashes and no all-caps words except acronyms like COMEX or CPI. Never tell anyone to buy, sell, add or wait, and never call a move an opportunity.

Examples:
Gold Holds $4,057, Silver $53.77 as Fed Decision Looms
Silver $53.98 as London Vaults Run Thin on Supply
Gold Slides to $4,147 on December Rate-Hike Fears

Return JSON only: {"headline": "..."}`;

async function geminiHeadline(article, { retryNote } = {}) {
  const notes = sourceText(article);
  const user = `Today's notes:\n${notes}${retryNote ? `\n\nYour last headline broke these rules: ${retryNote}. Write a new one that keeps every rule.` : ''}`;
  const raw = await callGemini(MODELS.flash, SYSTEM_PROMPT, user, {
    temperature: 0.4,
    maxOutputTokens: 200,
    responseMimeType: 'application/json',
    thinking: false,
    timeout: 20000,
  });
  return parseHeadlineReply(raw);
}

// The headline from the model's JSON reply. A reply cut off mid-JSON, or
// null, gives an empty headline and the retry, never the raw text.
function parseHeadlineReply(raw) {
  const text = String(raw || '').trim();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = undefined; }
  if (parsed && typeof parsed.headline === 'string') return parsed.headline;
  const m = text.match(/"headline"\s*:\s*"([^"]*)"/);
  return m ? m[1] : '';
}

// The title for one episode. Never throws: a provider error or two rule
// breaks in a row give the fallback. opts.generate swaps the model call,
// for tests. Returns { title, source } where source is 'generated' or
// 'fallback', plus the rules a rejected headline broke.
async function buildEpisodeTitle(article, { generate = geminiHeadline } = {}) {
  const suffix = titleSuffix(article.published_at);
  const source = sourceText(article);
  let problems = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const raw = await generate(article, { retryNote: attempt ? problems.join('; ') : undefined });
      const headline = toTitleCase(String(raw || '').split('|')[0].replace(/\s+/g, ' ').trim().replace(/[.,;:]+$/, ''));
      problems = headlineProblems(headline, source, suffix);
      if (!problems.length) return { title: `${headline}${suffix}`, source: 'generated', problems: [] };
    } catch (err) {
      problems = [`provider error: ${err.message}`];
      break; // a failed call isn't retried; the fallback is free
    }
  }
  return { title: fallbackTitle(article, suffix), source: 'fallback', problems };
}

module.exports = {
  buildEpisodeTitle,
  headlineProblems,
  parseHeadlineReply,
  fallbackTitle,
  titleSuffix,
  toTitleCase,
  numbersIn,
  sourceText,
  MAX_TITLE_CHARS,
};
