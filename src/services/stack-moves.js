// How a user's stack moved over the last day, week and month, for Troy.
//
// Each window is priced from spot history in price_log, on the holdings the
// user already had when the window opened, so a coin bought yesterday doesn't
// show up as a gain this week. These are spot moves before premiums, the same
// basis as the stack value Troy is given.

const supabase = require('../lib/supabase');

const METALS = ['gold', 'silver', 'platinum', 'palladium'];
const DAY_MS = 86400000;

// How far before a window's start a price_log row may sit and still stand in
// for it. Weekends and holidays leave no rows, so a few days of slack is
// normal. A longer gap means the logger was down, and the window is skipped
// rather than labeled with a price from weeks earlier.
const MAX_STALE_MS = 4 * DAY_MS;

const WINDOWS = [
  { key: 'day', label: 'Last 24 hours', days: 1 },
  { key: 'week', label: 'Last 7 days', days: 7 },
  { key: 'month', label: 'Last 30 days', days: 30 },
];

// The last price_log row at or before `when`, no more than MAX_STALE_MS
// earlier. Older rows are thinned to hourly and daily ones, so the nearest
// earlier row is the honest price.
async function spotAt(when) {
  const { data, error } = await supabase
    .from('price_log')
    .select('timestamp, gold_price, silver_price, platinum_price, palladium_price')
    .gte('timestamp', new Date(when.getTime() - MAX_STALE_MS).toISOString())
    .lte('timestamp', when.toISOString())
    .order('timestamp', { ascending: false })
    .limit(1);
  if (error || !data || !data.length) return null;
  const row = data[0];
  return {
    timestamp: row.timestamp,
    gold: Number(row.gold_price) || 0,
    silver: Number(row.silver_price) || 0,
    platinum: Number(row.platinum_price) || 0,
    palladium: Number(row.palladium_price) || 0,
  };
}

// Holdings with no usable purchase date count as held, the same way the
// stack totals count them.
function heldAt(holding, when) {
  if (!holding.purchase_date) return true;
  const bought = new Date(holding.purchase_date);
  return Number.isNaN(bought.getTime()) ? true : bought <= when;
}

// Same ounce math as the stack totals in routes/troy-chat.js.
function ouncesOf(holding) {
  return (holding.weight || 0) * (holding.quantity || 1);
}

/**
 * @param {Array} holdings rows with metal, weight, quantity, purchase_date
 * @param {object} prices current spot by metal
 * @param {Date} now
 * @returns {Promise<Array>} one entry per window that has price history
 */
async function getStackMoves(holdings, prices, now = new Date()) {
  const moves = [];
  for (const w of WINDOWS) {
    const start = new Date(now.getTime() - w.days * DAY_MS);
    const then = await spotAt(start);
    if (!then) continue;

    let before = 0;
    let after = 0;
    const metals = {};
    // Held metals with no price then or now. They stay out of the sums, and
    // the window says so, so a partial number isn't read as the whole stack.
    const missing = new Set();
    for (const h of holdings || []) {
      const m = h.metal;
      if (!METALS.includes(m) || !heldAt(h, start)) continue;
      const oz = ouncesOf(h);
      if (!(oz > 0)) continue;
      const from = then[m];
      const to = Number(prices?.[m]) || 0;
      if (!(from > 0) || !(to > 0)) {
        missing.add(m);
        continue;
      }
      before += oz * from;
      after += oz * to;
      metals[m] = { from, to };
    }
    if (!(before > 0)) continue;

    moves.push({
      key: w.key,
      label: w.label,
      since: then.timestamp,
      before,
      after,
      change: after - before,
      pct: ((after - before) / before) * 100,
      metals,
      missing: METALS.filter(m => missing.has(m)),
    });
  }
  return moves;
}

const money = n => `${n < 0 ? '-' : '+'}$${Math.abs(n).toFixed(2)}`;
const pct = n => `${n < 0 ? '-' : '+'}${Math.abs(n).toFixed(1)}%`;
const name = m => m.charAt(0).toUpperCase() + m.slice(1);

function missingNote(missing) {
  if (!missing || !missing.length) return '';
  const names = missing.map(name);
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  return names.length === 1
    ? ` ${list} isn't counted, since there's no price to compare it with.`
    : ` ${list} aren't counted, since there's no price to compare them with.`;
}

/**
 * The STACK MOVES block for Troy's prompt, ending in a blank line so it
 * drops in ahead of the next section.
 */
function formatStackMoves(moves) {
  if (!moves || !moves.length) {
    return 'STACK MOVES:\nThere isn\'t enough price history to give a daily, weekly or monthly move for these holdings, so don\'t estimate one.\n\n';
  }
  const lines = moves.map(mv => {
    const metals = Object.entries(mv.metals)
      .map(([m, p]) => `${name(m)} $${p.from.toFixed(2)} to $${p.to.toFixed(2)}`)
      .join(', ');
    return `- ${mv.label}: ${money(mv.change)} (${pct(mv.pct)}). ${metals}.${missingNote(mv.missing)}`;
  });
  return 'STACK MOVES (spot moves on what the user already held, before premiums):\n'
    + lines.join('\n')
    + '\nHoldings bought inside a window aren\'t counted in that window.\n\n';
}

module.exports = { getStackMoves, formatStackMoves, WINDOWS, _spotAt: spotAt };
