// Tests for spreading Stack Signal's daily articles across the day and for
// leaving out stories the feed already ran. Supabase, RSS and the model calls
// are faked, so nothing leaves the machine.
//   node --test

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const Module = require('node:module');

const NOW = new Date('2026-10-09T13:05:00Z'); // five slots open by 13:05 UTC

// ---- fake Supabase ----------------------------------------------------------

const db = {
  dailyCount: 0,
  appState: {},          // key -> value, besides commentary_daily_count
  recentFeed: [],        // { title, published_at } feed rows
  writtenLinks: new Set(), // source links some saved article already lists, however old
  lookups: [],           // every link looked up in saved articles' sources
  upserts: [],           // every upsert, as { table, row }
  failReads: new Set(),  // app_state keys, 'recentFeed' or 'writtenLinks', whose read errors
  failUpserts: new Set(), // app_state keys whose upsert errors
};

function resetDb() {
  db.dailyCount = 0;
  db.appState = {};
  db.recentFeed = [];
  db.writtenLinks = new Set();
  db.lookups = [];
  db.upserts = [];
  db.failReads = new Set();
  db.failUpserts = new Set();
}

const READ_ERROR = { code: '', message: 'fetch failed' };
const JSON_ERROR = { code: '22P02', message: 'invalid input syntax for type json' };

// Reads resolve like Supabase's query builder: awaiting the chain runs it.
function resultFor(table, q) {
  if (table === 'stack_signal_articles' && q.contains?.col === 'sources') {
    if (db.failReads.has('writtenLinks')) return { data: null, error: READ_ERROR };
    // sources is jsonb, and the real client sends an array as {a,b}, which
    // isn't JSON, so like the database this only answers JSON text.
    if (typeof q.contains.val !== 'string') return { data: null, error: JSON_ERROR };
    const urls = JSON.parse(q.contains.val).map(s => s.url);
    db.lookups.push(...urls);
    return { data: urls.some(u => db.writtenLinks.has(u)) ? [{ id: 'written' }] : [], error: null };
  }
  if (table === 'stack_signal_articles' && q.filters.is_stack_signal === false) {
    if (db.failReads.has('recentFeed')) return { data: null, error: READ_ERROR };
    const since = q.filters['published_at>='] || '';
    const rows = db.recentFeed
      .filter(r => r.published_at >= since)
      .sort((a, b) => b.published_at.localeCompare(a.published_at))
      .map(r => ({ id: r.title, title: r.title, published_at: r.published_at, troy_commentary: longArticle, relevance_score: 80 }));
    return { data: rows, error: null };
  }
  return { data: [], error: null };
}

const fakeSupabase = {
  from(table) {
    const q = { table, filters: {}, selected: '' };
    const api = {
      select(cols) { q.selected = cols || ''; return api; },
      eq(col, val) { q.filters[col] = val; return api; },
      gte(col, val) { q.filters[`${col}>=`] = val; return api; },
      contains(col, val) { q.contains = { col, val }; return api; },
      not() { return api; },
      order() { return api; },
      limit() { return api; },
      then(resolve, reject) {
        return Promise.resolve(resultFor(table, q)).then(resolve, reject);
      },
      single() {
        if (table === 'app_state' && db.failReads.has(q.filters.key)) {
          return Promise.resolve({ data: null, error: READ_ERROR });
        }
        if (table === 'app_state' && q.filters.key === 'commentary_daily_count') {
          const date = new Date().toISOString().split('T')[0];
          return Promise.resolve({ data: { value: { date, count: db.dailyCount } }, error: null });
        }
        if (table === 'app_state' && db.appState[q.filters.key] !== undefined) {
          return Promise.resolve({ data: { value: db.appState[q.filters.key] }, error: null });
        }
        return Promise.resolve({ data: null, error: { code: 'PGRST116' } });
      },
      insert() { return Promise.resolve({ error: null }); },
      upsert(row) {
        if (table === 'app_state' && db.failUpserts.has(row.key)) {
          const failed = Promise.resolve({ error: { message: 'write failed' } });
          failed.select = () => ({ single: () => Promise.resolve({ data: null, error: { message: 'write failed' } }) });
          return failed;
        }
        db.upserts.push({ table, row });
        if (table === 'app_state') {
          if (row.key === 'commentary_daily_count') db.dailyCount = row.value.count;
          else db.appState[row.key] = row.value;
        }
        const done = Promise.resolve({ error: null });
        done.select = () => ({ single: () => Promise.resolve({ data: { id: 'saved-id' }, error: null }) });
        return done;
      },
    };
    return api;
  },
};

