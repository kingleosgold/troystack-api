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
// A read still running after this long is taken as hung and a fresh one starts.
const STALL_MS = 10 * 1000;
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
 * @param {{ spot?: { prices?: object, change?: object, marketsClosed?: boolean, source?: string, quotedAt?: string | null } | null,
 *           signal?: object | null, headlines?: object[], now?: number }} parts
 */
function buildMarketBlock({ spot, signal, headlines, now } = {}) {
  const sections = [];

  const prices = spot?.prices || {};
  // When the live price sources fail, the fetcher falls back to cached or
  // built-in prices, and its change is then measured from prices that aren't
  // today's. Those moves would be wrong, so they're left out.
  const source = String(spot?.source || '');
  const trusted = !/fallback/i.test(source);
  const moves = trusted ? METALS.map((m) => moveLine(m, Number(prices[m]), spot?.change?.[m])).filter(Boolean) : [];
  if (moves.length) {
    sections.push(`TODAY'S MARKET:\n${moves.join('\n')}${spot?.marketsClosed ? "\nMarkets are closed right now, so these are the last session's moves." : ''}`);
  }
  // The live feeds are down, so CURRENT SPOT isn't today's price. Built-in
  // prices aren't market prices at all, and cached ones are only as fresh as
  // when they were last read live, the reading's quotedAt. Its timestamp
  // moves with every failed fetch, so it isn't used here.
  const stale = Boolean(spot) && !trusted;
  if (stale) {
    const when = /static/i.test(source) || !spot.quotedAt ? '' : dayAndTime(spot.quotedAt);
    sections.push(
      /static/i.test(source)
        ? "PRICES RIGHT NOW: The live price feeds are down, so CURRENT SPOT holds placeholder numbers, not market prices. Don't quote them. If someone asks where prices are, say live prices aren't available this minute and to check back shortly."
        : `PRICES RIGHT NOW: The live price feeds are down, so CURRENT SPOT is the last price read${when ? `, ${when}` : ''}, and may be out of date. Say so when you use it.`,
    );
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
  const asOf = !hasSignal
    ? ''
    : stale
      ? ' Prices and moves in the Signal are as of when it was published, and live prices are unavailable right now.'
      : ` Prices and moves in the Signal are as of when it was published. For where prices are now${moves.length ? " and how they've moved today, use only CURRENT SPOT and TODAY'S MARKET" : ', use only CURRENT SPOT'}.`;
  return `${head}${sections.join('\n\n')}\n\nWhen someone asks what moved metals or what's in the news, answer from these, and say how recent they are when it matters.${asOf} Don't invent headlines, numbers or dates beyond them.\n\n`;
}

/**
 * The block for one question: the moves read now, the Signal and headlines
 * from a read kept for five minutes.
 * @param {{ fetchSpot: () => Promise<object>, db: object, now?: () => number, waitMs?: number }} deps
 */
function createMarketContext({ fetchSpot, db, now = () => Date.now(), waitMs = WAIT_MS, stallMs = STALL_MS }) {
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
  // A read that hangs is given up on after stallMs, so the next question
  // starts a fresh one, and an answer that lands after a newer read's is
  // ignored.
  function keptRead(read, label, empty) {
    let value = empty;
    let at = null;
    let ok = false;
    let inFlight = null;
    let startedAt = 0;
    let started = 0;
    let landed = 0;
    return function get() {
      if (at !== null && now() - at < (ok ? TTL_MS : EMPTY_TTL_MS)) return Promise.resolve(value);
      if (inFlight && now() - startedAt >= stallMs) {
        console.log(`[Troy Context] ${label} read still running after ${stallMs} ms, starting another`);
        inFlight = null;
      }
      if (!inFlight) {
        const n = ++started;
        startedAt = now();
        const current = Promise.resolve()
          .then(read)
          .then(
            (v) => {
              if (n > landed) {
                landed = n;
                value = v;
                ok = true;
                at = now();
              }
              return value;
            },
            (e) => {
              console.log(`[Troy Context] ${label} unavailable: ${e.message}`);
              if (n > landed) {
                landed = n;
                ok = false;
                at = now();
              }
              return value;
            },
          )
          .finally(() => {
            if (inFlight === current) inFlight = null;
          });
        inFlight = current;
      }
      return waitAtMost(inFlight, () => value);
    };
  }

  const signalPart = keptRead(latestSignal, 'Signal', null);
  const headlinesPart = keptRead(newestHeadlines, 'Headlines', []);
  let spotInFlight = null;
  let spotStartedAt = 0;

  // Questions that arrive during a spot read share it. One that hangs is
  // given up on after stallMs, like the database reads.
  function currentSpot() {
    if (spotInFlight && now() - spotStartedAt >= stallMs) spotInFlight = null;
    if (!spotInFlight) {
      spotStartedAt = now();
      const current = Promise.resolve()
        .then(fetchSpot)
        .catch((e) => {
          console.log(`[Troy Context] Spot unavailable: ${e.message}`);
          return null;
        })
        .finally(() => {
          if (spotInFlight === current) spotInFlight = null;
        });
      spotInFlight = current;
    }
    return waitAtMost(spotInFlight, () => null);
  }

  // A route that already read spot for its CURRENT SPOT passes that reading,
  // so the moves come from the same snapshot as the prices beside them.
  return async function getMarketBlock(spotSnapshot) {
    const spotRead = spotSnapshot && spotSnapshot.prices ? Promise.resolve(spotSnapshot) : currentSpot();
    const [spot, signal, headlines] = await Promise.all([spotRead, signalPart(), headlinesPart()]);
    return buildMarketBlock({ spot, signal, headlines, now: now() });
  };
}

// One shared instance for the visitor route and the signed-in chat, so they
// share the cache. Loaded lazily so tests of the pure parts need no database.
let shared = null;
function sharedMarketBlock(spotSnapshot) {
  if (!shared) {
    const supabase = require('../lib/supabase');
    const { getSpotPrices } = require('./price-fetcher');
    shared = createMarketContext({ fetchSpot: getSpotPrices, db: supabase });
  }
  return shared(spotSnapshot);
}

module.exports = { buildMarketBlock, createMarketContext, sharedMarketBlock, plain, usableOneLiner };
