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

// ── Integration tests (real table + bucket) ──
//
// FIXTURE-ONLY policy: every row/object these tests touch lives on a 1999
// fixture date — impossible in production (the pipeline launched in 2026).
// NAMESPACE CLEANUP: the 1999 namespace is test-owned by invariant, so each
// finally block deletes its fixture-slug resources UNCONDITIONALLY — even a
// mid-test crash leaves nothing behind. FAIL-LOUD: pre-checks run BEFORE the
// try/finally, so a surprise leftover throws first and cleanup never runs —
// fail loud, delete nothing.
//
// Skips: no SUPABASE env (clean checkout) → skip; env present but migration
// 005 not applied (status column missing) → skip with instructions.

let statusReadyPromise;
function statusReady() {
  if (!statusReadyPromise) {
    statusReadyPromise = (async () => {
      const supabase = require('../src/lib/supabase');
      const { error } = await supabase.from('podcast_episodes').select('status').limit(1);
      return !error;
    })();
  }
  return statusReadyPromise;
}

// Per-test gate: returns true when the test should run; otherwise skips it.
async function integrationReady(t) {
  if (!hasEnv) { t.skip('SUPABASE env not configured'); return false; }
  if (!(await statusReady())) {
    t.skip('migration 005 not applied — paste migrations/005_podcast_episode_status.sql into the SQL Editor');
    return false;
  }
  return true;
}

async function assertFixtureAbsent(supabase, table, value) {
  const { data, error } = await supabase.from(table).select('slug').eq('slug', value).maybeSingle();
  assert.ifError(error && new Error(`${table} pre-check failed: ${error.message}`));
  assert.strictEqual(
    data,
    null,
    `SURPRISE: fixture "${value}" already exists in ${table}. Refusing to run and deleting nothing — inspect and remove it manually.`
  );
}

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

// Insert a fixture episode row in a given lifecycle state.
async function insertFixtureEpisode(supabase, slug, date, { status, attemptStartedAt, audioBytes = 0 }) {
  const { error } = await supabase.from('podcast_episodes').insert({
    slug,
    audio_url: 'https://example.invalid/fixture.mp3',
    audio_bytes: audioBytes,
    duration_sec: audioBytes ? 1 : 0,
    status,
    attempt_started_at: attemptStartedAt || new Date().toISOString(),
    title: `TEST FIXTURE — ${status}`,
    description: 'podcast integration-test fixture (safe to delete)',
    published_at: `${date}T11:15:00+00:00`,
  });
  assert.ifError(error && new Error(`fixture episode insert failed: ${error.message}`));
}

// Namespace cleanup for one fixture slug — unconditional (1999 namespace is
// test-owned; removing absent resources is a no-op).
async function cleanupFixtureSlug(supabase, BUCKET, slug) {
  await supabase.from('podcast_episodes').delete().eq('slug', slug);
  await supabase.storage.from(BUCKET).remove([`episodes/${slug}.mp3`]);
  await supabase.from('stack_signal_articles').delete().eq('slug', slug);
}

// Stubbed grok.tts returning controllable fake audio; returns handles.
function stubTts(grok) {
  const { Readable } = require('node:stream');
  const state = { calls: 0, bytes: Buffer.alloc(1024, 1), throwWith: null, onCall: null, real: grok.tts };
  grok.tts = async () => {
    state.calls += 1;
    if (state.onCall) await state.onCall(state.calls);
    if (state.throwWith) throw new Error(state.throwWith);
    return { audioStream: Readable.from([state.bytes]), costCents: 0, provider: 'grok', model: 'stub', charCount: 0 };
  };
  return state;
}

function agedIso(minutesPast) {
  return new Date(Date.now() - minutesPast * 60000).toISOString();
}

test('feed route serves only complete episodes (pending hidden)', async (t) => {
  if (!(await integrationReady(t))) return;
  const supabase = require('../src/lib/supabase');
  const express = require('express');
  const SLUG = 'the-stack-signal-1999-01-01';

  await assertFixtureAbsent(supabase, 'podcast_episodes', SLUG);
  try {
    await insertFixtureEpisode(supabase, SLUG, '1999-01-01', { status: 'pending' });

    const app = express();
    app.use('/v1/podcast', require('../src/routes/podcast'));
    const server = app.listen(0);
    try {
      const r = await fetch(`http://127.0.0.1:${server.address().port}/v1/podcast/feed.xml`);
      const xml = await r.text();
      assert.strictEqual(r.status, 200);
      assert.ok(!xml.includes(SLUG), 'pending row must not appear in feed.xml');
    } finally {
      server.close();
    }
  } finally {
    await cleanupFixtureSlug(supabase, require('../src/services/podcast').BUCKET, SLUG);
  }
});

