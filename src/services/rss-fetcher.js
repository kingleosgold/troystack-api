const axios = require('axios');
const { XMLParser } = require('fast-xml-parser');
const supabase = require('../lib/supabase');

// ============================================
// RSS FEED SOURCES (~45 feeds)
// ============================================

// Google News query helper
function gNewsQuery(q, category) {
  return { name: `Google News: ${q}`, url: `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`, category };
}

const RSS_FEEDS = [
  // ── Original 8 feeds ──
  { name: 'Kitco News', url: 'https://news.google.com/rss/search?q=gold+silver+precious+metals+site:kitco.com&hl=en-US&gl=US&ceid=US:en', category: 'Gold' },
  { name: 'Seeking Alpha PM', url: 'https://seekingalpha.com/tag/gold-and-precious-metals.xml', category: 'Market Data' },
  { name: 'Mining.com (GNews)', url: 'https://news.google.com/rss/search?q=gold+silver+mining+site:mining.com&hl=en-US&gl=US&ceid=US:en', category: 'Mining' },
  { name: 'Investing News', url: 'https://investingnews.com/category/daily/resource-investing/precious-metals-investing/feed/', category: 'Market Data' },
  { name: 'Reuters (GNews)', url: 'https://news.google.com/rss/search?q=gold+silver+commodities+site:reuters.com&hl=en-US&gl=US&ceid=US:en', category: 'Market Data' },
  { name: 'Zero Hedge', url: 'https://feeds.feedburner.com/zerohedge/feed', category: 'Macro' },
  { name: 'Yahoo Finance PM', url: 'https://feeds.finance.yahoo.com/rss/2.0/headline?s=GC=F,SI=F&region=US&lang=en-US', category: 'Market Data' },
  { name: 'Google News PM', url: 'https://news.google.com/rss/search?q=%22gold+price%22+OR+%22silver+price%22+OR+%22precious+metals%22+when:7d&hl=en-US&gl=US&ceid=US:en', category: 'Market Data' },

  // ── Direct RSS feeds ──
  { name: 'Mining.com', url: 'https://www.mining.com/feed/', category: 'Mining' },
  { name: 'Silver Doctors', url: 'https://www.silverdoctors.com/feed/', category: 'Silver' },
  { name: 'GoldSeek', url: 'https://goldseek.com/rss.xml', category: 'Gold' },
  { name: 'BullionStar', url: 'https://www.bullionstar.com/blogs/feed/', category: 'Market Data' },
  { name: 'Mises Institute', url: 'https://mises.org/rss.xml', category: 'Macro' },
  { name: 'Sprott Insights', url: 'https://sprott.com/insights/rss/', category: 'Mining' },
  { name: 'Gold Telegraph', url: 'https://goldtelegraph.com/feed', category: 'Gold' },
  { name: 'MarketWatch Commodities', url: 'https://feeds.content.dowjones.io/public/rss/mw_marketpulse', category: 'Market Data' },
  { name: 'Reuters Commodities', url: 'https://www.reutersagency.com/feed/?best-topics=commodities&post_type=best', category: 'Market Data' },
  { name: 'CNBC Commodities', url: 'https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=10000108', category: 'Market Data' },
  { name: 'ZeroHedge Direct', url: 'https://feeds.feedburner.com/zerohedge/feed', category: 'Macro' },

  // ── Google News query feeds ──
  gNewsQuery('gold price', 'Gold'),
  gNewsQuery('silver price', 'Silver'),
  gNewsQuery('precious metals', 'Market Data'),
  gNewsQuery('central bank gold', 'Gold'),
  gNewsQuery('COMEX silver', 'Silver'),
  gNewsQuery('Federal Reserve inflation', 'Macro'),
  gNewsQuery('dollar debasement', 'Macro'),
  gNewsQuery('sound money', 'Macro'),
  gNewsQuery('mining acquisition', 'Mining'),
  gNewsQuery('silver shortage', 'Silver'),
  gNewsQuery('physical silver demand', 'Silver'),
  gNewsQuery('gold backed dollar', 'Macro'),
  gNewsQuery('Treasury Secretary Bessent', 'Macro'),
  gNewsQuery('Fed rate decision', 'Macro'),
  gNewsQuery('CPI inflation', 'Macro'),
  gNewsQuery('PPI inflation', 'Macro'),
  gNewsQuery('constitutional money', 'Macro'),
  gNewsQuery('gold miners', 'Mining'),
  gNewsQuery('silver miners', 'Mining'),
  gNewsQuery('central bank buying gold', 'Gold'),
  gNewsQuery('China gold reserves', 'Geopolitical'),
  gNewsQuery('Russia gold reserves', 'Geopolitical'),
];

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  parseAttributeValue: true,
});