// ---- fake model calls ---------------------------------------------------------

const calls = { gemini: [], claude: 0, claudePrompts: [], rss: 0 };
let clusterReply = '[]';
let scoreValue = 80;
let draft = null; // what the feed writer returns; null means the long article
let draftQueue = []; // one reply per feed-writer call, in order, before falling back to draft; an Error is thrown

const longArticle = 'Gold held its ground as the dollar slipped and physical buyers kept coming. '.repeat(40);

async function fakeGemini(model, system, user) {
  calls.gemini.push({ system, user });
  if (system.includes('relevance scorer')) {
    const count = (user.match(/^\d+\. /gm) || []).length;
    return JSON.stringify(Array.from({ length: count }, (_, i) => ({ index: i + 1, score: scoreValue, category: 'gold' })));
  }
  if (system.includes('editor at a precious metals intelligence publication')) return clusterReply;
  if (system.includes('posts reactions to market news')) {
    const reply = draftQueue.length ? draftQueue.shift() : (draft || longArticle);
    if (reply instanceof Error) throw reply; // a failed call, like a timeout or a quota error
    return reply;
  }
  if (system.includes('news editor')) return 'Physical buyers kept buying while paper traders sold';
  throw new Error(`unexpected Gemini call: ${system.slice(0, 60)}`);
}

// ---- module stubs -------------------------------------------------------------

function stub(rel, exportsObj) {
  const file = require.resolve(path.join(__dirname, '..', rel));
  const m = new Module(file, null);
  m.filename = file;
  m.loaded = true;
  m.exports = exportsObj;
  require.cache[file] = m;
}

const rssArticles = [
  { title: 'Fed minutes show officials split on cuts', description: 'Minutes released', signal_score: 85, link: 'https://example.com/fed-1', source: 'Wire' },
  { title: 'Gold slips after Fed minutes', description: 'Spot eases', signal_score: 80, link: 'https://example.com/fed-2', source: 'Wire' },
  { title: 'Perth Mint pauses silver bar orders', description: 'Backlog grows', signal_score: 75, link: 'https://example.com/perth-1', source: 'Wire' },
];
let rssItems = rssArticles;

stub('src/lib/supabase', fakeSupabase);
stub('src/services/ai-router', {
  callGemini: fakeGemini,
  callClaude: async (system) => { calls.claude += 1; calls.claudePrompts.push(system); return longArticle; },
  generateImage: async () => { throw new Error('no images in tests'); },
  MODELS: { flash: 'flash', editorial: 'editorial' },
});
stub('src/services/rss-fetcher', { fetchNewArticles: async () => { calls.rss += 1; return rssItems.map(a => ({ ...a })); } });
stub('src/services/price-fetcher', { getCachedPrices: () => ({ gold: 4000, silver: 48 }) });
stub('src/services/auto-tweet', { enqueueTweet: async () => {} });
stub('src/services/intelligence-scraper', { getTopIntelligence: async () => '' });
stub('src/services/stack-signal-push', { maybePushStackSignalAlert: async () => {} });

const ssp = require('../src/services/stack-signal-processor');

function freshRun() {
  resetDb();
  calls.gemini = [];
  calls.claude = 0;
  calls.claudePrompts = [];
  calls.rss = 0;
  rssItems = rssArticles;
  clusterReply = '[]';
  scoreValue = 80;
  draft = null;
  draftQueue = [];
}

const passedLinks = () => Object.keys(db.appState.stack_signal_passed?.links || {}).sort();

const savedFeedRows = () => db.upserts.filter(u => u.table === 'stack_signal_articles').map(u => u.row);
const clusterCall = () => calls.gemini.find(c => c.system.includes('editor at a precious metals intelligence publication'));
const scoreCall = () => calls.gemini.find(c => c.system.includes('relevance scorer'));
const writerCalls = () => calls.gemini.filter(c => c.system.includes('posts reactions to market news'));
const passedUntil = link => db.appState.stack_signal_passed?.links?.[link];
const HOUR_LATER = '2026-10-09T14:05:00.000Z';
const DAY_LATER = '2026-10-10T13:05:00.000Z';
const shortDraft = 'Too short to publish. '.repeat(20);

test.beforeEach(t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  freshRun();
});

test.afterEach(t => {
  t.mock.timers.reset();
});

// ---- slots ----------------------------------------------------------------------

