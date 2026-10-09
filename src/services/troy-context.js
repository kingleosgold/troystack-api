// What Troy knows about today before anyone asks: the date and time, each
// metal's move today, the latest Stack Signal synthesis (Troy's own read) and
// the newest Signal headlines. Without it Troy can name spot but not say what
// moved it, while the home page shows the day's take right beside him.
//
// The moves are read with every question from the price cache, which the
// price cron refreshes each minute, and they carry no price of their own, so
// the prompt's only current prices are its CURRENT SPOT. The Signal is dated
// to the minute and Troy is told its figures are as of then. The Signal and
// the headlines come from the database, each kept for five minutes, and a
// read that fails keeps the last good one and tries again in 30 seconds. No
// part may hold a question up for more than a second and a half: a read that
// runs longer gives way to the last good answer and finishes in the
// background. Every part is optional: a missing piece is left out, never
// guessed.

const TTL_MS = 5 * 60 * 1000;
const EMPTY_TTL_MS = 30 * 1000;
const WAIT_MS = 1500;
const METALS = ['gold', 'silver', 'platinum', 'palladium'];

// The Signal is written by a pipeline that sometimes uses long dashes, and
// Troy tends to echo the style he's shown, so they become commas here.
function plain(text) {
  return String(text || '')
    .replace(/(\d)\s*\u2013\s*(\d)/g, '$1-$2')
    .replace(/[ \t]*[\u2014\u2013]+[ \t]*/g, ', ')
    .replace(/,\s*,/g, ',')
    .replace(/\s+/g, ' ')
    .trim();
}

// Some stored one-liners were cut off after a word or two, like "Fed".
function usableOneLiner(text) {
  const t = plain(text);
  return t.split(' ').length >= 5 && t.length >= 25 ? t : '';
}

function usd(n) {
  return `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// The price itself is in the route's own part of the prompt, so a move line
// says only how far it went. The change is the same "today" figure the app
// shows, measured from the price cache's last reading of the previous day.
function moveLine(metal, price, change) {
  const name = metal.charAt(0).toUpperCase() + metal.slice(1);
  if (!(price > 0)) return null;
  const pct = Number(change?.percent);
  const amt = Number(change?.amount);
  if (!Number.isFinite(pct) || !Number.isFinite(amt)) return `${name}: today's change unavailable`;
  const dir = amt > 0 ? 'up' : amt < 0 ? 'down' : 'flat';
  if (dir === 'flat') return `${name}: flat today`;
  return `${name}: ${dir} ${usd(Math.abs(amt))} (${Math.abs(pct).toFixed(2)}%) today`;
}

function day(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/New_York' });
}

function dayAndTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' });
  return `${day(iso)}, ${time} ET`;
}

function nowLine(at) {
  const d = new Date(at);
  const date = d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/New_York' });
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' });
  return `RIGHT NOW: ${date}, ${time} ET.`;
}

/**
 * The prompt block, from what was fetched. Pure, for tests.
 * @param {{ spot?: { prices?: object, change?: object, marketsClosed?: boolean } | null,
 *           signal?: object | null, headlines?: object[], now?: number }} parts
 */
function buildMarketBlock({ spot, signal, headlines, now } = {}) {
  const sections = [];

  const prices = spot?.prices || {};
  // When the live price sources fail, the fetcher falls back to cached or
  // built-in prices, and its change is then measured from prices that aren't
  // today's. Those moves would be wrong, so they're left out.
  const trusted = !/fallback/i.test(String(spot?.source || ''));
  const moves = trusted ? METALS.map((m) => moveLine(m, Number(prices[m]), spot?.change?.[m])).filter(Boolean) : [];
  if (moves.length) {
    sections.push(`TODAY'S MARKET:\n${moves.join('\n')}${spot?.marketsClosed ? "\nMarkets are closed right now, so these are the last session's moves." : ''}`);
  }

  const hasSignal = Boolean(signal && signal.title);
  if (hasSignal) {
    const when = dayAndTime(signal.published_at);
    const take = usableOneLiner(signal.troy_one_liner) || plain(signal.troy_commentary).slice(0, 600);
    sections.push(
      `YOUR LATEST STACK SIGNAL${when ? ` (published ${when})` : ''}:\n${plain(signal.title)}${take ? `\n${take}` : ''}`,
    );
  }

  const lines = (Array.isArray(headlines) ? headlines : [])
    .filter((h) => h && h.title)
    .slice(0, 6)
    .map((h) => {
      const when = day(h.published_at);
      return `- ${plain(h.title)}${when ? ` (${when})` : ''}`;
    });
  if (lines.length) sections.push(`NEWEST HEADLINES IN THE STACK SIGNAL:\n${lines.join('\n')}`);

  if (!sections.length) return '';
  const head = Number.isFinite(now) ? `${nowLine(now)}\n\n` : '';
  const asOf = hasSignal
    ? ` Prices and moves in the Signal are as of when it was published. For where prices are now${moves.length ? " and how they've moved today, use only CURRENT SPOT and TODAY'S MARKET" : ', use only CURRENT SPOT'}.`
    : '';
  return `${head}${sections.join('\n\n')}\n\nWhen someone asks what moved metals or what's in the news, answer from these, and say how recent they are when it matters.${asOf} Don't invent headlines, numbers or dates beyond them.\n\n`;
}

