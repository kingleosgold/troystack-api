// Podcast v1 — "The Stack Signal: Daily Gold & Silver Brief"
//
// Turns the daily flagship Stack Signal article (stack_signal_articles,
// slug the-stack-signal-YYYY-MM-DD) into a public podcast episode:
//   strip markdown → wrap intro/outro → sanitizeTTSText → Grok TTS (pinned)
//   → upload MP3 to the public troy-podcast bucket → record in podcast_episodes.
//
// Provider is PINNED to grok via direct require — never getTTSProvider().
// Two reasons: a VOICE_PROVIDER env flip must not silently change the show's
// voice (leo), and the cleared-rights position (xAI assigns Output ownership
// to the customer) is provider-specific.
//
// Idempotent per slug: an existing podcast_episodes row short-circuits before
// any provider spend. Callers (the 11:15 cron hook, scripts/generate-episode.js)
// treat throws as log-and-skip — episode failure must never break the article cron.

const supabase = require('../lib/supabase');
const grok = require('./voice-providers/grok'); // pinned — see header
// Layering note: sanitizeTTSText lives in the troy-chat route module (it is
// the /speak sanitizer and owns SANITIZER_VERSION). Requiring a route from a
// service is a known wart, accepted to keep sanitization policy single-sourced.
// No require cycle: troy-chat.js does not require podcast.js.
const { sanitizeTTSText } = require('../routes/troy-chat');

const BUCKET = 'troy-podcast';
const BYTES_PER_SEC = 16000; // 128kbps CBR MP3 — duration estimate for itunes:duration
// Pinned-voice contract: the show's voice is part of its published identity.
// Passed explicitly so a change to grok.js's default/env voice resolution can
// never silently reskin the podcast — same reasoning as the pinned provider.
const PODCAST_VOICE = 'leo';
// Lease length for a 'pending' claim: an attempt owns the row from
// attempt_started_at for this many minutes (generation takes ~1 min; 10 is a
// comfortable upper bound). The interval lives ONLY in the stale-claim CAS
// UPDATE below — there is no read-side age logic anywhere.
const CLAIM_LEASE_MINUTES = 10;