test('a slot opens every three hours from midnight UTC and the count tops out at eight', () => {
  const at = iso => ssp.slotsOpenAt(new Date(iso));
  assert.strictEqual(at('2026-10-09T00:00:00Z'), 1);
  assert.strictEqual(at('2026-10-09T02:59:00Z'), 1);
  assert.strictEqual(at('2026-10-09T03:00:00Z'), 2);
  assert.strictEqual(at('2026-10-09T13:05:00Z'), 5);
  assert.strictEqual(at('2026-10-09T21:00:00Z'), 8);
  assert.strictEqual(at('2026-10-09T23:59:00Z'), 8);
});

test('with every open slot used, the run stops before fetching or calling a model', async () => {
  db.dailyCount = 5;
  const result = await ssp.runStackSignalPipeline();
  assert.strictEqual(result.skipped, true);
  assert.strictEqual(calls.rss, 0);
  assert.strictEqual(calls.gemini.length, 0);
  assert.strictEqual(savedFeedRows().length, 0);
});

test('an open slot gets one article per run even when more slots are open', async () => {
  db.dailyCount = 1; // four slots open and unused
  clusterReply = JSON.stringify([
    { theme: 'Fed split keeps gold bid', importance: 90, article_indices: [0, 1], suggested_angle: 'Split Fed', category: 'macro', already_covered: false },
    { theme: 'Perth Mint backlog tightens silver', importance: 85, article_indices: [2], suggested_angle: 'Mint backlog', category: 'silver', already_covered: false },
  ]);
  const result = await ssp.runStackSignalPipeline();
  assert.strictEqual(result.synthesized, 1);
  const rows = savedFeedRows();
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].title, 'Fed split keeps gold bid');
  assert.strictEqual(db.dailyCount, 2);
  // The Perth story missed this run's slot but stays in play for the next one.
  assert.deepStrictEqual(passedLinks(), []);
});

test('a story the feed already ran is skipped and its articles sit out for a day', async () => {
  db.dailyCount = 4;
  db.recentFeed = [{ title: "Fed's Tightrope Walk: Yields, Rate Hikes, and Gold", published_at: '2026-10-09T09:00:00.000Z' }];
  clusterReply = JSON.stringify([
    { theme: 'Fed minutes rattle gold again', importance: 95, article_indices: [0, 1], suggested_angle: 'Fed', category: 'macro', already_covered: true },
    { theme: 'Perth Mint backlog tightens silver', importance: 80, article_indices: [2], suggested_angle: 'Mint backlog', category: 'silver', already_covered: false },
  ]);
  const result = await ssp.runStackSignalPipeline();

  assert.strictEqual(result.covered, 1);
  const rows = savedFeedRows();
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].title, 'Perth Mint backlog tightens silver');

  const prompt = clusterCall().user;
  assert.match(prompt, /ALREADY PUBLISHED IN THE LAST 24 HOURS:\n- Fed's Tightrope Walk/);
  assert.match(prompt, /"already_covered" to true/);

  assert.deepStrictEqual(passedLinks(), ['https://example.com/fed-1', 'https://example.com/fed-2']);
});

test('articles set aside earlier never reach scoring, and newer stories get the slot', async () => {
  db.dailyCount = 4;
  db.appState.stack_signal_passed = { links: {
    'https://example.com/fed-1': '2026-10-10T10:00:00.000Z',
    'https://example.com/fed-2': '2026-10-10T10:00:00.000Z',
  } };
  clusterReply = JSON.stringify([
    { theme: 'Perth Mint backlog tightens silver', importance: 80, article_indices: [0], suggested_angle: 'Mint backlog', category: 'silver', already_covered: false },
  ]);
  const result = await ssp.runStackSignalPipeline();

  const scored = scoreCall().user;
  assert.ok(!scored.includes('Fed minutes show officials split'));
  assert.ok(scored.includes('Perth Mint pauses silver bar orders'));
  assert.strictEqual(result.synthesized, 1);
});

test('a set-aside link comes back once its time is up', async () => {
  db.dailyCount = 4;
  db.appState.stack_signal_passed = { links: { 'https://example.com/fed-1': '2026-10-09T13:00:00.000Z' } };
  clusterReply = '[]';
  db.recentFeed = [{ title: 'Something earlier', published_at: '2026-10-09T09:00:00.000Z' }];
  await ssp.runStackSignalPipeline();
  assert.ok(scoreCall().user.includes('Fed minutes show officials split'));
});