test('lifecycle: double generate = one provider call; second sees complete', async (t) => {
  if (!(await integrationReady(t))) return;
  const supabase = require('../src/lib/supabase');
  const grok = require('../src/services/voice-providers/grok');
  const { generateEpisode, BUCKET } = require('../src/services/podcast');

  const DATE = '1999-01-02';
  const SLUG = `the-stack-signal-${DATE}`;
  await assertFixtureAbsent(supabase, 'stack_signal_articles', SLUG);
  await assertFixtureAbsent(supabase, 'podcast_episodes', SLUG);

  const tts = stubTts(grok);
  try {
    await insertFixtureArticle(supabase, SLUG, DATE);

    const first = await generateEpisode({ date: DATE });
    assert.strictEqual(first.created, true, 'first call publishes');
    assert.strictEqual(tts.calls, 1);
    const { data: row1 } = await supabase.from('podcast_episodes')
      .select('status, audio_bytes').eq('slug', SLUG).single();
    assert.strictEqual(row1.status, 'complete');
    assert.strictEqual(row1.audio_bytes, 1024);

    const second = await generateEpisode({ date: DATE });
    assert.strictEqual(second.skipped, true, 'second call skips');
    assert.match(second.reason, /already generated/);
    assert.strictEqual(tts.calls, 1, 'no second provider call');
  } finally {
    grok.tts = tts.real;
    await cleanupFixtureSlug(supabase, BUCKET, SLUG);
  }
});

test('lifecycle: crash after claim leaves pending; active lease blocks plain call AND sweep; stale claim heals', async (t) => {
  if (!(await integrationReady(t))) return;
  const supabase = require('../src/lib/supabase');
  const grok = require('../src/services/voice-providers/grok');
  const { generateEpisode, sweepRecentEpisodes, BUCKET, CLAIM_LEASE_MINUTES } = require('../src/services/podcast');

  const DATE = '1999-01-03';
  const SLUG = `the-stack-signal-${DATE}`;
  await assertFixtureAbsent(supabase, 'stack_signal_articles', SLUG);
  await assertFixtureAbsent(supabase, 'podcast_episodes', SLUG);

  const tts = stubTts(grok);
  try {
    await insertFixtureArticle(supabase, SLUG, DATE);

    // Crash after the NEW claim: row stays 'pending' with a fresh lease.
    tts.throwWith = 'simulated provider outage';
    await assert.rejects(generateEpisode({ date: DATE }), /simulated provider outage/);
    const { data: pending } = await supabase.from('podcast_episodes')
      .select('status, audio_bytes').eq('slug', SLUG).single();
    assert.strictEqual(pending.status, 'pending');

    // Active lease blocks a plain call…
    tts.throwWith = null;
    tts.calls = 0;
    const gated = await generateEpisode({ date: DATE });
    assert.strictEqual(gated.skipped, true);
    assert.match(gated.reason, /likely in progress/);
    assert.strictEqual(tts.calls, 0, 'zero provider calls while lease is active');

    // …and blocks the sweep (missing-or-pending is work, but the claim
    // machinery refuses an active lease).
    const sweep = await sweepRecentEpisodes(1, { dates: [DATE] });
    assert.strictEqual(sweep[0].action, 'skipped', 'sweep defers to the active lease');
    assert.strictEqual(tts.calls, 0);

    // Expire the lease → plain call claims and completes.
    await supabase.from('podcast_episodes')
      .update({ attempt_started_at: agedIso(CLAIM_LEASE_MINUTES + 10) }).eq('slug', SLUG);
    const healed = await generateEpisode({ date: DATE });
    assert.strictEqual(healed.created, true, 'stale claim heals the crashed attempt');
    assert.strictEqual(tts.calls, 1);
    const { data: done } = await supabase.from('podcast_episodes')
      .select('status, audio_bytes').eq('slug', SLUG).single();
    assert.strictEqual(done.status, 'complete');
    assert.strictEqual(done.audio_bytes, 1024);
  } finally {
    grok.tts = tts.real;
    await cleanupFixtureSlug(supabase, BUCKET, SLUG);
  }
});

