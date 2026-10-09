// What Troy knows about today before anyone asks: each metal's move since the
// last close, the latest Stack Signal synthesis (Troy's own daily read) and
// the newest Signal headlines. Without it Troy can name spot but not say what
// moved it, while the home page shows the day's take right beside him.
//
// Built once and kept for five minutes, so a question costs no extra reads.
// Every part is optional: a missing piece is left out, never guessed.

const TTL_MS = 5 * 60 * 1000;
const EMPTY_TTL_MS = 30 * 1000;
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

function moveLine(metal, price, change) {
  const name = metal.charAt(0).toUpperCase() + metal.slice(1);
  if (!(price > 0)) return null;
  const pct = Number(change?.percent);
  const amt = Number(change?.amount);
  if (!Number.isFinite(pct) || !Number.isFinite(amt)) return `${name}: ${usd(price)}, change since the last close unavailable`;
  const dir = amt > 0 ? 'up' : amt < 0 ? 'down' : 'flat';
  if (dir === 'flat') return `${name}: ${usd(price)}, flat since the last close`;
  return `${name}: ${usd(price)}, ${dir} ${usd(Math.abs(amt))} (${Math.abs(pct).toFixed(2)}%) since the last close`;
}

function day(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/New_York' });
}

/**
 * The prompt block, from what was fetched. Pure, for tests.
 * @param {{ spot?: { prices?: object, change?: object, marketsClosed?: boolean } | null,
 *           signal?: object | null, headlines?: object[] }} parts
 */
function buildMarketBlock({ spot, signal, headlines } = {}) {
  const sections = [];

  const prices = spot?.prices || {};
  const moves = METALS.map((m) => moveLine(m, Number(prices[m]), spot?.change?.[m])).filter(Boolean);
  if (moves.length) {
    sections.push(`TODAY'S MARKET:\n${moves.join('\n')}${spot?.marketsClosed ? '\nMarkets are closed right now, so these are the last prices.' : ''}`);
  }

  if (signal && signal.title) {
    const when = day(signal.published_at);
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
  return `${sections.join('\n\n')}\n\nWhen someone asks what moved metals or what's in the news, answer from these, and say how recent they are when it matters. Don't invent headlines, numbers or dates beyond them.\n\n`;
}

/**
 * The block, cached for five minutes.
 * @param {{ fetchSpot: () => Promise<object>, db: object, now?: () => number }} deps
 */
function createMarketContext({ fetchSpot, db, now = () => Date.now() }) {
  let cache = { at: 0, block: null };

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

  // Questions that arrive while a refresh is running share it, so a burst at
  // the five-minute mark makes one set of reads, not one per question.
  let inFlight = null;

  async function refresh() {
    const [spot, signal, headlines] = await Promise.all([
      fetchSpot().catch((e) => {
        console.log(`[Troy Context] Spot unavailable: ${e.message}`);
        return null;
      }),
      latestSignal().catch((e) => {
        console.log(`[Troy Context] Signal unavailable: ${e.message}`);
        return null;
      }),
      newestHeadlines().catch((e) => {
        console.log(`[Troy Context] Headlines unavailable: ${e.message}`);
        return [];
      }),
    ]);
    const block = buildMarketBlock({ spot, signal, headlines });
    cache = { at: now(), block };
    return block;
  }

  return async function getMarketBlock() {
    // An empty block, when everything failed, is only kept for half a minute.
    const ttl = cache.block ? TTL_MS : EMPTY_TTL_MS;
    if (cache.block !== null && now() - cache.at < ttl) return cache.block;
    if (!inFlight) {
      inFlight = refresh().finally(() => {
        inFlight = null;
      });
    }
    return inFlight;
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
