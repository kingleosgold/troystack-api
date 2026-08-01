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
    title: 'The Stack Signal — January 31, 1999',
    troy_commentary: '**Gold** is up.',
    published_at: '1999-01-31T11:15:00+00:00',
  };
  const script = buildEpisodeScript(article);
  assert.ok(script.startsWith("This is The Stack Signal for January 31, 1999. I'm Troy. Here's what matters in metals today."));
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

// Pure in-memory fixture — 1999 dates by policy: no test may reference a
// real/current date slug, so a grep for current-year dates stays clean.
const FIXTURE_EPISODES = [{
  slug: 'the-stack-signal-1999-01-31',
  audio_url: 'https://example.supabase.co/storage/v1/object/public/troy-podcast/episodes/the-stack-signal-1999-01-31.mp3',
  audio_bytes: 4180000,
  duration_sec: 261,
  title: 'The Stack Signal — January 31, 1999',
  description: 'Gains & losses <today>.\n\nFirst paragraph.',
  published_at: '1999-01-31T11:15:00+00:00',
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
  assert.strictEqual(item.title, 'The Stack Signal — January 31, 1999');
  assert.strictEqual(item.enclosure['@_url'], FIXTURE_EPISODES[0].audio_url);
  assert.strictEqual(Number(item.enclosure['@_length']), FIXTURE_EPISODES[0].audio_bytes);
  assert.strictEqual(item.enclosure['@_type'], 'audio/mpeg');
  assert.strictEqual(item.guid['#text'], 'the-stack-signal-1999-01-31');
  assert.strictEqual(String(item.guid['@_isPermaLink']), 'false');
  assert.strictEqual(item['itunes:duration'], 261);
  assert.ok(new Date(item.pubDate).toISOString().startsWith('1999-01-31T11:15:00'));
});

test('feed.xml handles empty episode list', () => {
  const xml = buildFeedXml([]);
  assert.strictEqual(XMLValidator.validate(xml), true);
});

// ── Integration tests (real table + bucket; skipped without env) ──
//
// FIXTURE-ONLY policy: every row/object these tests touch lives on a 1999
// fixture date — impossible in production (the pipeline launched in 2026).
// NAMESPACE CLEANUP: the 1999 namespace is test-owned by invariant, so each
// finally block deletes its fixture-slug resources UNCONDITIONALLY (episode
// row, storage object at the fixture path, fixture article) — even a
// mid-test crash leaves nothing behind. FAIL-LOUD: the pre-check still
// guards run START — if a fixture unexpectedly already exists the test
// fails with a clear message and deletes nothing (cleanup is skipped by the
// assertion throwing before any insert).

// Asserts the fixture identified by (table, column, value) does not already
// exist. Returns nothing; throws the fail-loud message on surprise.
async function assertFixtureAbsent(supabase, table, value) {
  const { data, error } = await supabase.from(table).select('slug').eq('slug', value).maybeSingle();
  assert.ifError(error && new Error(`${table} pre-check failed: ${error.message}`));
  assert.strictEqual(
    data,
    null,
    `SURPRISE: fixture "${value}" already exists in ${table}. Refusing to run and deleting nothing — inspect and remove it manually.`
  );
}

