// The RSS fetch drops items already written up. It used to read the whole
// articles table, which the API caps at 1,000 rows in no set order, so some
// written links came back as new. It now reads a week of articles.
//   node --test

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const Module = require('node:module');

const reads = [];
const fakeSupabase = {
  from(table) {
    const q = { table, filters: {} };
    const api = {
      select(cols) { q.select = cols; return api; },
      gte(col, val) { q.filters[`${col}>=`] = val; return api; },
      then(resolve, reject) {
        reads.push(q);
        const data = [
          { title: 'Gold holds as the dollar slips', sources: [{ url: 'https://example.com/written' }] },
          // Saved without Google News' publisher tag. The feed still prints it.
          { title: 'Gold steady as yields rise', sources: [{ url: 'https://news.google.com/rss/articles/one', title: 'Gold steady as yields rise - Reuters' }] },
          // Troy's own title over another feed's headline. That headline isn't a written-up title.
          { title: 'Mints run short of silver', sources: [{ url: 'https://example.com/column-1', title: 'Weekly silver column' }] },
        ];
        return Promise.resolve({ data, error: null }).then(resolve, reject);
      },
    };
    return api;
  },
};

const file = require.resolve(path.join(__dirname, '..', 'src/lib/supabase'));
const m = new Module(file, null);
m.filename = file;
m.loaded = true;
m.exports = fakeSupabase;
require.cache[file] = m;

const axios = require('axios');
const { fetchNewArticles, RSS_FEEDS } = require('../src/services/rss-fetcher');

test('items already written up, undated or misdated are dropped, from a read of the last week only', async () => {
  const now = new Date();
  const feed = `<?xml version="1.0"?><rss><channel>
    <item><title>Gold holds as the dollar slips</title><link>https://example.com/written</link><pubDate>${now.toUTCString()}</pubDate><description>Spot steady</description></item>
    <item><title>Gold steady as yields rise - Reuters</title><link>https://news.google.com/rss/articles/two</link><pubDate>${now.toUTCString()}</pubDate><description>Same story, new link</description></item>
    <item><title>Weekly silver column</title><link>https://example.com/column-2</link><pubDate>${now.toUTCString()}</pubDate><description>This week's column</description></item>
    <item><title>Gold steady as yields rise - Yahoo Finance</title><link>https://news.google.com/rss/articles/three</link><pubDate>${now.toUTCString()}</pubDate><description>Same wire story</description></item>
    <item><title>Silver tops $60 - Reuters</title><link>https://news.google.com/rss/articles/four</link><pubDate>${now.toUTCString()}</pubDate><description>New story</description></item>
    <item><title>Silver tops $60 - Kitco</title><link>https://news.google.com/rss/articles/five</link><pubDate>${now.toUTCString()}</pubDate><description>Same story, other publisher</description></item>
    <item><title>Central banks keep buying gold</title><link>https://example.com/new</link><pubDate>${now.toUTCString()}</pubDate><description>Purchases continue</description></item>
    <item><title>Silver demand hits a record</title><link>https://example.com/undated</link><description>No date on this one</description></item>
    <item><title>Mints ration silver bars</title><link>https://example.com/bad-date</link><pubDate>sometime last week</pubDate><description>Unparseable date</description></item>
  </channel></rss>`;

  const real = axios.get;
  axios.get = async url => ({ data: url === RSS_FEEDS[0].url ? feed : '<rss><channel></channel></rss>' });
  try {
    const items = await fetchNewArticles();
    assert.deepStrictEqual(items.map(i => i.link).sort(), ['https://example.com/column-2', 'https://example.com/new', 'https://news.google.com/rss/articles/four']);
  } finally {
    axios.get = real;
  }

  assert.strictEqual(reads.length, 1);
  assert.strictEqual(reads[0].table, 'stack_signal_articles');
  const since = Date.parse(reads[0].filters['published_at>=']);
  const week = 7 * 24 * 60 * 60 * 1000;
  assert.ok(Math.abs(Date.now() - since - week) < 60 * 1000, 'reads one week back');
});