test('a link written up long ago that a feed re-dated is dropped before scoring and sits out a day', async () => {
  db.dailyCount = 4;
  // Written up weeks back, so the fetch's week of dedup let it through as new.
  db.writtenLinks = new Set(['https://example.com/fed-1']);
  const result = await ssp.runStackSignalPipeline();

  const scored = scoreCall().user;
  assert.ok(!scored.includes('Fed minutes show officials split'));
  assert.ok(scored.includes('Gold slips after Fed minutes'));
  assert.ok(scored.includes('Perth Mint pauses silver bar orders'));
  assert.strictEqual(result.scored, 2);
  // The run carries on with the other two and writes the top one.
  assert.deepStrictEqual(savedFeedRows().map(r => r.title), ['Gold slips after Fed minutes']);
  // Only the written link sits out. Perth missed the slot and stays in play.
  assert.deepStrictEqual(passedLinks(), ['https://example.com/fed-1']);
  assert.strictEqual(passedUntil('https://example.com/fed-1'), DAY_LATER);
});

test('a failed lookup of written links stops the run before any model call', async () => {
  db.dailyCount = 4;
  db.failReads.add('writtenLinks');
  clusterReply = JSON.stringify([
    { theme: 'Perth Mint backlog tightens silver', importance: 80, article_indices: [2], suggested_angle: 'Mint backlog', category: 'silver', already_covered: false },
  ]);
  const result = await ssp.runStackSignalPipeline();
  assert.strictEqual(calls.rss, 1);
  assert.strictEqual(calls.gemini.length, 0);
  assert.strictEqual(result.scored, 0);
  assert.strictEqual(result.synthesized, 0);
  assert.strictEqual(savedFeedRows().length, 0);
  assert.strictEqual(db.dailyCount, 4);
  // Nothing is set aside, so the next run looks again.
  assert.deepStrictEqual(passedLinks(), []);
});

test('when every article headed for scoring was written up, nothing is scored', async () => {
  db.dailyCount = 4;
  db.writtenLinks = new Set(rssArticles.map(a => a.link));
  const result = await ssp.runStackSignalPipeline();
  assert.strictEqual(calls.gemini.length, 0);
  assert.strictEqual(result.scored, 0);
  assert.strictEqual(result.synthesized, 0);
  assert.strictEqual(savedFeedRows().length, 0);
  assert.strictEqual(db.dailyCount, 4);
  assert.deepStrictEqual(passedLinks(), rssArticles.map(a => a.link).sort());
  assert.ok(Object.values(db.appState.stack_signal_passed.links).every(until => until === DAY_LATER));
});

test("only the five headed for scoring are looked up, and one that's dropped isn't replaced", async () => {
  db.dailyCount = 4;
  rssItems = Array.from({ length: 6 }, (_, i) => ({ title: `Gold story ${i}`, description: 'Spot', signal_score: 90 - i, link: `https://example.com/gold-${i}`, source: 'Wire' }));
  db.writtenLinks = new Set(['https://example.com/gold-0']);
  await ssp.runStackSignalPipeline();
  assert.deepStrictEqual(db.lookups.sort(), rssItems.slice(0, 5).map(a => a.link).sort());
  const scored = scoreCall().user;
  assert.strictEqual((scored.match(/^\d+\. /gm) || []).length, 4);
  assert.ok(!scored.includes('Gold story 0'));
  assert.ok(!scored.includes('Gold story 5'));
});

test('nothing new against the last day writes nothing and sets every article it saw aside', async () => {
  db.dailyCount = 4;
  db.recentFeed = [{ title: 'Fed minutes split the committee', published_at: '2026-10-09T09:00:00.000Z' }];
  clusterReply = '[]';
  const result = await ssp.runStackSignalPipeline();
  assert.strictEqual(result.synthesized, 0);
  assert.strictEqual(savedFeedRows().length, 0);
  assert.strictEqual(db.dailyCount, 4);
  assert.deepStrictEqual(passedLinks(), rssArticles.map(a => a.link).sort());
});

test('after a run with nothing new, the next run scores the newer story behind the same five', async () => {
  db.dailyCount = 4;
  db.recentFeed = [{ title: 'Fed minutes split the committee', published_at: '2026-10-09T09:00:00.000Z' }];
  const fedFive = Array.from({ length: 5 }, (_, i) => ({ title: `Fed minutes take ${i}`, description: 'Minutes', signal_score: 90 - i, link: `https://example.com/fed-take-${i}`, source: 'Wire' }));
  rssItems = [...fedFive, { title: 'Perth Mint pauses silver bar orders', description: 'Backlog', signal_score: 60, link: 'https://example.com/perth-1', source: 'Wire' }];

  clusterReply = '[]';
  await ssp.runStackSignalPipeline();
  assert.ok(!scoreCall().user.includes('Perth'));

  calls.gemini = [];
  clusterReply = JSON.stringify([
    { theme: 'Perth Mint backlog tightens silver', importance: 80, article_indices: [0], suggested_angle: 'Mint backlog', category: 'silver', already_covered: false },
  ]);
  const second = await ssp.runStackSignalPipeline();
  assert.ok(scoreCall().user.includes('Perth Mint pauses silver bar orders'));
  assert.ok(!scoreCall().user.includes('Fed minutes take'));
  assert.strictEqual(second.synthesized, 1);
});