// Strip markdown the sanitizer doesn't fully cover: links, headers, images,
// code ticks. Bold/italic markers are also handled here so the episode script
// is clean prose before wrapping (sanitizeTTSText would catch **/*/_ anyway).
function stripMarkdown(text) {
  let out = text;
  out = out.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');   // images → alt text
  out = out.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');    // links → link text
  out = out.replace(/^#{1,6}\s+/gm, '');                // headers
  out = out.replace(/\*\*([^*]+)\*\*/g, '$1');          // bold
  out = out.replace(/\*([^*]+)\*/g, '$1');              // italic
  out = out.replace(/__([^_]+)__/g, '$1');              // bold (underscore)
  out = out.replace(/_([^_]+)_/g, '$1');                // italic (underscore)
  out = out.replace(/`+/g, '');                         // code ticks
  return out.trim();
}

// Episode script wrapper — exact copy per podcast v1 ruling #3.
function buildEpisodeScript(article) {
  const dateSpoken = new Date(article.published_at).toLocaleDateString('en-US', {
    month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/New_York',
  });
  const intro = `This is The Stack Signal for ${dateSpoken}. I'm Troy. Here's what matters in metals today.`;
  const outro = `That's the signal. The Stack Signal is generated daily by Troy, TroyStack's AI analyst. Track your own stack — TroyStack on the App Store, or troystack.com.`;
  return `${intro}\n\n${stripMarkdown(article.troy_commentary)}\n\n${outro}`;
}

// Episode description for the feed: one-liner + first paragraph of the article.
function buildEpisodeDescription(article) {
  const body = stripMarkdown(article.troy_commentary || '');
  const firstParagraph = body.split(/\n\s*\n/)[0] || '';
  const oneLiner = (article.troy_one_liner || '').trim();
  return [oneLiner, firstParagraph].filter(Boolean).join('\n\n');
}

// Generate the episode for a date (YYYY-MM-DD, default: today America/New_York).
// Returns { skipped, reason } | { created, slug, audioUrl, audioBytes, durationSec }.
//
// EXPLICIT LIFECYCLE STATE MACHINE (migration 005). Row states:
//   'pending'  — an attempt owns the row; attempt_started_at is its lease
//                start (lease = CLAIM_LEASE_MINUTES).
//   'complete' — audio uploaded and finalized; served by the feed.
// Transitions — every claim is ONE conditional UPDATE (compare-and-swap) or
// the PK INSERT itself; ownership is never taken by read-then-act:
//   NEW:         INSERT status='pending'          (PK conflict → not owned)
//   STALE CLAIM: pending + lease expired → pending (lease refreshed)
//   FORCE DEMOTE: complete → pending               (fresh lease, bytes zeroed)
//   FINALIZE:    pending → complete + real bytes
// Any throw after owning leaves the row 'pending'; it becomes claimable when
// the lease expires (next cron fire, heal cron, sweep, or manual run — no
// operator action needed). The feed serves only status='complete'.
async function generateEpisode({ date, force = false } = {}) {
  const dateStr = date || new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    throw new Error(`Invalid date "${dateStr}" — expected YYYY-MM-DD`);
  }
  const slug = `the-stack-signal-${dateStr}`;

  const { data: article, error: artErr } = await supabase
    .from('stack_signal_articles')
    .select('slug, title, troy_commentary, troy_one_liner, published_at')
    .eq('slug', slug)
    .maybeSingle();
  if (artErr) throw new Error(`article lookup failed: ${artErr.message}`);
  if (!article || !article.troy_commentary) {
    return { skipped: true, reason: `no flagship article for ${slug}` };
  }

  // Deterministic public URL — known before the object exists, so the
  // pending row satisfies NOT NULL audio_url.
  const storagePath = `episodes/${slug}.mp3`;
  const { data: pub } = supabase.storage.from(BUCKET).getPublicUrl(storagePath);
  const audioUrl = pub.publicUrl;

  let owned = false;

  // NEW: create the row as a pending claim. Success = ownership.
  const { error: insertErr } = await supabase.from('podcast_episodes').insert({
    slug,
    audio_url: audioUrl,
    audio_bytes: 0,
    duration_sec: 0,
    status: 'pending',
    attempt_started_at: new Date().toISOString(),
    title: article.title,
    description: buildEpisodeDescription(article),
    published_at: article.published_at,
  });
  if (!insertErr) {
    owned = true;
  } else {
    const isConflict = insertErr.code === '23505' || /duplicate key/i.test(insertErr.message);
    if (!isConflict) throw new Error(`claim insert failed: ${insertErr.message}`);

    if (force) {
      // FORCE DEMOTE (atomic): complete → pending with a FRESH lease and
      // zeroed bytes, so the feed hides it immediately and overlapping
      // plain calls see an ACTIVE attempt and skip. Then synthesize →
      // upload → finalize. A crash anywhere mid-force leaves a pending
      // row that heals via the stale claim once the lease expires.
      // Trade: the episode vanishes from the feed during a failed force
      // until the next heal.
      const { data: demoted, error: demoteErr } = await supabase
        .from('podcast_episodes')
        .update({ status: 'pending', attempt_started_at: new Date().toISOString(), audio_bytes: 0, duration_sec: 0 })
        .eq('slug', slug)
        .eq('status', 'complete')
        .select('slug');
      if (demoteErr) throw new Error(`force demote failed: ${demoteErr.message}`);
      if (demoted && demoted.length === 1) owned = true;
      // 0 rows: the row is pending (not complete) — fall through to the
      // stale claim like any plain call.
    }

    if (!owned) {
      // STALE CLAIM (atomic): take over a pending row whose lease expired,
      // refreshing the lease in the same statement. Exactly one concurrent
      // caller can win this UPDATE. Note: the cutoff uses this process's
      // clock (PostgREST can't reference server-side now() here) — clock
      // skew shifts the lease boundary by skew amount, which is harmless
      // at a 10-minute scale.
      const cutoff = new Date(Date.now() - CLAIM_LEASE_MINUTES * 60000).toISOString();
      const { data: claimed, error: claimErr } = await supabase
        .from('podcast_episodes')
        .update({ attempt_started_at: new Date().toISOString(), audio_bytes: 0, duration_sec: 0 })
        .eq('slug', slug)
        .eq('status', 'pending')
        .lt('attempt_started_at', cutoff)
        .select('slug');
      if (claimErr) throw new Error(`stale claim failed: ${claimErr.message}`);
      if (claimed && claimed.length === 1) {
        owned = true;
        console.log(`🎙️ [Podcast] ${slug}: claimed expired pending attempt`);
      } else {
        // Complete, or actively pending. Follow-up read is for LOGGING
        // only — no ownership decision rests on it.
        const { data: row } = await supabase
          .from('podcast_episodes').select('status').eq('slug', slug).maybeSingle();
        const why = row && row.status === 'complete'
          ? `already generated: ${slug}`
          : `generation likely in progress: ${slug}`;
        console.log(`🎙️ [Podcast] ${why} — exiting before provider spend`);
        return { skipped: true, reason: why };
      }
    }
  }

  const script = buildEpisodeScript(article);
  const cleanText = sanitizeTTSText(script);
  console.log(`🎙️ [Podcast] Synthesizing ${slug}: script ${script.length} chars → sanitized ${cleanText.length} chars${force ? ' (--force)' : ''}`);

  const ttsResult = await grok.tts({ text: cleanText, voiceId: PODCAST_VOICE });
  const chunks = [];
  for await (const chunk of ttsResult.audioStream) chunks.push(chunk);
  const audioBuffer = Buffer.concat(chunks);
  if (audioBuffer.length === 0) throw new Error('provider returned 0 bytes');

  const { error: uploadErr } = await supabase.storage
    .from(BUCKET)
    .upload(storagePath, audioBuffer, { contentType: 'audio/mpeg', upsert: true });
  if (uploadErr) throw new Error(`upload failed: ${uploadErr.message}`);

  // FINALIZE: pending → complete with the real bytes.
  const durationSec = Math.round(audioBuffer.length / BYTES_PER_SEC);
  const { error: updateErr } = await supabase
    .from('podcast_episodes')
    .update({
      status: 'complete',
      audio_url: audioUrl,
      audio_bytes: audioBuffer.length,
      duration_sec: durationSec,
      title: article.title,
      description: buildEpisodeDescription(article),
      published_at: article.published_at,
    })
    .eq('slug', slug);
  if (updateErr) throw new Error(`finalize failed: ${updateErr.message}`);

  console.log(`🎙️ [Podcast] Published ${slug}: ${audioBuffer.length} bytes, ~${durationSec}s, cost ${ttsResult.costCents}¢`);
  return { created: true, slug, audioUrl, audioBytes: audioBuffer.length, durationSec };
}

// Last `days` ET dates (today first) as YYYY-MM-DD strings.
function recentEtDates(days) {
  const todayEt = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const base = new Date(`${todayEt}T00:00:00Z`);
  return Array.from({ length: days }, (_, i) =>
    new Date(base.getTime() - i * 86400000).toISOString().slice(0, 10));
}

// Catch-up sweep — self-heal missed or failed episodes with zero operator
// action. For each of the last `days` ET dates that has a flagship article:
// missing episode row OR stub (audio_bytes = 0) → attempt generation (stub
// reclaim in generateEpisode makes the retry safe); completed episodes skip.
// Called from the 11:15 cron hook after today's generation; per-date errors
// are contained so one bad date never stops the sweep.
//
// opts.dates overrides the date list — FOR TESTS ONLY (fixture-only policy:
// tests must never sweep real/current dates).
async function sweepRecentEpisodes(days = 3, { dates } = {}) {
  const sweepDates = dates || recentEtDates(days);
  const results = [];
  for (const date of sweepDates) {
    const slug = `the-stack-signal-${date}`;
    try {
      const { data: article, error: artErr } = await supabase
        .from('stack_signal_articles').select('slug').eq('slug', slug).maybeSingle();
      if (artErr) throw new Error(`article lookup failed: ${artErr.message}`);
      if (!article) { results.push({ date, action: 'no-article' }); continue; }

      // Missing or pending = work; generateEpisode's claim machinery decides
      // whether the pending attempt is stale enough to take over.
      const { data: ep, error: epErr } = await supabase
        .from('podcast_episodes').select('status').eq('slug', slug).maybeSingle();
      if (epErr) throw new Error(`episode lookup failed: ${epErr.message}`);
      if (ep && ep.status === 'complete') { results.push({ date, action: 'skipped-complete' }); continue; }

      const r = await generateEpisode({ date });
      results.push({ date, action: r.created ? 'generated' : 'skipped', reason: r.reason });
    } catch (err) {
      console.error(`🎙️ [Podcast] Sweep failed for ${date}:`, err.message);
      results.push({ date, action: 'failed', reason: err.message });
    }
  }
  return results;
}

module.exports = { generateEpisode, sweepRecentEpisodes, buildEpisodeScript, buildEpisodeDescription, stripMarkdown, BUCKET, PODCAST_VOICE, CLAIM_LEASE_MINUTES };
