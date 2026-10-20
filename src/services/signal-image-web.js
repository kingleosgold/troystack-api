// Web copies of the Signal's hero images. The 510 pool images are 1792x1024
// PNGs from DALL-E, about 3 MB each, and every Signal page and card loads one,
// which is slow on a phone. This makes a 1200px JPEG of each, about a tenth
// the size, at web/<name>.jpg in the same public bucket, then points every
// article still on the PNG at its copy. The PNGs stay where they are.
//
// Runs in small batches from a cron in index.js until every image has a copy,
// then each run is two folder lists and a select. Re-run safe.
//
// Rows only move once migration 013 has copied every image_url to
// signal_image_url_backup. Rollback is in that migration's header.

const BUCKET = 'stack-signal-images';
const WEB_DIR = 'web';
const WIDTH = 1200;
const QUALITY = 72;
const BATCH = 20;
const MIN_BYTES = 2 * 1024;
const PAGE = 1000;
const ID_CHUNK = 150;

const MARKER = `/${BUCKET}/`;

// "abc.png" -> "web/abc.jpg". Only top-level PNGs have a web copy.
function webName(name) {
  if (!name || name.includes('/') || !name.endsWith('.png')) return null;
  return `${WEB_DIR}/${name.slice(0, -4)}.jpg`;
}

// The new URL for a row's image_url, or null when it isn't a pool PNG with a
// finished copy in `ready`.
function webUrlFor(imageUrl, ready) {
  if (typeof imageUrl !== 'string') return null;
  const at = imageUrl.lastIndexOf(MARKER);
  if (at === -1) return null;
  const name = imageUrl.slice(at + MARKER.length);
  const target = webName(name);
  if (!target || !ready.has(target)) return null;
  return imageUrl.slice(0, at + MARKER.length) + target;
}

async function listAll(storage, dir) {
  const out = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await storage.list(dir, { limit: 1000, offset, sortBy: { column: 'name', order: 'asc' } });
    if (error) throw new Error(`list ${dir || '/'} failed: ${error.message}`);
    out.push(...(data || []));
    if (!data || data.length < 1000) return out;
  }
}

async function toJpeg(buffer, sharp) {
  return sharp(buffer)
    .resize({ width: WIDTH, withoutEnlargement: true })
    .jpeg({ quality: QUALITY, mozjpeg: true, progressive: true })
    .toBuffer();
}

async function makeCopies({ supabase, sharp, batch = BATCH, log = console.log }) {
  const storage = supabase.storage.from(BUCKET);
  const pngs = (await listAll(storage, '')).filter(o => webName(o.name));
  const done = await listAll(storage, WEB_DIR);
  const ready = new Set(
    done.filter(o => (o.metadata?.size || 0) >= MIN_BYTES).map(o => `${WEB_DIR}/${o.name}`)
  );

  const todo = pngs.filter(o => !ready.has(webName(o.name))).slice(0, batch);
  let made = 0;
  for (const obj of todo) {
    const target = webName(obj.name);
    try {
      const { data: blob, error } = await storage.download(obj.name);
      if (error) throw new Error(error.message);
      const jpeg = await toJpeg(Buffer.from(await blob.arrayBuffer()), sharp);
      if (jpeg.length < MIN_BYTES) throw new Error(`copy is only ${jpeg.length} bytes`);
      const { error: upErr } = await storage.upload(target, jpeg, {
        contentType: 'image/jpeg',
        cacheControl: '31536000',
        upsert: true,
      });
      if (upErr) throw new Error(upErr.message);
      ready.add(target);
      made++;
    } catch (err) {
      log(`[Signal Images] ${obj.name} skipped: ${err.message}`);
    }
  }
  return { ready, made, left: pngs.filter(o => !ready.has(webName(o.name))).length };
}

// A plain select, not a HEAD: postgrest-js reads a HEAD 404 for a missing
// table as a 204 with no error.
async function backupExists(supabase) {
  const { data, error } = await supabase.from('signal_image_url_backup').select('id').limit(1);
  return !error && Array.isArray(data);
}

// Every article still on a pool PNG, paged by id.
async function pngRows(supabase) {
  const rows = [];
  let lastId = null;
  for (;;) {
    let q = supabase
      .from('stack_signal_articles')
      .select('id, image_url')
      .like('image_url', `%${MARKER}%.png`);
    if (lastId !== null) q = q.gt('id', lastId);
    const { data, error } = await q.order('id', { ascending: true }).limit(PAGE);
    if (error) throw new Error(`article read failed: ${error.message}`);
    rows.push(...(data || []));
    if (!data || data.length < PAGE) return rows;
    lastId = data[data.length - 1].id;
  }
}

async function moveRows({ supabase, ready }) {
  const byUrl = new Map();
  for (const row of await pngRows(supabase)) {
    const next = webUrlFor(row.image_url, ready);
    if (!next) continue;
    const key = `${row.image_url}\n${next}`;
    if (!byUrl.has(key)) byUrl.set(key, { from: row.image_url, to: next, ids: [] });
    byUrl.get(key).ids.push(row.id);
  }

  let moved = 0;
  for (const { from, to, ids } of byUrl.values()) {
    for (let i = 0; i < ids.length; i += ID_CHUNK) {
      const chunk = ids.slice(i, i + ID_CHUNK);
      // The image_url match keeps a row an editor changed since the read.
      const { error: upErr } = await supabase
        .from('stack_signal_articles')
        .update({ image_url: to })
        .in('id', chunk)
        .eq('image_url', from);
      if (upErr) throw new Error(`article update failed after ${moved} rows: ${upErr.message}`);
      moved += chunk.length;
    }
  }
  return moved;
}

async function runSignalImageWeb({ supabase = require('../lib/supabase'), sharp = require('sharp'), batch = BATCH, log = console.log } = {}) {
  const { ready, made, left } = await makeCopies({ supabase, sharp, batch, log });
  if (!(await backupExists(supabase))) {
    return { made, left, moved: 0, waiting: 'migration 013' };
  }
  const moved = await moveRows({ supabase, ready });
  return { made, left, moved };
}

module.exports = { runSignalImageWeb, webName, webUrlFor, toJpeg, BUCKET, WIDTH };