test('articles scored under 50 sit out too', async () => {
  db.dailyCount = 4;
  scoreValue = 30;
  const result = await ssp.runStackSignalPipeline();
  assert.strictEqual(result.synthesized, 0);
  assert.strictEqual(clusterCall(), undefined);
  assert.deepStrictEqual(passedLinks(), rssArticles.map(a => a.link).sort());
});

test('worthy articles no cluster used sit out, the ones written are counted, not set aside', async () => {
  db.dailyCount = 4;
  clusterReply = JSON.stringify([
    { theme: 'Perth Mint backlog tightens silver', importance: 80, article_indices: [2], suggested_angle: 'Mint backlog', category: 'silver', already_covered: false },
  ]);
  const result = await ssp.runStackSignalPipeline();
  assert.strictEqual(result.synthesized, 1);
  assert.deepStrictEqual(passedLinks(), ['https://example.com/fed-1', 'https://example.com/fed-2']);
});

test('a clustering failure with stories out today writes nothing and holds those articles back an hour', async t => {
  db.dailyCount = 4;
  db.recentFeed = [{ title: 'Fed minutes split the committee', published_at: '2026-10-09T09:00:00.000Z' }];
  clusterReply = 'Sorry, here are the clusters: [oops';
  const result = await ssp.runStackSignalPipeline();
  assert.strictEqual(result.synthesized, 0);
  assert.strictEqual(savedFeedRows().length, 0);
  assert.strictEqual(db.dailyCount, 4);
  const links = db.appState.stack_signal_passed.links;
  assert.deepStrictEqual(Object.keys(links).sort(), rssArticles.map(a => a.link).sort());
  assert.ok(Object.values(links).every(until => until === '2026-10-09T14:05:00.000Z'));

  // An hour on, the same articles get another look.
  t.mock.timers.setTime(Date.parse('2026-10-09T14:06:00Z'));
  calls.gemini = [];
  clusterReply = JSON.stringify([
    { theme: 'Perth Mint backlog tightens silver', importance: 80, article_indices: [2], suggested_angle: 'Mint backlog', category: 'silver', already_covered: false },
  ]);
  const later = await ssp.runStackSignalPipeline();
  assert.ok(scoreCall().user.includes('Fed minutes show officials split'));
  assert.strictEqual(later.synthesized, 1);
});

test('a clustering failure with nothing out today still falls back to the top article', async () => {
  db.dailyCount = 4;
  clusterReply = 'Sorry, here are the clusters: [oops';
  const result = await ssp.runStackSignalPipeline();
  assert.strictEqual(result.synthesized, 1);
});

test('articles go out at least 90 minutes apart even with slots open', async () => {
  db.dailyCount = 2; // three slots open
  db.recentFeed = [{ title: 'Silver tops $50', published_at: '2026-10-09T12:00:00.000Z' }];
  const result = await ssp.runStackSignalPipeline();
  assert.strictEqual(result.skipped, true);
  assert.strictEqual(calls.rss, 0);
  assert.strictEqual(calls.gemini.length, 0);
});

test('a failed read of the daily count stops the run before fetching', async () => {
  db.dailyCount = 0;
  db.failReads.add('commentary_daily_count');
  const result = await ssp.runStackSignalPipeline();
  assert.match(result.error, /daily count/);
  assert.strictEqual(calls.rss, 0);
  assert.strictEqual(savedFeedRows().length, 0);
});

test('a failed save of the daily count publishes nothing', async () => {
  db.dailyCount = 4;
  db.failUpserts.add('commentary_daily_count');
  clusterReply = JSON.stringify([
    { theme: 'Perth Mint backlog tightens silver', importance: 80, article_indices: [2], suggested_angle: 'Mint backlog', category: 'silver', already_covered: false },
  ]);
  const result = await ssp.runStackSignalPipeline();
  assert.match(result.error, /daily count/);
  assert.strictEqual(savedFeedRows().length, 0);
});

test('a failed read of recent feed articles stops the run before fetching', async () => {
  db.dailyCount = 4;
  db.failReads.add('recentFeed');
  const result = await ssp.runStackSignalPipeline();
  assert.match(result.error, /recent feed/);
  assert.strictEqual(calls.rss, 0);
});

