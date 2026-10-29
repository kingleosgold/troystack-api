// Podcast v1 — public RSS feed for "The Stack Signal: Daily Gold & Silver Brief".
//
// GET /v1/podcast/feed.xml — RSS 2.0 + iTunes tags, generated from the
// podcast_episodes table (never from bucket listings). 10-minute in-memory
// cache; podcast platforms poll feeds gently and episodes land once per day.
//
// Channel constants below are the submitted show identity (Apple Podcasts
// Connect / Spotify) — treat edits as show-level changes, not code cleanup.
// itunes:owner email is what Spotify sends its verification code to.
//
// Items carry <link> and <itunes:author> as well as the RSS basics. Both were
// absent when Apple Podcasts Connect refused the feed twice with a generic
// error, and both are recommended at item level; they are cheap and they clear
// the two leading suspects.

const express = require('express');
const supabase = require('../lib/supabase');

const router = express.Router();

const SITE_URL = 'https://troystack.com';
const FEED_SELF_URL = 'https://api.troystack.ai/v1/podcast/feed.xml';
// Per-episode <link> target. Every episode slug has a live article page at
// this base (verified across the full archive, oldest and newest). Apple and
// Spotify both want an item-level link; pointing one at a 404 is worse than
// omitting it, so this base moves only if that page route moves.
const EPISODE_PAGE_BASE = `${SITE_URL}/signal/`;
// Show notes get a footer at render time, so every episode in the feed, old
// and new, carries its article link and an App Store link. ct=podcast lets
// App Store Connect attribute installs that come from the show.
const APP_STORE_PODCAST_URL = 'https://apps.apple.com/app/apple-store/id6757343766?pt=96487801&ct=podcast&mt=8';

// Apple Podcasts content guideline 1.11: a show with a synthetic voice or an
// AI-generated host discloses it in the metadata of the show and of every
// episode, and in the audio (the spoken outro in services/podcast.js). This
// line is that episode-level disclosure, added at render time so every
// episode in the feed carries it, old and new. Titles stay free of it.
const EPISODE_DISCLOSURE = "Troy's voice and script are AI-generated.";

// The Stack Signal for October 28, 2026, so the date stays one glance away
// now that titles carry the news.
function episodeDateLine(ep) {
  const d = new Date(ep.published_at);
  if (Number.isNaN(d.getTime())) return '';
  const label = d.toLocaleDateString('en-US', {
    month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/New_York',
  });
  return `The Stack Signal for ${label}.`;
}

function showNotes(ep) {
  const header = [episodeDateLine(ep), EPISODE_DISCLOSURE].filter(Boolean).join(' ');
  const footer = [
    `Read the full Signal: ${EPISODE_PAGE_BASE}${ep.slug}`,
    `Track your own stack with TroyStack, free on the App Store: ${APP_STORE_PODCAST_URL}`,
  ].join('\n');
  return [header, ep.description, footer].filter(Boolean).join('\n\n');
}
const CHANNEL = {
  title: 'The Stack Signal: Daily Gold & Silver Brief',
  author: 'TroyStack',
  ownerName: 'TroyStack',
  ownerEmail: 'support@troystack.com',
  // The last sentence is the show-level disclosure guideline 1.11 asks for.
  description:
    "Troy's daily read on gold, silver and the forces moving them. " +
    'Spot prices, COMEX flows, central bank buying and what it all means for physical stackers. ' +
    'A new episode every morning, built from live market data. ' +
    "Troy's voice and scripts are AI-generated.",
  language: 'en-us',
  explicit: 'false',
};
const FEED_CACHE_MS = 10 * 60 * 1000;
const MAX_FEED_ITEMS = 500; // retention is forever; cap feed size, oldest drop off the feed only

function artworkUrl() {
  const { data } = supabase.storage.from('troy-podcast').getPublicUrl('artwork.png');
  return data.publicUrl;
}

function xmlEscape(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// CDATA-wrap free text; a literal "]]>" inside content would close the CDATA
// section early, so split it across sections per the standard idiom.
function cdata(s) {
  return `<![CDATA[${String(s).replace(/\]\]>/g, ']]]]><![CDATA[>')}]]>`;
}

function buildFeedXml(episodes) {
  const items = episodes.map((ep) => `    <item>
      <title>${xmlEscape(ep.title)}</title>
      <itunes:title>${xmlEscape(ep.title)}</itunes:title>
      <link>${xmlEscape(EPISODE_PAGE_BASE + ep.slug)}</link>
      <description>${cdata(showNotes(ep))}</description>
      <enclosure url="${xmlEscape(ep.audio_url)}" length="${ep.audio_bytes}" type="audio/mpeg"/>
      <guid isPermaLink="false">${xmlEscape(ep.slug)}</guid>
      <pubDate>${new Date(ep.published_at).toUTCString()}</pubDate>
      <itunes:author>${xmlEscape(CHANNEL.author)}</itunes:author>
      <itunes:duration>${ep.duration_sec}</itunes:duration>
      <itunes:explicit>${CHANNEL.explicit}</itunes:explicit>
    </item>`).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${xmlEscape(CHANNEL.title)}</title>
    <link>${SITE_URL}</link>
    <description>${cdata(CHANNEL.description)}</description>
    <language>${CHANNEL.language}</language>
    <atom:link href="${FEED_SELF_URL}" rel="self" type="application/rss+xml"/>
    <itunes:author>${xmlEscape(CHANNEL.author)}</itunes:author>
    <itunes:owner>
      <itunes:name>${xmlEscape(CHANNEL.ownerName)}</itunes:name>
      <itunes:email>${CHANNEL.ownerEmail}</itunes:email>
    </itunes:owner>
    <itunes:image href="${xmlEscape(artworkUrl())}"/>
    <itunes:category text="Business">
      <itunes:category text="Investing"/>
    </itunes:category>
    <itunes:explicit>${CHANNEL.explicit}</itunes:explicit>
    <itunes:type>episodic</itunes:type>
${items}
  </channel>
</rss>
`;
}

let feedCache = { xml: null, at: 0 };

router.get('/feed.xml', async (_req, res) => {
  try {
    if (feedCache.xml && Date.now() - feedCache.at < FEED_CACHE_MS) {
      res.setHeader('Content-Type', 'application/rss+xml; charset=utf-8');
      return res.send(feedCache.xml);
    }

    const { data: episodes, error } = await supabase
      .from('podcast_episodes')
      .select('slug, audio_url, audio_bytes, duration_sec, title, description, published_at')
      .eq('status', 'complete') // only finalized episodes are served
      .gt('audio_bytes', 0) // belt: a complete row must have real audio regardless
      .order('published_at', { ascending: false })
      .limit(MAX_FEED_ITEMS);
    if (error) throw new Error(error.message);

    const xml = buildFeedXml(episodes || []);
    feedCache = { xml, at: Date.now() };
    res.setHeader('Content-Type', 'application/rss+xml; charset=utf-8');
    return res.send(xml);
  } catch (err) {
    console.error('🎙️ [Podcast] feed.xml failed:', err.message);
    // Serve a stale cache over a hard failure if we have one.
    if (feedCache.xml) {
      res.setHeader('Content-Type', 'application/rss+xml; charset=utf-8');
      return res.send(feedCache.xml);
    }
    return res.status(500).json({ error: 'Feed generation failed' });
  }
});

module.exports = router;
module.exports.buildFeedXml = buildFeedXml;
module.exports.showNotes = showNotes;
module.exports.CHANNEL = CHANNEL;
module.exports.EPISODE_DISCLOSURE = EPISODE_DISCLOSURE;