test('feed route excludes pending stubs (audio_bytes=0)', { skip: !hasEnv && 'SUPABASE env not configured' }, async () => {
  const supabase = require('../src/lib/supabase');
  const express = require('express');
  const STUB_SLUG = 'the-stack-signal-1999-01-01'; // fixture date — cannot exist in production

  // Fail-loud pre-check BEFORE the try/finally: a surprise leftover throws
  // here, so the unconditional cleanup below never runs — nothing deleted.
  await assertFixtureAbsent(supabase, 'podcast_episodes', STUB_SLUG);

  try {
    const { error: insErr } = await supabase.from('podcast_episodes').insert({
      slug: STUB_SLUG,
      audio_url: 'https://example.invalid/stub.mp3',
      audio_bytes: 0,
      duration_sec: 0,
      title: 'TEST FIXTURE — reservation stub, must never appear in feed',
      description: 'podcast integration-test fixture (safe to delete)',
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
    // Namespace cleanup: fixture slug is test-owned — delete unconditionally.
    await supabase.from('podcast_episodes').delete().eq('slug', STUB_SLUG);
  }
});

// Insert a clearly-labeled fixture article for a 1999 fixture date.
async function insertFixtureArticle(supabase, slug, date) {
  const { error } = await supabase.from('stack_signal_articles').insert({
    slug,
    title: 'TEST FIXTURE — podcast integration article (safe to delete)',
    troy_commentary: '**Test** fixture body.\n\nSecond paragraph for description checks.',
    troy_one_liner: 'Podcast integration-test fixture.',
    category: 'macro',
    is_stack_signal: false,
    relevance_score: 0,
    signal_score: 0,
    urgent: false,
    published_at: `${date}T11:15:00+00:00`,
  });
  assert.ifError(error && new Error(`fixture article insert failed: ${error.message}`));
}

// Namespace cleanup for one fixture slug: episode row, storage object at the
// fixture path, fixture article — unconditional (the 1999 namespace is
// test-owned by invariant; removing absent resources is a no-op).
async function cleanupFixtureSlug(supabase, BUCKET, slug) {
  await supabase.from('podcast_episodes').delete().eq('slug', slug);
  await supabase.storage.from(BUCKET).remove([`episodes/${slug}.mp3`]);
  await supabase.from('stack_signal_articles').delete().eq('slug', slug);
}

// Stubbed grok.tts returning controllable fake audio; returns handles.
function stubTts(grok) {
  const { Readable } = require('node:stream');
  const state = { calls: 0, bytes: Buffer.alloc(1024, 1), throwWith: null, real: grok.tts };
  grok.tts = async () => {
    state.calls += 1;
    if (state.throwWith) throw new Error(state.throwWith);
    return { audioStream: Readable.from([state.bytes]), costCents: 0, provider: 'grok', model: 'stub', charCount: 0 };
  };
  return state;
}

test('reserve-first: double generate = one provider call; --force updates in place', { skip: !hasEnv && 'SUPABASE env not configured' }, async () => {
  const supabase = require('../src/lib/supabase');
  const grok = require('../src/services/voice-providers/grok');
  const { generateEpisode, BUCKET } = require('../src/services/podcast');

  const DATE = '1999-01-02'; // fixture date — cannot exist in production
  const SLUG = `the-stack-signal-${DATE}`;

  // Fail-loud pre-checks BEFORE the try/finally: on surprise, throw here and
  // the unconditional cleanup never runs — nothing deleted.
  await assertFixtureAbsent(supabase, 'stack_signal_articles', SLUG);
  await assertFixtureAbsent(supabase, 'podcast_episodes', SLUG);

  const tts = stubTts(grok);
  try {
    await insertFixtureArticle(supabase, SLUG, DATE);

    const first = await generateEpisode({ date: DATE });
    assert.strictEqual(first.created, true, 'first call publishes');
    assert.strictEqual(first.audioBytes, 1024);
    assert.strictEqual(tts.calls, 1);

    const second = await generateEpisode({ date: DATE });
    assert.strictEqual(second.skipped, true, 'second call exits at reservation');
    assert.match(second.reason, /already generated/);
    assert.strictEqual(tts.calls, 1, 'no second provider call');

    tts.bytes = Buffer.alloc(2048, 2);
    const forced = await generateEpisode({ date: DATE, force: true });
    assert.strictEqual(forced.created, true, '--force regenerates');
    assert.strictEqual(forced.audioBytes, 2048);
    assert.strictEqual(tts.calls, 2);

    const { data: row } = await supabase.from('podcast_episodes')
      .select('audio_bytes, duration_sec').eq('slug', SLUG).single();
    assert.strictEqual(row.audio_bytes, 2048, 'row updated in place');
    assert.strictEqual(row.duration_sec, Math.round(2048 / 16000));
  } finally {
    grok.tts = tts.real;
    await cleanupFixtureSlug(supabase, BUCKET, SLUG);
  }
});

test('stub reclaim: a failed attempt is retryable without --force', { skip: !hasEnv && 'SUPABASE env not configured' }, async () => {
  const supabase = require('../src/lib/supabase');
  const grok = require('../src/services/voice-providers/grok');
  const { generateEpisode, BUCKET } = require('../src/services/podcast');

  const DATE = '1999-01-03'; // fixture date — cannot exist in production
  const SLUG = `the-stack-signal-${DATE}`;

  await assertFixtureAbsent(supabase, 'stack_signal_articles', SLUG);
  await assertFixtureAbsent(supabase, 'podcast_episodes', SLUG);

  const tts = stubTts(grok);
  try {
    await insertFixtureArticle(supabase, SLUG, DATE);

    // Simulated provider outage AFTER reservation: generateEpisode throws,
    // leaving a stub row (audio_bytes=0).
    tts.throwWith = 'simulated provider outage';
    await assert.rejects(generateEpisode({ date: DATE }), /simulated provider outage/);
    const { data: stub } = await supabase.from('podcast_episodes')
      .select('audio_bytes').eq('slug', SLUG).single();
    assert.strictEqual(stub.audio_bytes, 0, 'failed attempt leaves a stub');

    // Any later invocation reclaims the stub WITHOUT --force.
    tts.throwWith = null;
    tts.calls = 0;
    const reclaimed = await generateEpisode({ date: DATE });
    assert.strictEqual(reclaimed.created, true, 'stub reclaimed as winner');
    assert.strictEqual(tts.calls, 1, 'exactly one provider call for the reclaim');
    const { data: row } = await supabase.from('podcast_episodes')
      .select('audio_bytes').eq('slug', SLUG).single();
    assert.strictEqual(row.audio_bytes, 1024, 'row updated with real audio');
  } finally {
    grok.tts = tts.real;
    await cleanupFixtureSlug(supabase, BUCKET, SLUG);
  }
});

test('sweepRecentEpisodes heals stub/missing dates, skips completed', { skip: !hasEnv && 'SUPABASE env not configured' }, async () => {
  const supabase = require('../src/lib/supabase');
  const grok = require('../src/services/voice-providers/grok');
  const { generateEpisode, sweepRecentEpisodes, BUCKET } = require('../src/services/podcast');

  // Four fixture dates, one per sweep case. The dates override keeps the
  // sweep inside the test-owned 1999 namespace (never real/current dates).
  const D_STUB = '1999-01-04';    // article + stub row → generated (reclaim)
  const D_MISSING = '1999-01-05'; // article, no episode row → generated
  const D_DONE = '1999-01-06';    // article + completed row → skipped-complete
  const D_NOART = '1999-01-07';   // no article → no-article
  const ALL = [D_STUB, D_MISSING, D_DONE, D_NOART];
  const slugOf = (d) => `the-stack-signal-${d}`;

  for (const d of ALL) {
    await assertFixtureAbsent(supabase, 'stack_signal_articles', slugOf(d));
    await assertFixtureAbsent(supabase, 'podcast_episodes', slugOf(d));
  }

  const tts = stubTts(grok);
  try {
    for (const d of [D_STUB, D_MISSING, D_DONE]) await insertFixtureArticle(supabase, slugOf(d), d);

    const { error: stubErr } = await supabase.from('podcast_episodes').insert({
      slug: slugOf(D_STUB), audio_url: 'https://example.invalid/stub.mp3',
      audio_bytes: 0, duration_sec: 0,
      title: 'TEST FIXTURE — stub', description: 'fixture', published_at: `${D_STUB}T11:15:00+00:00`,
    });
    assert.ifError(stubErr && new Error(stubErr.message));
    const { error: doneErr } = await supabase.from('podcast_episodes').insert({
      slug: slugOf(D_DONE), audio_url: 'https://example.invalid/done.mp3',
      audio_bytes: 500, duration_sec: 1,
      title: 'TEST FIXTURE — completed', description: 'fixture', published_at: `${D_DONE}T11:15:00+00:00`,
    });
    assert.ifError(doneErr && new Error(doneErr.message));

    const results = await sweepRecentEpisodes(ALL.length, { dates: ALL });
    const byDate = Object.fromEntries(results.map((r) => [r.date, r.action]));
    assert.strictEqual(byDate[D_STUB], 'generated', 'stub row is healed');
    assert.strictEqual(byDate[D_MISSING], 'generated', 'missing row is generated');
    assert.strictEqual(byDate[D_DONE], 'skipped-complete', 'completed episode untouched');
    assert.strictEqual(byDate[D_NOART], 'no-article');
    assert.strictEqual(tts.calls, 2, 'exactly two provider calls (stub + missing)');
  } finally {
    grok.tts = tts.real;
    for (const d of ALL) await cleanupFixtureSlug(supabase, BUCKET, slugOf(d));
  }
});
