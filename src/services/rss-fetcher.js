const axios = require('axios');
const { XMLParser } = require('fast-xml-parser');
const supabase = require('../lib/supabase');

// ============================================
// RSS FEED SOURCES
// ============================================

const RSS_FEEDS = [
  { name: 'Kitco News', url: 'https://news.google.com/rss/search?q=gold+silver+precious+metals+site:kitco.com&hl=en-US&gl=US&ceid=US:en' },
  { name: 'Seeking Alpha PM', url: 'https://seekingalpha.com/tag/gold-and-precious-metals.xml' },
  { name: 'Mining.com', url: 'https://news.google.com/rss/search?q=gold+silver+mining+site:mining.com&hl=en-US&gl=US&ceid=US:en' },
  { name: 'Investing News', url: 'https://investingnews.com/category/daily/resource-investing/precious-metals-investing/feed/' },
  { name: 'Reuters Commodities', url: 'https://news.google.com/rss/search?q=gold+silver+commodities+site:reuters.com&hl=en-US&gl=US&ceid=US:en' },
  { name: 'Zero Hedge', url: 'https://feeds.feedburner.com/zerohedge/feed' },
  { name: 'Yahoo Finance PM', url: 'https://feeds.finance.yahoo.com/rss/2.0/headline?s=GC=F,SI=F&region=US&lang=en-US' },
  { name: 'Google News PM', url: 'https://news.google.com/rss/search?q=%22gold+price%22+OR+%22silver+price%22+OR+%22precious+metals%22+when:7d&hl=en-US&gl=US&ceid=US:en' },
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
};

/**
 * Extract actual publication name from an RSS item.
 * Priority: item.source text > URL domain lookup > feed name fallback.
 */
function extractSourceName(item, link, feedName) {
  // 1. RSS <source> element (Google News provides this)
  const srcField = item.source;
  if (srcField) {
    const text = typeof srcField === 'string' ? srcField : srcField['#text'];
    if (text && typeof text === 'string' && text.trim().length > 0) {
      return text.trim();
    }
  }

  // 2. Extract from link URL domain (more reliable than author fields)
  if (link) {
    try {
      const hostname = new URL(String(link)).hostname.replace(/^www\./, '');
      for (const [domain, name] of Object.entries(DOMAIN_TO_NAME)) {
        if (hostname === domain || hostname.endsWith('.' + domain)) {
          return name;
        }
      }
      // Unknown domain — capitalize first part
      const parts = hostname.split('.');
      const name = parts.length >= 2 ? parts[parts.length - 2] : parts[0];
      return name.charAt(0).toUpperCase() + name.slice(1) + '.' + parts[parts.length - 1];
    } catch (_) {}
  }

  // 3. Fallback to feed name
  return feedName;
}

// ============================================
// FETCH + PARSE
// ============================================

/**
 * Fetch new articles from all RSS feeds.
 * Filters: <24h old, not already in DB.
 * @returns {Array} Array of { title, link, pubDate, description, source }
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

  for (const feed of RSS_FEEDS) {
    try {
      const resp = await axios.get(feed.url, {
        timeout: 10000,
        headers: { 'User-Agent': 'StackTrackerGold/1.0 (RSS Aggregator)' },
      });

      const parsed = xmlParser.parse(resp.data);

      // Handle both RSS 2.0 and Atom feed structures
      let items = [];
      if (parsed.rss?.channel?.item) {
        items = Array.isArray(parsed.rss.channel.item) ? parsed.rss.channel.item : [parsed.rss.channel.item];
      } else if (parsed.feed?.entry) {
        items = Array.isArray(parsed.feed.entry) ? parsed.feed.entry : [parsed.feed.entry];
      }

      let feedCount = 0;
      for (const item of items) {
        const title = item.title || '';
        const link = item.link?.['@_href'] || item.link || '';
        const pubDateStr = item.pubDate || item.published || item.updated || '';
        const rawDescription = item.description || item.summary || item.content || '';

        // Clean HTML from description and truncate
        const description = String(rawDescription)
          .replace(/<[^>]*>/g, '')
          .replace(/&[a-z]+;/gi, ' ')
          .trim()
          .slice(0, 200);

        if (!title || !link) continue;

        // Parse date and filter >24h old
        const pubDate = pubDateStr ? new Date(pubDateStr) : new Date();
        if (pubDate < cutoff) continue;

        // Skip if URL or title already in DB
        if (existingUrls.has(link)) continue;
        if (existingTitles.has(String(title).toLowerCase().trim())) continue;

        allArticles.push({
          title: String(title).trim(),
          link: String(link).trim(),
          pubDate,
          description,
          source: extractSourceName(item, link, feed.name),
        });
        feedCount++;
      }

      console.log(`[RSS] ${feed.name}: ${feedCount} new articles`);
    } catch (err) {
      console.log(`[RSS] ${feed.name}: FAILED — ${err.message}`);
    }
  }

  console.log(`[RSS] Total new articles: ${allArticles.length}`);
  return allArticles;
}

module.exports = { fetchNewArticles, RSS_FEEDS };