/**
 * The block for one question: the moves read now, the Signal and headlines
 * from a read kept for five minutes.
 * @param {{ fetchSpot: () => Promise<object>, db: object, now?: () => number, waitMs?: number }} deps
 */
function createMarketContext({ fetchSpot, db, now = () => Date.now(), waitMs = WAIT_MS }) {
  // The read's answer, or the fallback once `waitMs` have passed. The read
  // carries on either way and updates what's kept when it lands.
  function waitAtMost(promise, fallback) {
    let timer;
    const late = new Promise((resolve) => {
      timer = setTimeout(() => resolve(fallback()), waitMs);
    });
    return Promise.race([promise, late]).finally(() => clearTimeout(timer));
  }

  async function latestSignal() {
    const { data, error } = await db
      .from('stack_signal_articles')
      .select('title, troy_one_liner, troy_commentary, published_at')
      .eq('is_stack_signal', true)
      .order('published_at', { ascending: false })
      .limit(1);
    if (error) throw error;
    return (data && data[0]) || null;
  }

  // Syntheses are filtered out in the query, before the limit, since several
  // editions a day (daily, evening, weekly, recap) could otherwise fill it.
  async function newestHeadlines() {
    const { data, error } = await db
      .from('stack_signal_articles')
      .select('title, published_at')
      .or('is_stack_signal.is.null,is_stack_signal.eq.false')
      .order('published_at', { ascending: false })
      .limit(6);
    if (error) throw error;
    return data || [];
  }

  // One database read kept for five minutes. Questions that arrive while it
  // runs share it, so a burst makes one read, not one per question. A read
  // that fails keeps the last good answer and is tried again in 30 seconds.
  function keptRead(read, label, empty) {
    let value = empty;
    let at = null;
    let ok = false;
    let inFlight = null;
    return function get() {
      if (at !== null && now() - at < (ok ? TTL_MS : EMPTY_TTL_MS)) return Promise.resolve(value);
      if (!inFlight) {
        inFlight = read()
          .then(
            (v) => {
              value = v;
              ok = true;
              return v;
            },
            (e) => {
              console.log(`[Troy Context] ${label} unavailable: ${e.message}`);
              ok = false;
              return value;
            },
          )
          .finally(() => {
            at = now();
            inFlight = null;
          });
      }
      return waitAtMost(inFlight, () => value);
    };
  }

  const signalPart = keptRead(latestSignal, 'Signal', null);
  const headlinesPart = keptRead(newestHeadlines, 'Headlines', []);
  let spotInFlight = null;

  function currentSpot() {
    if (!spotInFlight) {
      spotInFlight = Promise.resolve()
        .then(fetchSpot)
        .catch((e) => {
          console.log(`[Troy Context] Spot unavailable: ${e.message}`);
          return null;
        })
        .finally(() => {
          spotInFlight = null;
        });
    }
    return waitAtMost(spotInFlight, () => null);
  }

  return async function getMarketBlock() {
    const [spot, signal, headlines] = await Promise.all([currentSpot(), signalPart(), headlinesPart()]);
    return buildMarketBlock({ spot, signal, headlines, now: now() });
  };
}

// One shared instance for the visitor route and the signed-in chat, so they
// share the cache. Loaded lazily so tests of the pure parts need no database.
let shared = null;
function sharedMarketBlock() {
  if (!shared) {
    const supabase = require('../lib/supabase');
    const { getSpotPrices } = require('./price-fetcher');
    shared = createMarketContext({ fetchSpot: getSpotPrices, db: supabase });
  }
  return shared();
}

module.exports = { buildMarketBlock, createMarketContext, sharedMarketBlock, plain, usableOneLiner };