test('a failed read of the passed list neither filters with it nor writes over it', async () => {
  db.dailyCount = 4;
  db.appState.stack_signal_passed = { links: { 'https://example.com/fed-1': '2026-10-10T10:00:00.000Z' } };
  db.failReads.add('stack_signal_passed');
  db.recentFeed = [{ title: 'Fed minutes split the committee', published_at: '2026-10-09T09:00:00.000Z' }];
  clusterReply = JSON.stringify([
    { theme: 'Fed minutes again', importance: 90, article_indices: [0, 1], suggested_angle: 'Fed', category: 'macro', already_covered: true },
    { theme: 'Perth Mint backlog tightens silver', importance: 80, article_indices: [2], suggested_angle: 'Mint backlog', category: 'silver', already_covered: false },
  ]);
  const result = await ssp.runStackSignalPipeline();
  assert.ok(scoreCall().user.includes('Fed minutes show officials split'));
  assert.strictEqual(result.synthesized, 1);
  assert.deepStrictEqual(db.appState.stack_signal_passed, { links: { 'https://example.com/fed-1': '2026-10-10T10:00:00.000Z' } });
});

test('a story only one outlet has can stand as its own cluster', async () => {
  db.dailyCount = 4;
  clusterReply = JSON.stringify([
    { theme: 'Fed split keeps gold bid', importance: 90, article_indices: [0, 1], suggested_angle: 'Split Fed', category: 'macro', already_covered: false },
    { theme: 'Perth Mint backlog tightens silver', importance: 85, article_indices: [2], suggested_angle: 'Mint backlog', category: 'silver', already_covered: false },
  ]);
  await ssp.runStackSignalPipeline();
  const prompt = clusterCall().user;
  assert.ok(!prompt.includes('must reference at least 2'));
  assert.match(prompt, /A distinct story that only one article covers can be its own cluster/);
  // The single-source story missed this run's slot and stays in play.
  assert.ok(!passedLinks().includes('https://example.com/perth-1'));
});

test('a draft under 2,500 characters keeps the slot, publishes nothing and sits out an hour', async () => {
  db.dailyCount = 4;
  draft = shortDraft;
  clusterReply = JSON.stringify([
    { theme: 'Perth Mint backlog tightens silver', importance: 80, article_indices: [2], suggested_angle: 'Mint backlog', category: 'silver', already_covered: false },
  ]);
  const result = await ssp.runStackSignalPipeline();
  assert.strictEqual(result.synthesized, 0);
  assert.strictEqual(savedFeedRows().length, 0);
  assert.strictEqual(db.dailyCount, 4);
  assert.strictEqual(passedUntil('https://example.com/perth-1'), HOUR_LATER);
});

test('a short or empty draft hands the slot to the next fresh cluster', async () => {
  db.dailyCount = 4;
  clusterReply = JSON.stringify([
    { theme: 'Fed split keeps gold bid', importance: 90, article_indices: [0, 1], suggested_angle: 'Split Fed', category: 'macro', already_covered: false },
    { theme: 'Perth Mint backlog tightens silver', importance: 85, article_indices: [2], suggested_angle: 'Mint backlog', category: 'silver', already_covered: false },
  ]);
  for (const first of [shortDraft, '']) {
    freshRunKeepingSetup();
    draftQueue = [first, longArticle];
    const result = await ssp.runStackSignalPipeline();
    assert.strictEqual(result.synthesized, 1);
    assert.deepStrictEqual(savedFeedRows().map(r => r.title), ['Perth Mint backlog tightens silver']);
    assert.strictEqual(writerCalls().length, 2);
    assert.match(writerCalls()[0].user, /Fed minutes show officials split/);
    assert.match(writerCalls()[1].user, /Perth Mint pauses silver bar orders/);
    // The Fed story sits out an hour, so the next run doesn't draft it first again.
    assert.strictEqual(passedUntil('https://example.com/fed-1'), HOUR_LATER);
    assert.strictEqual(passedUntil('https://example.com/fed-2'), HOUR_LATER);
    assert.strictEqual(passedUntil('https://example.com/perth-1'), undefined);
    assert.strictEqual(db.dailyCount, 5);
  }

  function freshRunKeepingSetup() {
    const reply = clusterReply;
    freshRun();
    clusterReply = reply;
    db.dailyCount = 4;
  }
});

