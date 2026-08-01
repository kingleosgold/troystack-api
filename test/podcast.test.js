// Tests for podcast v1 — script building and feed XML structure.
//   node --test
// Pure-function tests only; live episode generation is exercised by
// scripts/generate-episode.js (needs XAI_API_KEY + podcast_episodes table).

const test = require('node:test');
const assert = require('node:assert');
const { XMLParser, XMLValidator } = require('fast-xml-parser');

require('dotenv').config(); // src/lib/supabase.js (transitively required) needs env at load

const { stripMarkdown, buildEpisodeScript, buildEpisodeDescription } = require('../src/services/podcast');
const { buildFeedXml } = require('../src/routes/podcast');

test('stripMarkdown removes links, headers, bold, italic, code', () => {
  const md = '## Headline\n\n**Gold** hit *records*. See [COMEX data](https://example.com/x) and `spot`.\n\n_Also_ __this__.';
  const out = stripMarkdown(md);
  assert.strictEqual(out, 'Headline\n\nGold hit records. See COMEX data and spot.\n\nAlso this.');
});

test('buildEpisodeScript wraps body with exact intro and outro', () => {
  const article = {
    title: 'The Stack Signal — July 31, 2026',
    troy_commentary: '**Gold** is up.',
    published_at: '2026-07-31T11:15:00+00:00',
  };
  const script = buildEpisodeScript(article);
  assert.ok(script.startsWith("This is The Stack Signal for July 31, 2026. I'm Troy. Here's what matters in metals today."));
  assert.ok(script.endsWith("That's the signal. The Stack Signal is generated daily by Troy, TroyStack's AI analyst. Track your own stack — TroyStack on the App Store, or troystack.com."));
  assert.ok(script.includes('Gold is up.'), 'body present, markdown stripped');
});

test('buildEpisodeDescription = one-liner + first paragraph', () => {
  const d = buildEpisodeDescription({
    troy_one_liner: 'Silver squeeze continues.',
    troy_commentary: 'First paragraph here.\n\nSecond paragraph ignored.',
  });
  assert.strictEqual(d, 'Silver squeeze continues.\n\nFirst paragraph here.');
});

const FIXTURE_EPISODES = [{
  slug: 'the-stack-signal-2026-07-31',
  audio_url: 'https://example.supabase.co/storage/v1/object/public/troy-podcast/episodes/the-stack-signal-2026-07-31.mp3',
  audio_bytes: 4180000,
  duration_sec: 261,
  title: 'The Stack Signal — July 31, 2026',
  description: 'Gains & losses <today>.\n\nFirst paragraph.',
  published_at: '2026-07-31T11:15:00+00:00',
}];

test('feed.xml is well-formed with required channel + episode tags', () => {
  const xml = buildFeedXml(FIXTURE_EPISODES);
  assert.strictEqual(XMLValidator.validate(xml), true, 'XML must be well-formed');

  const parsed = new XMLParser({ ignoreAttributes: false, cdataPropName: '__cdata' }).parse(xml);
  const ch = parsed.rss.channel;
  assert.strictEqual(parsed.rss['@_version'], '2.0');
  assert.strictEqual(ch.title, 'The Stack Signal: Daily Gold & Silver Brief');
  assert.strictEqual(ch['itunes:author'], 'TroyStack');
  assert.strictEqual(ch['itunes:owner']['itunes:email'], 'support@troystack.com');
  assert.ok(String(ch.description.__cdata).includes("Hosted by Troy, TroyStack's AI market analyst. Episodes are AI-generated daily from live market data."));
  assert.strictEqual(ch.language, 'en-us');
  assert.strictEqual(String(ch['itunes:explicit']), 'false');
  assert.strictEqual(ch['itunes:category']['@_text'], 'Business');
  assert.strictEqual(ch['itunes:category']['itunes:category']['@_text'], 'Investing');
  assert.ok(ch['itunes:image']['@_href'].includes('troy-podcast/artwork.png'));

  const item = ch.item;
  assert.strictEqual(item.title, 'The Stack Signal — July 31, 2026');
  assert.strictEqual(item.enclosure['@_url'], FIXTURE_EPISODES[0].audio_url);
  assert.strictEqual(Number(item.enclosure['@_length']), FIXTURE_EPISODES[0].audio_bytes);
  assert.strictEqual(item.enclosure['@_type'], 'audio/mpeg');
  assert.strictEqual(item.guid['#text'], 'the-stack-signal-2026-07-31');
  assert.strictEqual(String(item.guid['@_isPermaLink']), 'false');
  assert.strictEqual(item['itunes:duration'], 261);
  assert.ok(new Date(item.pubDate).toISOString().startsWith('2026-07-31T11:15:00'));
});

test('feed.xml handles empty episode list', () => {
  const xml = buildFeedXml([]);
  assert.strictEqual(XMLValidator.validate(xml), true);
});