test('stale claim is atomic: two identical claim UPDATEs, exactly one row returned', async (t) => {
  if (!(await integrationReady(t))) return;
  const supabase = require('../src/lib/supabase');
  const { BUCKET, CLAIM_LEASE_MINUTES } = require('../src/services/podcast');

  const DATE = '1999-01-09';
  const SLUG = `the-stack-signal-${DATE}`;
  await assertFixtureAbsent(supabase, 'podcast_episodes', SLUG);

  try {
    await insertFixtureEpisode(supabase, SLUG, DATE, {
      status: 'pending',
      attemptStartedAt: agedIso(CLAIM_LEASE_MINUTES + 10),
    });

    // The exact claim CAS generateEpisode issues, run twice back to back.
    const claim = () => supabase
      .from('podcast_episodes')
      .update({ attempt_started_at: new Date().toISOString(), audio_bytes: 0, duration_sec: 0 })
      .eq('slug', SLUG)
      .eq('status', 'pending')
      .lt('attempt_started_at', new Date(Date.now() - CLAIM_LEASE_MINUTES * 60000).toISOString())
      .select('slug');

    const first = await claim();
    assert.ifError(first.error && new Error(first.error.message));
    const second = await claim();
    assert.ifError(second.error && new Error(second.error.message));
    const total = (first.data?.length || 0) + (second.data?.length || 0);
    assert.strictEqual(first.data.length, 1, 'first claim wins');
    assert.strictEqual(total, 1, 'exactly one row returned across both claims — the second sees a fresh lease');
  } finally {
    await cleanupFixtureSlug(supabase, BUCKET, SLUG);
  }
});

test('force demote: overlapping plain call mid-force sees an active attempt and skips', async (t) => {
  if (!(await integrationReady(t))) return;
  const supabase = require('../src/lib/supabase');
  const grok = require('../src/services/voice-providers/grok');
  const { generateEpisode, BUCKET } = require('../src/services/podcast');

  const DATE = '1999-01-08';
  const SLUG = `the-stack-signal-${DATE}`;
  await assertFixtureAbsent(supabase, 'stack_signal_articles', SLUG);
  await assertFixtureAbsent(supabase, 'podcast_episodes', SLUG);

  const tts = stubTts(grok);
  try {
    await insertFixtureArticle(supabase, SLUG, DATE);
    await insertFixtureEpisode(supabase, SLUG, DATE, {
      status: 'complete',
      attemptStartedAt: agedIso(60),
      audioBytes: 500,
    });

    // During the forced synthesis (row already demoted to pending with a
    // fresh lease), fire an overlapping PLAIN call — it must skip.
    let overlapResult = null;
    tts.onCall = async (n) => {
      if (n === 1) overlapResult = await generateEpisode({ date: DATE });
    };
    const forced = await generateEpisode({ date: DATE, force: true });
    assert.strictEqual(forced.created, true, 'force completes');
    assert.ok(overlapResult, 'overlapping call ran');
    assert.strictEqual(overlapResult.skipped, true, 'overlap skips mid-force');
    assert.match(overlapResult.reason, /likely in progress/, 'demote refreshed the lease');
    assert.strictEqual(tts.calls, 1, 'only the force synthesized');

    const { data: row } = await supabase.from('podcast_episodes')
      .select('status, audio_bytes').eq('slug', SLUG).single();
    assert.strictEqual(row.status, 'complete');
    assert.strictEqual(row.audio_bytes, 1024);
  } finally {
    grok.tts = tts.real;
    await cleanupFixtureSlug(supabase, BUCKET, SLUG);
  }
});

