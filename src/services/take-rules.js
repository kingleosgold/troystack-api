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

// How far into a piece an opening can run. The banned openings only count
// when they start the piece, so a later "the real story" in a quote is fine.
const OPENING_CHARS = 160;

// Returns the banned phrases a written piece still uses, so the processor can
// set a feed reaction aside as a failed draft and log the rest. The prompt
// asks for this already. This checks what the model actually wrote.
function findTakeBreaks(text) {
  if (!text) return [];
  const plain = String(text).toLowerCase().replace(/[\u2018\u2019]/g, "'").replace(/\s+/g, ' ');
  const opening = plain.replace(/^[^a-z0-9]+/, '').slice(0, OPENING_CHARS);
  return [
    ...BANNED_OPENINGS.filter(p => opening.includes(p)),
    ...BANNED_TRADE_CALLS.filter(p => plain.includes(p)),
  ];
}

module.exports = { TAKE_RULES, BANNED_OPENINGS, BANNED_TRADE_CALLS, findTakeBreaks };
