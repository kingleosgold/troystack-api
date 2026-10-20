// Signal hero images get a light JPEG copy and articles move to it.
//   node --test
// Supabase is a fake. sharp is real, on a generated PNG.

const test = require('node:test');
const assert = require('node:assert');
const sharp = require('sharp');

const { runSignalImageWeb, webName, webUrlFor, toJpeg, WIDTH } = require('../src/services/signal-image-web');

const BASE = 'https://proj.supabase.co/storage/v1/object/public/stack-signal-images/';

// A 1792x1024 PNG of soft noise, close to a photo: large as a PNG and well
// above the 10 KB floor as a JPEG. Built once, it takes a moment.
let pngCache = null;
async function bigPng() {
  if (pngCache) return pngCache;
  const w = 1792;
  const h = 1024;
  const raw = require('node:crypto').randomBytes(w * h * 3);
  const soft = await sharp(raw, { raw: { width: w, height: h, channels: 3 } }).blur(1.5).raw().toBuffer();
  pngCache = await sharp(soft, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
  return pngCache;
}

function fakeSupabase({ files, rows, backup = true, failDownload = new Set() }) {
  const uploads = [];
  const updates = [];
  const storage = {
    async list(dir, { limit, offset }) {
      const prefix = dir ? `${dir}/` : '';
      const names = Object.keys(files)
        .filter(n => n.startsWith(prefix) && !n.slice(prefix.length).includes('/'))
        .sort()
        .slice(offset, offset + limit);
      return { data: names.map(n => ({ name: n.slice(prefix.length), metadata: { size: files[n].length } })), error: null };
    },
    async download(name) {
      if (failDownload.has(name) || !files[name]) return { data: null, error: { message: 'not found' } };
      const buf = files[name];
      return { data: { arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length) }, error: null };
    },
    async upload(name, buf, opts) {
      uploads.push({ name, opts, size: buf.length });
      files[name] = buf;
      return { error: null };
    },
  };
  return {
    uploads,
    updates,
    storage: { from: (bucket) => { assert.strictEqual(bucket, 'stack-signal-images'); return storage; } },
    from(table) {
      if (table === 'signal_image_url_backup') {
        const q = { select() { return q; }, limit() { return Promise.resolve({ error: backup ? null : { message: 'relation does not exist' } }); } };
        return q;
      }
      assert.strictEqual(table, 'stack_signal_articles');
      return {
        select() {
          const q = {
            like(col, pattern) {
              assert.strictEqual(col, 'image_url');
              const re = new RegExp('^' + pattern.split('%').map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
              q.matched = rows.filter(r => typeof r.image_url === 'string' && re.test(r.image_url));
              return q;
            },
            limit(n) { return Promise.resolve({ data: q.matched.slice(0, n).map(r => ({ ...r })), error: null }); },
          };
          return q;
        },
        update(values) {
          return {
            in(col, ids) {
              return {
                eq(col2, from) {
                  updates.push({ values, ids, from });
                  for (const r of rows) if (ids.includes(r.id) && r.image_url === from) r.image_url = values.image_url;
                  return Promise.resolve({ error: null });
                },
              };
            },
          };
        },
      };
    },
  };
}

test('only top-level PNGs get a web name', () => {
  assert.strictEqual(webName('gold-2026-10-06.png'), 'web/gold-2026-10-06.jpg');
  assert.strictEqual(webName('web/gold.jpg'), null);
  assert.strictEqual(webName('gold.jpg'), null);
  assert.strictEqual(webName(''), null);
});

test('a URL moves only when its copy is ready, and keeps its host', () => {
  const ready = new Set(['web/a.jpg']);
  assert.strictEqual(webUrlFor(`${BASE}a.png`, ready), `${BASE}web/a.jpg`);
  assert.strictEqual(webUrlFor(`${BASE}b.png`, ready), null);
  assert.strictEqual(webUrlFor('https://cdn.example.com/a.png', ready), null);
  assert.strictEqual(webUrlFor(null, ready), null);
  assert.strictEqual(webUrlFor(`${BASE}web/a.jpg`, ready), null);
});

test('the copy is a 1200px JPEG far smaller than the PNG', async () => {
  const png = await bigPng();
  const jpeg = await toJpeg(png, sharp);
  const meta = await sharp(jpeg).metadata();
  assert.strictEqual(meta.format, 'jpeg');
  assert.strictEqual(meta.width, WIDTH);
  assert.strictEqual(meta.height, Math.round(1024 * WIDTH / 1792));
  assert.ok(jpeg.length < png.length / 4, `${jpeg.length} vs ${png.length}`);
});

test('a run makes a batch of copies, then moves only the rows whose copy exists', async () => {
  const png = await bigPng();
  const files = { 'a.png': png, 'b.png': png, 'c.png': png };
  const rows = [
    { id: '1', image_url: `${BASE}a.png` },
    { id: '2', image_url: `${BASE}a.png` },
    { id: '3', image_url: `${BASE}c.png` },
    { id: '4', image_url: null },
    { id: '5', image_url: 'https://elsewhere.example.com/x.png' },
  ];
  const sb = fakeSupabase({ files, rows });

  const first = await runSignalImageWeb({ supabase: sb, sharp, batch: 2, log: () => {} });
  assert.deepStrictEqual({ made: first.made, left: first.left, moved: first.moved }, { made: 2, left: 1, moved: 2 });
  assert.deepStrictEqual(sb.uploads.map(u => u.name), ['web/a.jpg', 'web/b.jpg']);
  assert.ok(sb.uploads.every(u => u.opts.contentType === 'image/jpeg' && u.opts.cacheControl === '31536000'));
  assert.deepStrictEqual(rows.map(r => r.image_url), [
    `${BASE}web/a.jpg`, `${BASE}web/a.jpg`, `${BASE}c.png`, null, 'https://elsewhere.example.com/x.png',
  ]);
  assert.ok(files['a.png'], 'the PNG stays');

  const second = await runSignalImageWeb({ supabase: sb, sharp, batch: 2, log: () => {} });
  assert.deepStrictEqual({ made: second.made, left: second.left, moved: second.moved }, { made: 1, left: 0, moved: 1 });
  assert.strictEqual(rows[2].image_url, `${BASE}web/c.jpg`);

  const third = await runSignalImageWeb({ supabase: sb, sharp, batch: 2, log: () => {} });
  assert.deepStrictEqual({ made: third.made, left: third.left, moved: third.moved }, { made: 0, left: 0, moved: 0 });
  assert.strictEqual(sb.uploads.length, 3, 'nothing is made twice');
});

test('rows wait until the backup table exists', async () => {
  const png = await bigPng();
  const rows = [{ id: '1', image_url: `${BASE}a.png` }];
  const sb = fakeSupabase({ files: { 'a.png': png }, rows, backup: false });
  const r = await runSignalImageWeb({ supabase: sb, sharp, log: () => {} });
  assert.strictEqual(r.made, 1);
  assert.strictEqual(r.moved, 0);
  assert.strictEqual(r.waiting, 'migration 013');
  assert.strictEqual(rows[0].image_url, `${BASE}a.png`);
  assert.strictEqual(sb.updates.length, 0);
});

test('a failed download skips that image and its rows, the rest carry on', async () => {
  const png = await bigPng();
  const rows = [{ id: '1', image_url: `${BASE}a.png` }, { id: '2', image_url: `${BASE}b.png` }];
  const lines = [];
  const sb = fakeSupabase({ files: { 'a.png': png, 'b.png': png }, rows, failDownload: new Set(['a.png']) });
  const r = await runSignalImageWeb({ supabase: sb, sharp, log: l => lines.push(l) });
  assert.deepStrictEqual({ made: r.made, left: r.left, moved: r.moved }, { made: 1, left: 1, moved: 1 });
  assert.strictEqual(rows[0].image_url, `${BASE}a.png`);
  assert.strictEqual(rows[1].image_url, `${BASE}web/b.jpg`);
  assert.ok(lines.some(l => l.includes('a.png skipped')));
});

test('a copy under 10 KB in the folder counts as missing and is made again', async () => {
  const png = await bigPng();
  const files = { 'a.png': png, 'web/a.jpg': Buffer.alloc(100) };
  const rows = [{ id: '1', image_url: `${BASE}a.png` }];
  const sb = fakeSupabase({ files, rows });
  const r = await runSignalImageWeb({ supabase: sb, sharp, log: () => {} });
  assert.strictEqual(r.made, 1);
  assert.ok(files['web/a.jpg'].length > 10 * 1024);
  assert.strictEqual(rows[0].image_url, `${BASE}web/a.jpg`);
});