// ============================================
// SOURCE NAME EXTRACTION
// ============================================

const DOMAIN_TO_NAME = {
  'reuters.com': 'Reuters',
  'kitco.com': 'Kitco News',
  'bloomberg.com': 'Bloomberg',
  'seekingalpha.com': 'Seeking Alpha',
  'zerohedge.com': 'Zero Hedge',
  'cnbc.com': 'CNBC',
  'mining.com': 'Mining.com',
  'investingnews.com': 'Investing News',
  'yahoo.com': 'Yahoo Finance',
  'finance.yahoo.com': 'Yahoo Finance',
  'wsj.com': 'Wall Street Journal',
  'ft.com': 'Financial Times',
  'barrons.com': "Barron's",
  'marketwatch.com': 'MarketWatch',
  'bullionstar.com': 'BullionStar',
  'goldseek.com': 'GoldSeek',
  'silverseek.com': 'SilverSeek',
  'schiffgold.com': 'SchiffGold',
  'bullionvault.com': 'BullionVault',
  'sprottmoney.com': 'Sprott Money',
  'goldprice.org': 'GoldPrice.org',
  'jmbullion.com': 'JM Bullion',
  'apmex.com': 'APMEX',
  'moneymetals.com': 'Money Metals Exchange',
  'cnn.com': 'CNN',
  'bbc.com': 'BBC',
  'nytimes.com': 'New York Times',
  'washingtonpost.com': 'Washington Post',
  'foxbusiness.com': 'Fox Business',
  'investing.com': 'Investing.com',
  'silverdoctors.com': 'Silver Doctors',
  'goldtelegraph.com': 'Gold Telegraph',
  'mises.org': 'Mises Institute',
  'sprott.com': 'Sprott',
};

function extractSourceName(item, link, feedName) {
  const srcField = item.source;
  if (srcField) {
    const text = typeof srcField === 'string' ? srcField : srcField['#text'];
    if (text && typeof text === 'string' && text.trim().length > 0) {
      return text.trim();
    }
  }

  if (link) {
    try {
      const hostname = new URL(String(link)).hostname.replace(/^www\./, '');
      for (const [domain, name] of Object.entries(DOMAIN_TO_NAME)) {
        if (hostname === domain || hostname.endsWith('.' + domain)) {
          return name;
        }
      }
      const parts = hostname.split('.');
      const name = parts.length >= 2 ? parts[parts.length - 2] : parts[0];
      return name.charAt(0).toUpperCase() + name.slice(1) + '.' + parts[parts.length - 1];
    } catch (_) {}
  }

  return feedName;
}

// ============================================
// SIGNAL SCORING
// ============================================

const HIGH_AUTHORITY_SOURCES = ['Bloomberg', 'Reuters', 'Wall Street Journal', 'Kitco News', 'Financial Times'];
const MID_AUTHORITY_SOURCES = ['Mining.com', 'Silver Doctors', 'Zero Hedge', 'CNBC', 'MarketWatch', 'Seeking Alpha'];
const SIGNAL_KEYWORDS = ['gold', 'silver', 'fed', 'inflation', 'comex', 'central bank', 'treasury', 'bessent', 'schiff', 'hunter'];
const BREAKING_KEYWORDS = ['breaking', 'surge', 'plunge', 'crash', 'rally', 'record', 'announce', 'decision', 'cut', 'hike', 'emergency'];

/**
 * Score an article for signal strength (0-100).
 * Higher = more relevant/urgent for Stack Signal.
 */
function scoreArticle(item, existingTitles) {
  let score = 40; // base

  // Source authority
  const src = (item.source || '').toLowerCase();
  if (HIGH_AUTHORITY_SOURCES.some(s => src.includes(s.toLowerCase()))) score += 20;
  else if (MID_AUTHORITY_SOURCES.some(s => src.includes(s.toLowerCase()))) score += 10;
  else if (item._isGoogleNews) score += 5;

  // Keyword density (cap +30)
  const text = `${item.title} ${item.description}`.toLowerCase();
  let keywordHits = 0;
  for (const kw of SIGNAL_KEYWORDS) {
    if (text.includes(kw)) keywordHits++;
  }
  score += Math.min(keywordHits * 10, 30);

  // Recency
  if (item.pubDate) {
    const ageMs = Date.now() - item.pubDate.getTime();
    if (ageMs < 60 * 60 * 1000) score += 10;       // <1 hour
    else if (ageMs < 6 * 60 * 60 * 1000) score += 5; // <6 hours
  }

  // Breaking keywords
  const titleLower = (item.title || '').toLowerCase();
  if (BREAKING_KEYWORDS.some(kw => titleLower.includes(kw))) score += 20;

  // Novelty penalty — simple word overlap with existing titles
  if (existingTitles && existingTitles.size > 0) {
    const words = new Set(titleLower.split(/\s+/).filter(w => w.length > 3));
    for (const existing of existingTitles) {
      const existingWords = new Set(existing.split(/\s+/).filter(w => w.length > 3));
      if (existingWords.size === 0 || words.size === 0) continue;
      const overlap = [...words].filter(w => existingWords.has(w)).length;
      const similarity = overlap / Math.max(words.size, existingWords.size);
      if (similarity > 0.6) {
        score -= 20;
        break;
      }
    }
  }

  return Math.max(0, Math.min(100, score));
}

