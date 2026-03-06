const cheerio = require('cheerio');
const axios = require('axios');

// Affiliate IDs from env (empty string = no affiliate param yet)
const AFFILIATE_IDS = {
  apmex: process.env.APMEX_AFFILIATE_ID || '',
  jmbullion: process.env.JMB_AFFILIATE_ID || '',
  sdbullion: process.env.SDB_AFFILIATE_ID || '',
};

// Build affiliate URL - append param only if ID exists
function buildAffiliateUrl(baseUrl, dealer) {
  const id = AFFILIATE_IDS[dealer];
  if (!id) return baseUrl;
  const separator = baseUrl.includes('?') ? '&' : '?';
  const paramMap = {
    apmex: `custid=${id}`,
    jmbullion: `ref=${id}`,
    sdbullion: `afmc=${id}`,
  };
  return `${baseUrl}${separator}${paramMap[dealer]}`;
}

// Products to track: { id, name, metal, weight_oz, urls: { dealer: scrapeUrl } }
const PRODUCTS = [
  {
    id: 'silver-eagle-1oz',
    name: '1 oz American Silver Eagle',
    metal: 'silver',
    weight_oz: 1,
    urls: {
      apmex: 'https://www.apmex.com/product/86880/1-oz-silver-american-eagle-coin-bu',
      jmbullion: 'https://www.jmbullion.com/1-oz-silver-american-eagle-coin/',
      sdbullion: 'https://sdbullion.com/1-oz-american-silver-eagle',
    }
  },
  {
    id: 'silver-maple-1oz',
    name: '1 oz Canadian Silver Maple Leaf',
    metal: 'silver',
    weight_oz: 1,
    urls: {
      apmex: 'https://www.apmex.com/product/85813/1-oz-silver-canadian-maple-leaf-coin-bu',
      jmbullion: 'https://www.jmbullion.com/1-oz-silver-canadian-maple-leaf-coin/',
      sdbullion: 'https://sdbullion.com/1-oz-canadian-silver-maple-leaf',
    }
  },
  {
    id: 'silver-round-1oz',
    name: '1 oz Silver Round (Generic)',
    metal: 'silver',
    weight_oz: 1,
    urls: {
      apmex: 'https://www.apmex.com/product/139/1-oz-silver-round',
      jmbullion: 'https://www.jmbullion.com/1-oz-silver-rounds/',
      sdbullion: 'https://sdbullion.com/1-oz-silver-rounds',
    }
  },
  {
    id: 'silver-bar-10oz',
    name: '10 oz Silver Bar',
    metal: 'silver',
    weight_oz: 10,
    urls: {
      apmex: 'https://www.apmex.com/product/154/10-oz-silver-bar-secondary-market',
      jmbullion: 'https://www.jmbullion.com/10-oz-silver-bar/',
      sdbullion: 'https://sdbullion.com/10-oz-silver-bars',
    }
  },
  {
    id: 'gold-eagle-1oz',
    name: '1 oz American Gold Eagle',
    metal: 'gold',
    weight_oz: 1,
    urls: {
      apmex: 'https://www.apmex.com/product/85814/1-oz-gold-american-eagle-coin-bu',
      jmbullion: 'https://www.jmbullion.com/1-oz-gold-american-eagle-coin/',
      sdbullion: 'https://sdbullion.com/1-oz-gold-american-eagle-coin',
    }
  },
  {
    id: 'gold-maple-1oz',
    name: '1 oz Canadian Gold Maple Leaf',
    metal: 'gold',
    weight_oz: 1,
    urls: {
      apmex: 'https://www.apmex.com/product/85816/1-oz-gold-canadian-maple-leaf-coin-bu',
      jmbullion: 'https://www.jmbullion.com/1-oz-gold-canadian-maple-leaf-coin/',
      sdbullion: 'https://sdbullion.com/1-oz-gold-canadian-maple-leaf',
    }
  },
  {
    id: 'gold-bar-1oz',
    name: '1 oz Gold Bar',
    metal: 'gold',
    weight_oz: 1,
    urls: {
      apmex: 'https://www.apmex.com/product/186/1-oz-gold-bar-secondary-market',
      jmbullion: 'https://www.jmbullion.com/1-oz-gold-bars/',
      sdbullion: 'https://sdbullion.com/1-oz-gold-bars',
    }
  },
];

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.5',
};