test('crash after force-demote: pending row heals via stale claim', async (t) => {
  if (!(await integrationReady(t))) return;
  const supabase = require('../src/lib/supabase');
  const grok = require('../src/services/voice-providers/grok');
  const { generateEpisode, BUCKET, CLAIM_LEASE_MINUTES } = require('../src/services/podcast');

  const DATE = '1999-01-10';
  const SLUG = `the-stack-signal-${DATE}`;
  await assertFixtureAbsent(supabase, 'stack_signal_articles', SLUG);
  await assertFixtureAbsent(supabase, 'podcast_episodes', SLUG);

  const tts = stubTts(grok);
  try {
    await insertFixtureArticle(supabase, SLUG, DATE);
    await insertFixtureEpisode(supabase, SLUG, DATE, {
      status: 'complete',
      attemptStartedAt: agedIso(60),
      audioBytes: 500,
    });

    // Force crashes after the demote (provider outage) → row is pending,
    // hidden from the feed, lease fresh.
    tts.throwWith = 'simulated provider outage';
    await assert.rejects(generateEpisode({ date: DATE, force: true }), /simulated provider outage/);
    const { data: pending } = await supabase.from('podcast_episodes')
      .select('status, audio_bytes').eq('slug', SLUG).single();
    assert.strictEqual(pending.status, 'pending', 'demote landed before the crash');
    assert.strictEqual(pending.audio_bytes, 0);

    // Feed predicate excludes it (route filter covered by the feed test).
    const { data: feedRows } = await supabase.from('podcast_episodes')
      .select('slug').eq('status', 'complete').gt('audio_bytes', 0).eq('slug', SLUG);
    assert.strictEqual(feedRows.length, 0);

    // Lease expires → a PLAIN call stale-claims and completes it.
    tts.throwWith = null;
    tts.calls = 0;
    await supabase.from('podcast_episodes')
      .update({ attempt_started_at: agedIso(CLAIM_LEASE_MINUTES + 10) }).eq('slug', SLUG);
    const healed = await generateEpisode({ date: DATE });
    assert.strictEqual(healed.created, true);
    assert.strictEqual(tts.calls, 1);
    const { data: done } = await supabase.from('podcast_episodes')
      .select('status, audio_bytes').eq('slug', SLUG).single();
    assert.strictEqual(done.status, 'complete');
    assert.strictEqual(done.audio_bytes, 1024);
  } finally {
    grok.tts = tts.real;
    await cleanupFixtureSlug(supabase, BUCKET, SLUG);
  }
});

test('sweepRecentEpisodes: missing-or-pending is work, complete skips', async (t) => {
  if (!(await integrationReady(t))) return;
  const supabase = require('../src/lib/supabase');
  const grok = require('../src/services/voice-providers/grok');
  const { sweepRecentEpisodes, BUCKET, CLAIM_LEASE_MINUTES } = require('../src/services/podcast');

  const D_STALE = '1999-01-04';   // article + expired pending → generated
  const D_MISSING = '1999-01-05'; // article, no row → generated
  const D_DONE = '1999-01-06';    // article + complete → skipped-complete
  const D_NOART = '1999-01-07';   // no article → no-article
  const ALL = [D_STALE, D_MISSING, D_DONE, D_NOART];
  const slugOf = (d) => `the-stack-signal-${d}`;

  for (const d of ALL) {
    await assertFixtureAbsent(supabase, 'stack_signal_articles', slugOf(d));
    await assertFixtureAbsent(supabase, 'podcast_episodes', slugOf(d));
  }

  const tts = stubTts(grok);
  try {
    for (const d of [D_STALE, D_MISSING, D_DONE]) await insertFixtureArticle(supabase, slugOf(d), d);
    await insertFixtureEpisode(supabase, slugOf(D_STALE), D_STALE, {
      status: 'pending',
      attemptStartedAt: agedIso(CLAIM_LEASE_MINUTES + 10),
    });
    await insertFixtureEpisode(supabase, slugOf(D_DONE), D_DONE, {
      status: 'complete',
      attemptStartedAt: agedIso(60),
      audioBytes: 500,
    });

    const results = await sweepRecentEpisodes(ALL.length, { dates: ALL });
    const byDate = Object.fromEntries(results.map((r) => [r.date, r.action]));
    assert.strictEqual(byDate[D_STALE], 'generated', 'expired pending is healed');
    assert.strictEqual(byDate[D_MISSING], 'generated', 'missing row is generated');
    assert.strictEqual(byDate[D_DONE], 'skipped-complete', 'complete episode untouched');
    assert.strictEqual(byDate[D_NOART], 'no-article');
    assert.strictEqual(tts.calls, 2, 'exactly two provider calls (stale + missing)');
  } finally {
    grok.tts = tts.real;
    for (const d of ALL) await cleanupFixtureSlug(supabase, BUCKET, slugOf(d));
  }
});
