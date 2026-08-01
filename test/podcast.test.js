// Tests for podcast v1 — script building and feed XML structure.
//   node --test
// Pure-function tests only; live episode generation is exercised by
// scripts/generate-episode.js (needs XAI_API_KEY + podcast_episodes table).

const test = require('node:test');
const assert = require('node:assert');
const { XMLParser, XMLValidator } = require('fast-xml-parser');

require('dotenv').config(); // real env first when present (shell or .env)
// hasEnv gates the integration tests below (real table + bucket) and MUST be
// computed before the dummy defaults. Dummies keep module load safe in a
// clean checkout (src/lib/supabase.js createClient throws with no env).
const hasEnv = !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
process.env.SUPABASE_URL ||= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-dummy-service-role-key';

const { stripMarkdown, buildEpisodeScript, buildEpisodeDescription, PODCAST_VOICE } = require('../src/services/podcast');
const { buildFeedXml } = require('../src/routes/podcast');

test('podcast voice is pinned to leo', () => {
  assert.strictEqual(PODCAST_VOICE, 'leo');
});

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

// ── Integration tests (real table + bucket; skipped without env) ──

test('feed route excludes pending stubs (audio_bytes=0)', { skip: !hasEnv && 'SUPABASE env not configured' }, async () => {
  const supabase = require('../src/lib/supabase');
  const express = require('express');
  const STUB_SLUG = 'the-stack-signal-1999-01-01'; // no such article; clearly a test row
  try {
    const { error: insErr } = await supabase.from('podcast_episodes').insert({
      slug: STUB_SLUG,
      audio_url: 'https://example.invalid/stub.mp3',
      audio_bytes: 0,
      duration_sec: 0,
      title: 'STUB — must never appear in feed',
      description: 'reservation stub',
      published_at: '1999-01-01T00:00:00+00:00',
    });
    assert.ifError(insErr && new Error(insErr.message));

    const app = express();
    app.use('/v1/podcast', require('../src/routes/podcast'));
    const server = app.listen(0);
    try {
      const r = await fetch(`http://127.0.0.1:${server.address().port}/v1/podcast/feed.xml`);
      const xml = await r.text();
      assert.strictEqual(r.status, 200);
      assert.ok(!xml.includes(STUB_SLUG), 'stub row must not appear in feed.xml');
    } finally {
      server.close();
    }
  } finally {
    await supabase.from('podcast_episodes').delete().eq('slug', STUB_SLUG);
  }
});

test('reserve-first: double generate = one provider call; --force updates in place', { skip: !hasEnv && 'SUPABASE env not configured' }, async () => {
  const { Readable } = require('node:stream');
  const supabase = require('../src/lib/supabase');
  const grok = require('../src/services/voice-providers/grok');
  const { generateEpisode, BUCKET } = require('../src/services/podcast');

  // 2026-07-30 has a real flagship article and no published episode; the fake
  // audio + row are fully cleaned up in finally.
  const DATE = '2026-07-30';
  const SLUG = `the-stack-signal-${DATE}`;
  const realTts = grok.tts;
  let ttsCalls = 0;
  let fakeBytes = Buffer.alloc(1024, 1);
  grok.tts = async () => {
    ttsCalls += 1;
    return { audioStream: Readable.from([fakeBytes]), costCents: 0, provider: 'grok', model: 'stub', charCount: 0 };
  };

  try {
    const first = await generateEpisode({ date: DATE });
    assert.strictEqual(first.created, true, 'first call publishes');
    assert.strictEqual(first.audioBytes, 1024);
    assert.strictEqual(ttsCalls, 1);

    const second = await generateEpisode({ date: DATE });
    assert.strictEqual(second.skipped, true, 'second call exits at reservation');
    assert.match(second.reason, /already reserved\/generated/);
    assert.strictEqual(ttsCalls, 1, 'no second provider call');

    fakeBytes = Buffer.alloc(2048, 2);
    const forced = await generateEpisode({ date: DATE, force: true });
    assert.strictEqual(forced.created, true, '--force regenerates');
    assert.strictEqual(forced.audioBytes, 2048);
    assert.strictEqual(ttsCalls, 2);

    const { data: row } = await supabase.from('podcast_episodes')
      .select('audio_bytes, duration_sec').eq('slug', SLUG).single();
    assert.strictEqual(row.audio_bytes, 2048, 'row updated in place');
    assert.strictEqual(row.duration_sec, Math.round(2048 / 16000));
  } finally {
    grok.tts = realTts;
    await supabase.from('podcast_episodes').delete().eq('slug', SLUG);
    await supabase.storage.from(BUCKET).remove([`episodes/${SLUG}.mp3`]);
  }
});
