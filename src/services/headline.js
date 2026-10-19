// Google News adds " - Publisher" to every headline it carries, like
// "Gold steady as yields rise - Reuters". When the Signal runs a source's
// headline as its own title, that tag came along, so about a third of the news
// items read as someone else's page. This drops it, and only when the title is
// a Google News headline copied whole from one of the item's sources, so a
// dash in a headline Troy wrote, or one a feed printed, stays.
//
// A source is the stored shape ({ url, name, title, description }) or the raw
// feed item ({ link, source, title, description }). Older rows kept Google's
// description, which carries the headline and the publisher two spaces apart.

function isGoogleNews(url) {
  try {
    return new URL(String(url)).hostname === 'news.google.com';
  } catch (_) {
    return false;
  }
}

function stripSourceTag(title, sources) {
  if (typeof title !== 'string') return title;
  const cut = title.lastIndexOf(' - ');
  if (cut < 1) return title;
  const head = title.slice(0, cut);
  const tail = title.slice(cut + 3);
  if (!head.trim() || !tail || tail.startsWith(' ')) return title;

  const copied = (Array.isArray(sources) ? sources : []).some(s => {
    if (!s || !isGoogleNews(s.url || s.link)) return false;
    const name = s.name || s.source;
    return s.title === title
      || s.description === `${head}  ${tail}`
      || (typeof name === 'string' && name.toLowerCase() === tail.toLowerCase());
  });
  return copied ? head : title;
}

module.exports = { stripSourceTag };
