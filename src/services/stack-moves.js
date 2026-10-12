// How a user's stack moved over the last day, week and month, for Troy.
//
// Each window is priced from spot history in price_log, on the holdings the
// user already had when the window opened, so a coin bought yesterday doesn't
// show up as a gain this week. These are spot moves before premiums, the same
// basis as the stack value Troy is given.

const supabase = require('../lib/supabase');

const METALS = ['gold', 'silver', 'platinum', 'palladium'];
const DAY_MS = 86400000;

// Platinum and palladium stay out of the moves for now. When their quotes
// fail, the price fetcher carries the last known value forward under the
// same source as gold and silver and logs it to price_log, and their older
// history is still waiting on the Pt/Pd backfill. A move built on those rows
// could be invented, so each window names them instead.
const UNTRACKED = ['platinum', 'palladium'];

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

// The current spot the moves are measured to. A static or failed-over price
// set against real history would invent a gain or loss, so only a quote from
// a live source counts, or a recent close while the markets are shut.
function liveSpot(spot, now = new Date()) {
  if (!spot || !spot.prices) return null;
  if (/static-fallback|cached-fallback/.test(String(spot.source || ''))) return null;
  const at = new Date(spot.timestamp);
  if (Number.isNaN(at.getTime()) || now.getTime() - at.getTime() > MAX_STALE_MS) return null;
  return spot.prices;
}

const NO_LIVE_SPOT = 'STACK MOVES:\nCurrent spot isn\'t live right now, so don\'t estimate a daily, weekly or monthly move.\n\n';

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
// stack totals count them. A plain calendar date has no time, so the holding
// counts from the end of that day, and one bought on the day a window opens
// stays out of that window.
function heldAt(holding, when) {
  if (!holding.purchase_date) return true;
  const bought = new Date(holding.purchase_date);
  if (Number.isNaN(bought.getTime())) return true;
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(String(holding.purchase_date).trim());
  const heldFrom = dateOnly ? bought.getTime() + DAY_MS : bought.getTime();
  return heldFrom <= when.getTime();
}

// Same ounce math as the stack totals in routes/troy-chat.js.
function ouncesOf(holding) {
  return (holding.weight || 0) * (holding.quantity || 1);
}

/**
 * @param {Array} holdings rows with metal, weight, quantity, purchase_date
 * @param {object} prices current spot by metal
 * @param {Date} now
 * @returns {Promise<Array>} one entry per window, priced or marked unavailable
 */
async function getStackMoves(holdings, prices, now = new Date()) {
  const moves = [];
  for (const w of WINDOWS) {
    const start = new Date(now.getTime() - w.days * DAY_MS);
    const then = await spotAt(start);
    if (!then) {
      // No price row near the window's start. The window still gets a line,
      // so a question about it isn't answered from the other windows.
      moves.push({ key: w.key, label: w.label, unavailable: true, noHistory: true, missing: [], untracked: [] });
      continue;
    }

    let before = 0;
    let after = 0;
    const metals = {};
    // Held metals with no price then or now. They stay out of the sums, and
    // the window says so, so a partial number isn't read as the whole stack.
    const missing = new Set();
    const untracked = new Set();
    for (const h of holdings || []) {
      const m = h.metal;
      if (!METALS.includes(m) || !heldAt(h, start)) continue;
      const oz = ouncesOf(h);
      if (!(oz > 0)) continue;
      if (UNTRACKED.includes(m)) {
        untracked.add(m);
        continue;
      }
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
    if (!(before > 0)) {
      // Nothing in the window could be priced. Keep the window when held
      // metals were left out, so Troy can say which ones instead of falling
      // back to a generic no-history note.
      moves.push({
        key: w.key,
        label: w.label,
        since: then.timestamp,
        unavailable: true,
        // Nothing left out means nothing was held yet when the window opened.
        nothingHeld: !missing.size && !untracked.size,
        missing: METALS.filter(m => missing.has(m)),
        untracked: METALS.filter(m => untracked.has(m)),
      });
      continue;
    }

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
      untracked: METALS.filter(m => untracked.has(m)),
    });
  }
  return moves;
}

const money = n => `${n < 0 ? '-' : '+'}$${Math.abs(n).toFixed(2)}`;
const pct = n => `${n < 0 ? '-' : '+'}${Math.abs(n).toFixed(1)}%`;
const name = m => m.charAt(0).toUpperCase() + m.slice(1);

const listOf = names => (names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);

// "Platinum" or "Platinum and palladium", capitalized once at the front.
const metalList = metals => {
  const list = listOf(metals);
  return list.charAt(0).toUpperCase() + list.slice(1);
};

function untrackedNote(untracked) {
  if (!untracked || !untracked.length) return '';
  return untracked.length === 1
    ? ` ${metalList(untracked)} isn't counted in these moves yet, since its price history isn't reliable.`
    : ` ${metalList(untracked)} aren't counted in these moves yet, since their price history isn't reliable.`;
}

function missingNote(missing) {
  if (!missing || !missing.length) return '';
  return missing.length === 1
    ? ` ${metalList(missing)} isn't counted, since there's no price to compare it with.`
    : ` ${metalList(missing)} aren't counted, since there's no price to compare them with.`;
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
    if (mv.noHistory) {
      return `- ${mv.label}: no price history covers this window, so don't estimate a move.`;
    }
    if (mv.nothingHeld) {
      return `- ${mv.label}: nothing in the stack was held yet when this window opened.`;
    }
    if (mv.unavailable) {
      return `- ${mv.label}: no move to give.${missingNote(mv.missing)}${untrackedNote(mv.untracked)}`;
    }
    const metals = Object.entries(mv.metals)
      .map(([m, p]) => `${name(m)} $${p.from.toFixed(2)} to $${p.to.toFixed(2)}`)
      .join(', ');
    return `- ${mv.label}: ${money(mv.change)} (${pct(mv.pct)}). ${metals}.${missingNote(mv.missing)}${untrackedNote(mv.untracked)}`;
  });
  return 'STACK MOVES (spot moves on what the user already held, before premiums):\n'
    + lines.join('\n')
    + '\nHoldings bought inside a window aren\'t counted in that window.\n\n';
}

module.exports = { getStackMoves, formatStackMoves, liveSpot, NO_LIVE_SPOT, WINDOWS, _spotAt: spotAt };
