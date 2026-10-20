// Rules for every Stack Signal piece Troy writes: the feed reactions, the
// long synthesis articles, their one-liners and the daily Signal. Takes kept
// opening on "missing the point" and calling dips a buying opportunity, which
// reads as a trade call next to the site's not-financial-advice line.
// Troy's chat prompt (troy-prompt.js) is separate and stays as it is, so his
// chat answers the same on troystack.ai and in the app.

const BANNED_OPENINGS = [
  'missing the point',
  'misses the point',
  'what everyone is missing',
  'what everyone else is missing',
  'the real story',
  'cut through the noise',
  "don't get distracted",
];

const BANNED_TRADE_CALLS = [
  'buy the dip',
  'treat the dip as an opportunity',
  'dips are buying opportunities',
  'a buying opportunity',
  'a gift for your stack',
  'sounds like a sale',
  'time to buy',
  'time to sell',
];

const TAKE_RULES = `TAKE RULES (these override any voice rule above):
- Vary your opening. Start with the news itself, a number or what it means for people who hold metal. Never open by saying the headline, the media or other people have it wrong. Never open with or closely paraphrase: ${BANNED_OPENINGS.map(p => `"${p}"`).join(', ')}.
- No trade calls. Never tell the reader to buy, sell, add or wait, and never frame a move as a buying or selling opportunity. Never write: ${BANNED_TRADE_CALLS.map(p => `"${p}"`).join(', ')}.
- Explain what a move means instead, in your own words each time. For example: "For long-term stackers, the dip is a rates trade, not a change in why they hold metal." Or: "A firmer dollar took $40 off gold today. Nothing about central bank buying changed." Don't reuse either line.
- Never recommend selling.
- Don't write "not financial advice" inside the piece. The site already carries that line, so never contradict it with a trade call.`;

// The listed phrases are examples. A call can be any order to buy, sell, add
// or wait, so these catch the directive forms too. A sentence that starts on
// the verb counts only when what follows is metal, the stack or a moment
// ("Buy gold before the next leg", "Wait for a pullback"), since Troy also
// writes "Add to that the dollar" and reports "Sell orders piled up". "Keep",
// "start" and "consider" only count at the start too, so "central banks keep
// buying" and "dealers consider buying" stay reporting.
const METAL = '(?:gold|silver|platinum|palladium|metals?|bullion|ounces|oz|bars|coins|rounds|physical|the dip|dips|weakness|strength|here|now|today|this|it|them)';
const AMOUNT = '(?:(?:some|more|a little|a few|a bit|any|extra|your|the|physical|real) )*';
const INTO = '(?:(?:into|on|during) (?:this kind of |this |the |any )?)?';
// An order to trade, with what it trades after it.
const CALL = `(?:buy(?:ing)?|sell(?:ing)?|add(?:ing)?(?: to)?|accumulat(?:e|ing)|grab|dump|unload|load(?:ing)? up(?: on)?|stock(?:ing)? up(?: on)?|stack(?:ing)?|get into|pick up) ${INTO}${AMOUNT}${METAL}\\b`;
const WAIT = 'wait (?:for|until|on) (?:a |the |another )?(?:dip|pullback|lower|better|cheaper|drop|correction)\\b';
const DIRECTIVE_START = new RegExp(
  `^(?:(?:keep|start|consider) )?${CALL}|^${WAIT}|^(?:keep|start) (?:buying|stacking|adding|accumulating)\\b`,
);
// Said to the reader, never "if you", "when you" or "told clients you", and
// never "you sell your gold" as a description.
const DIRECTIVE_ANYWHERE = [
  /(?<!\b(?:you|we|they|i|he|she|who|if|when|to|people|investors|stackers) )\b(?:buy|sell|add to|add more to|load up on|stock up on|dump|unload) your (?:stack|position|gold|silver|metal|metals|holdings|bars|coins)\b/,
  new RegExp(`(?<!\\b(?:if|when|whether|that|says|said|say|told \\w+|tell \\w+) )\\byou (?:should|ought to|need to|must|may want to|might want to|could|may|might)(?: (?:also|still|really|now|then))? (?:(?:consider|start|be) )?(?:${CALL}|${WAIT})`),
  /\b(?:now'?s|now is) the (?:time|moment) to (?:start |be )?(?:buy|sell|add|load up|stock up|accumulate|stack|get into|pick up)(?:ing)?\b/,
];

function directiveCalls(text) {
  const found = [];
  // Markdown and quote marks around a word don't hide it.
  const plain = text.replace(/[*_`"\u201c\u201d]/g, '');
  for (const sentence of plain.split(/[.!?;:\u2014\u2013](?=\s|[a-z])|\n+/)) {
    const start = sentence.replace(/^[^a-z0-9]+/, '');
    const m = DIRECTIVE_START.exec(start);
    if (m) found.push(m[0]);
  }
  for (const re of DIRECTIVE_ANYWHERE) {
    const m = re.exec(plain);
    if (m) found.push(m[0]);
  }
  return found;
}

// How far into a piece an opening can run. The banned openings only count
// when they start the piece, so a later "the real story" in a quote is fine.
const OPENING_CHARS = 160;

// Returns the banned phrases a written piece still uses, so the processor can
// set a feed reaction aside as a failed draft and log the rest. The prompt
// asks for this already. This checks what the model actually wrote.
function findTakeBreaks(text) {
  if (!text) return [];
  const lower = String(text).toLowerCase().replace(/[\u2018\u2019]/g, "'");
  const plain = lower.replace(/\s+/g, ' ');
  const opening = plain.replace(/^[^a-z0-9]+/, '').slice(0, OPENING_CHARS);
  return [
    ...BANNED_OPENINGS.filter(p => opening.includes(p)),
    ...BANNED_TRADE_CALLS.filter(p => usesCall(plain, p)),
    ...directiveCalls(lower.replace(/[ \t]+/g, ' ')),
  ];
}

// Strict on purpose. The prompt bans these phrases outright, so a draft that
// uses one, even to deny it, is set aside rather than risk passing a call
// like "never a bad time to buy". A phrase must end on a word break, so
// "buyback" isn't "buy".
function usesCall(plain, phrase) {
  let at = plain.indexOf(phrase);
  while (at >= 0) {
    if (!/[a-z0-9]/.test(plain[at + phrase.length] || '')) return true;
    at = plain.indexOf(phrase, at + 1);
  }
  return false;
}

module.exports = { TAKE_RULES, BANNED_OPENINGS, BANNED_TRADE_CALLS, findTakeBreaks };