test('a run throws away at most two drafts, and the stories behind them stay in play', async () => {
  db.dailyCount = 4;
  draft = shortDraft;
  clusterReply = JSON.stringify([
    { theme: 'Fed split keeps gold bid', importance: 90, article_indices: [0], suggested_angle: 'Split Fed', category: 'macro', already_covered: false },
    { theme: 'Gold eases after the minutes', importance: 88, article_indices: [1], suggested_angle: 'Dip buyers', category: 'gold', already_covered: false },
    { theme: 'Perth Mint backlog tightens silver', importance: 85, article_indices: [2], suggested_angle: 'Mint backlog', category: 'silver', already_covered: false },
  ]);
  const result = await ssp.runStackSignalPipeline();
  assert.strictEqual(result.synthesized, 0);
  assert.strictEqual(writerCalls().length, 2);
  assert.strictEqual(savedFeedRows().length, 0);
  assert.strictEqual(db.dailyCount, 4);
  assert.deepStrictEqual(passedLinks(), ['https://example.com/fed-1', 'https://example.com/fed-2']);
});

test('a draft call that fails hands the slot to the next fresh cluster', async () => {
  db.dailyCount = 4;
  clusterReply = JSON.stringify([
    { theme: 'Fed split keeps gold bid', importance: 90, article_indices: [0, 1], suggested_angle: 'Split Fed', category: 'macro', already_covered: false },
    { theme: 'Perth Mint backlog tightens silver', importance: 85, article_indices: [2], suggested_angle: 'Mint backlog', category: 'silver', already_covered: false },
  ]);
  draftQueue = [new Error('timeout of 30000ms exceeded'), longArticle];
  const result = await ssp.runStackSignalPipeline();
  assert.strictEqual(result.error, undefined);
  assert.strictEqual(result.synthesized, 1);
  assert.deepStrictEqual(savedFeedRows().map(r => r.title), ['Perth Mint backlog tightens silver']);
  assert.strictEqual(writerCalls().length, 2);
  assert.match(writerCalls()[0].user, /Fed minutes show officials split/);
  assert.match(writerCalls()[1].user, /Perth Mint pauses silver bar orders/);
  // The Fed story sits out an hour, so the next run doesn't draft it first again.
  assert.strictEqual(passedUntil('https://example.com/fed-1'), HOUR_LATER);
  assert.strictEqual(passedUntil('https://example.com/fed-2'), HOUR_LATER);
  assert.strictEqual(passedUntil('https://example.com/perth-1'), undefined);
  assert.strictEqual(db.dailyCount, 5);
});

test('when both draft calls fail, the run ends without an error and publishes nothing', async () => {
  db.dailyCount = 4;
  clusterReply = JSON.stringify([
    { theme: 'Fed split keeps gold bid', importance: 90, article_indices: [0], suggested_angle: 'Split Fed', category: 'macro', already_covered: false },
    { theme: 'Gold eases after the minutes', importance: 88, article_indices: [1], suggested_angle: 'Dip buyers', category: 'gold', already_covered: false },
    { theme: 'Perth Mint backlog tightens silver', importance: 85, article_indices: [2], suggested_angle: 'Mint backlog', category: 'silver', already_covered: false },
  ]);
  draftQueue = [new Error('Request failed with status code 429'), new Error('socket hang up')];
  const result = await ssp.runStackSignalPipeline();
  assert.strictEqual(result.error, undefined);
  assert.strictEqual(result.clusters, 3);
  assert.strictEqual(result.synthesized, 0);
  assert.strictEqual(result.saved, 0);
  // Each failed call counts as a draft, so the third cluster isn't tried this run.
  assert.strictEqual(writerCalls().length, 2);
  assert.strictEqual(savedFeedRows().length, 0);
  assert.strictEqual(db.dailyCount, 4);
  // Both failed stories sit out an hour, and the one behind them stays in play.
  assert.deepStrictEqual(passedLinks(), ['https://example.com/fed-1', 'https://example.com/fed-2']);
  assert.strictEqual(passedUntil('https://example.com/fed-1'), HOUR_LATER);
  assert.strictEqual(passedUntil('https://example.com/fed-2'), HOUR_LATER);
});

