// Podcast v1 — public RSS feed for "The Stack Signal: Daily Gold & Silver Brief".
//
// GET /v1/podcast/feed.xml — RSS 2.0 + iTunes tags, generated from the
// podcast_episodes table (never from bucket listings). 10-minute in-memory
// cache; podcast platforms poll feeds gently and episodes land once per day.
//
// Channel constants below are the submitted show identity (Apple Podcasts
// Connect / Spotify) — treat edits as show-level changes, not code cleanup.
// itunes:owner email is what Spotify sends its verification code to.

const express = require('express');
const supabase = require('../lib/supabase');

const router = express.Router();

const SITE_URL = 'https://troystack.com';
const FEED_SELF_URL = 'https://api.troystack.ai/v1/podcast/feed.xml';
const CHANNEL = {
  title: 'The Stack Signal: Daily Gold & Silver Brief',
  author: 'TroyStack',
  ownerName: 'TroyStack',
  ownerEmail: 'support@troystack.com',
  description:
    "Troy's daily read on gold, silver, and the forces moving them — spot prices, COMEX flows, central bank buying, and what it all means for physical stackers. " +
    "Hosted by Troy, TroyStack's AI market analyst. Episodes are AI-generated daily from live market data.",
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
      <description>${cdata(ep.description)}</description>
      <enclosure url="${xmlEscape(ep.audio_url)}" length="${ep.audio_bytes}" type="audio/mpeg"/>
      <guid isPermaLink="false">${xmlEscape(ep.slug)}</guid>
      <pubDate>${new Date(ep.published_at).toUTCString()}</pubDate>
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
      .gt('audio_bytes', 0) // exclude pending/failed reservation stubs (reserve-first writes audio_bytes=0 until the audio is real)
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