// ============================================
// FETCH + PARSE
// ============================================

/**
 * Fetch a single RSS feed with timeout. Returns parsed items array or [].
 */
async function fetchSingleFeed(feed) {
  const resp = await axios.get(feed.url, {
    timeout: 10000,
    headers: { 'User-Agent': 'TroyStack/1.0 (RSS Aggregator; contact support@troystack.com)' },
  });

  const parsed = xmlParser.parse(resp.data);
  let items = [];
  if (parsed.rss?.channel?.item) {
    items = Array.isArray(parsed.rss.channel.item) ? parsed.rss.channel.item : [parsed.rss.channel.item];
  } else if (parsed.feed?.entry) {
    items = Array.isArray(parsed.feed.entry) ? parsed.feed.entry : [parsed.feed.entry];
  }
  return items;
}

/**
 * Fetch new articles from all RSS feeds in parallel.
 * Filters: <24h old, not already in DB. Scores each article.
 * @returns {Array} Array of { title, link, pubDate, description, source, signal_score, category }
 */
async function fetchNewArticles() {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const allArticles = [];

  // Fetch existing URLs and titles from DB to deduplicate
  let existingUrls = new Set();
  let existingTitles = new Set();
  try {
    const { data } = await supabase
      .from('stack_signal_articles')
      .select('sources, title');

    if (data) {
      for (const row of data) {
        if (row.title) existingTitles.add(row.title.toLowerCase().trim());
        const sources = row.sources || [];
        for (const src of sources) {
          if (src.url) existingUrls.add(src.url);
        }
      }
    }
    console.log(`[RSS] Dedup loaded: ${existingUrls.size} URLs, ${existingTitles.size} titles`);
  } catch (err) {
    console.log(`[RSS] Could not check existing articles: ${err.message}`);
  }

  // Fetch all feeds in parallel
  const feedResults = await Promise.allSettled(
    RSS_FEEDS.map(async (feed) => {
      try {
        const items = await fetchSingleFeed(feed);
        return { feed, items };
      } catch (err) {
        console.log(`[RSS] ${feed.name}: FAILED — ${err.message}`);
        return { feed, items: [] };
      }
    })
  );

  let totalFetched = 0;
  let totalNew = 0;

  for (const result of feedResults) {
    if (result.status !== 'fulfilled') continue;
    const { feed, items } = result.value;
    let feedCount = 0;

    for (const item of items) {
      const title = item.title || '';
      const link = item.link?.['@_href'] || item.link || '';
      const pubDateStr = item.pubDate || item.published || item.updated || '';
      const rawDescription = item.description || item.summary || item.content || '';

      const description = String(rawDescription)
        .replace(/<[^>]*>/g, '')
        .replace(/&[a-z]+;/gi, ' ')
        .trim()
        .slice(0, 200);

      if (!title || !link) continue;

      const pubDate = pubDateStr ? new Date(pubDateStr) : new Date();
      if (pubDate < cutoff) continue;

      if (existingUrls.has(link)) continue;
      if (existingTitles.has(String(title).toLowerCase().trim())) continue;

      const article = {
        title: String(title).trim(),
        link: String(link).trim(),
        pubDate,
        description,
        source: extractSourceName(item, link, feed.name),
        category: feed.category || 'macro',
        _isGoogleNews: feed.url.includes('news.google.com'),
      };

      article.signal_score = scoreArticle(article, existingTitles);
      allArticles.push(article);
      feedCount++;
    }

    totalFetched++;
    totalNew += feedCount;
    if (feedCount > 0) console.log(`[RSS] ${feed.name}: ${feedCount} new`);
  }

  // Sort by signal score descending
  allArticles.sort((a, b) => b.signal_score - a.signal_score);

  const passingThreshold = allArticles.filter(a => a.signal_score >= 50).length;
  console.log(`[RSS] Fetched ${totalFetched}/${RSS_FEEDS.length} feeds | ${totalNew} new items | ${passingThreshold} passing signal threshold (>=50)`);

  return allArticles;
}

module.exports = { fetchNewArticles, scoreArticle, RSS_FEEDS };