// --- Scraper functions per dealer ---

async function scrapeApmex(url) {
  const { data } = await axios.get(url, { headers: HEADERS, timeout: 10000 });
  const $ = cheerio.load(data);
  // APMEX uses structured data - try JSON-LD first
  let price = null;
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const json = JSON.parse($(el).html());
      if (json.offers && json.offers.price) {
        price = parseFloat(json.offers.price);
      }
    } catch {}
  });
  // Fallback: look for price in DOM
  if (!price) {
    const priceText = $('.pricing-value').first().text().trim();
    price = parseFloat(priceText.replace(/[^0-9.]/g, ''));
  }
  return isNaN(price) ? null : price;
}

async function scrapeJmbullion(url) {
  const { data } = await axios.get(url, { headers: HEADERS, timeout: 10000 });
  const $ = cheerio.load(data);
  let price = null;
  // JM Bullion uses JSON-LD
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const json = JSON.parse($(el).html());
      if (json.offers && json.offers.price) {
        price = parseFloat(json.offers.price);
      }
    } catch {}
  });
  if (!price) {
    const priceText = $('[class*="price"]').first().text().trim();
    price = parseFloat(priceText.replace(/[^0-9.]/g, ''));
  }
  return isNaN(price) ? null : price;
}

async function scrapeSdbullion(url) {
  const { data } = await axios.get(url, { headers: HEADERS, timeout: 10000 });
  const $ = cheerio.load(data);
  let price = null;
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const json = JSON.parse($(el).html());
      if (json.offers && json.offers.price) {
        price = parseFloat(json.offers.price);
      }
      if (json['@graph']) {
        json['@graph'].forEach(item => {
          if (item.offers && item.offers.price) {
            price = parseFloat(item.offers.price);
          }
        });
      }
    } catch {}
  });
  if (!price) {
    const priceText = $('[class*="price"]').first().text().trim();
    price = parseFloat(priceText.replace(/[^0-9.]/g, ''));
  }
  return isNaN(price) ? null : price;
}

const SCRAPERS = {
  apmex: scrapeApmex,
  jmbullion: scrapeJmbullion,
  sdbullion: scrapeSdbullion,
};

const DEALER_NAMES = {
  apmex: 'APMEX',
  jmbullion: 'JM Bullion',
  sdbullion: 'SD Bullion',
};

// Main scrape function — returns array of rows ready for Supabase insert
async function scrapeAllDealers(spotPrices) {
  const results = [];

  for (const product of PRODUCTS) {
    const spotPrice = spotPrices[product.metal] || null;

    for (const [dealerKey, scrapeUrl] of Object.entries(product.urls)) {
      try {
        const scraper = SCRAPERS[dealerKey];
        if (!scraper) continue;

        const price = await scraper(scrapeUrl);
        if (!price) {
          console.log(`[DealerScraper] No price found: ${dealerKey} ${product.id}`);
          continue;
        }

        const premiumPct = spotPrice
          ? parseFloat((((price - spotPrice) / spotPrice) * 100).toFixed(2))
          : null;

        const affiliateUrl = buildAffiliateUrl(scrapeUrl, dealerKey);

        results.push({
          dealer: DEALER_NAMES[dealerKey],
          product_name: product.name,
          metal: product.metal,
          weight_oz: product.weight_oz,
          price,
          premium_pct: premiumPct,
          product_url: affiliateUrl,
          scraped_at: new Date().toISOString(),
        });

        console.log(`[DealerScraper] ${DEALER_NAMES[dealerKey]} ${product.name}: $${price}`);

        // Be polite — 500ms between requests
        await new Promise(r => setTimeout(r, 500));

      } catch (err) {
        console.error(`[DealerScraper] Failed ${dealerKey} ${product.id}:`, err.message);
      }
    }
  }

  return results;
}

module.exports = { scrapeAllDealers, PRODUCTS, DEALER_NAMES };