test('a story whose draft was thrown away comes back after its hour', async t => {
  db.dailyCount = 4;
  clusterReply = JSON.stringify([
    { theme: 'Fed split keeps gold bid', importance: 90, article_indices: [0, 1], suggested_angle: 'Split Fed', category: 'macro', already_covered: false },
    { theme: 'Perth Mint backlog tightens silver', importance: 85, article_indices: [2], suggested_angle: 'Mint backlog', category: 'silver', already_covered: false },
  ]);
  draftQueue = [shortDraft, longArticle];
  await ssp.runStackSignalPipeline();
  assert.deepStrictEqual(savedFeedRows().map(r => r.title), ['Perth Mint backlog tightens silver']);

  // Two hours on, a slot is open again and the Fed story is drafted first.
  t.mock.timers.tick(2 * 60 * 60 * 1000);
  rssItems = rssArticles.filter(a => a.link !== 'https://example.com/perth-1');
  clusterReply = JSON.stringify([
    { theme: 'Fed split keeps gold bid', importance: 90, article_indices: [0, 1], suggested_angle: 'Split Fed', category: 'macro', already_covered: false },
  ]);
  const before = writerCalls().length;
  const result = await ssp.runStackSignalPipeline();
  assert.strictEqual(result.synthesized, 1);
  assert.match(writerCalls()[before].user, /Fed minutes show officials split/);
  const titles = savedFeedRows().map(r => r.title);
  assert.strictEqual(titles.length, 2);
  assert.match(titles[1], /Fed/);
});

test('a tick that starts while the last run is still going writes nothing', async () => {
  db.dailyCount = 4; // one slot open
  clusterReply = JSON.stringify([
    { theme: 'Perth Mint backlog tightens silver', importance: 80, article_indices: [2], suggested_angle: 'Mint backlog', category: 'silver', already_covered: false },
  ]);
  // The first run is still on its way when the next tick starts.
  const first = ssp.runStackSignalPipeline();
  const second = await ssp.runStackSignalPipeline();
  const firstResult = await first;
  assert.strictEqual(second.skipped, true);
  assert.strictEqual(firstResult.synthesized, 1);
  assert.strictEqual(savedFeedRows().length, 1);

  // Once it's done, the next tick with a slot open runs as usual.
  db.dailyCount = 4;
  const fetchesBefore = calls.rss;
  await ssp.runStackSignalPipeline();
  assert.strictEqual(calls.rss, fetchesBefore + 1);
});

test('with nothing published yet, the prompt has no covered list or rule', async () => {
  db.dailyCount = 4;
  clusterReply = JSON.stringify([
    { theme: 'Fed split keeps gold bid', importance: 90, article_indices: [0, 1], suggested_angle: 'Split Fed', category: 'macro' },
  ]);
  const result = await ssp.runStackSignalPipeline();
  const prompt = clusterCall().user;
  assert.ok(!prompt.includes('ALREADY PUBLISHED'));
  assert.ok(!prompt.includes('"already_covered" to true'));
  assert.strictEqual(result.synthesized, 1);
});

test('one or two articles still go through the covered check when the feed has run something', async () => {
  db.dailyCount = 4;
  rssItems = [rssArticles[0]];
  db.recentFeed = [{ title: 'Fed minutes split the committee', published_at: '2026-10-09T09:00:00.000Z' }];
  clusterReply = JSON.stringify([
    { theme: 'Fed minutes again', importance: 85, article_indices: [0], suggested_angle: 'Fed', category: 'macro', already_covered: true },
  ]);
  const result = await ssp.runStackSignalPipeline();
  assert.ok(clusterCall(), 'a single article was checked against the feed');
  assert.match(clusterCall().user, /A distinct story that only one article covers can be its own cluster/);
  assert.strictEqual(result.synthesized, 0);
});

test('the run no longer pays Claude for the editorial that could never save', async () => {
  db.dailyCount = 4;
  db.recentFeed = [
    { title: 'One', published_at: '2026-10-09T06:00:00.000Z' },
    { title: 'Two', published_at: '2026-10-09T09:00:00.000Z' },
    { title: 'Three', published_at: '2026-10-09T11:30:00.000Z' },
  ];
  clusterReply = JSON.stringify([
    { theme: 'Perth Mint backlog tightens silver', importance: 80, article_indices: [2], suggested_angle: 'Mint backlog', category: 'silver', already_covered: false },
  ]);
  const result = await ssp.runStackSignalPipeline();
  assert.strictEqual(result.synthesized, 1);
  assert.strictEqual(calls.claude, 0);
});

test("the flagship gets today's spot written as dollars and is told the articles' prices may be stale", async () => {
  db.recentFeed = [{ title: 'Perth Mint backlog tightens silver', published_at: '2026-10-09T09:00:00.000Z' }];
  await ssp.generateStackSignal('morning');
  assert.strictEqual(calls.claudePrompts.length, 1);
  const prompt = calls.claudePrompts[0];
  assert.match(prompt, /Current spot: Gold \$4,000\.00, Silver \$48\.00\./);
  assert.match(prompt, /prices in them may be stale/);
});
