// Guards the App Store links the API hands out. The old listing id
// 6738029817 is dead; a store_url pointing at it would strand users on a
// forced update, so no source file may carry it again.
//   node --test

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const LIVE_ID = '6757343766';
const DEAD_ID = '6738029817';

function sourceFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) return sourceFiles(p);
    return /\.(js|json|txt|md|html)$/.test(d.name) ? [p] : [];
  });
}

test('min-version store_url points at the live App Store listing', () => {
  const router = require('../src/routes/min-version');
  const layer = router.stack.find((l) => l.route && l.route.path === '/');
  let body;
  layer.route.stack[0].handle({}, { json: (b) => { body = b; } });
  assert.ok(body.ios.store_url.includes(`id${LIVE_ID}`), body.ios.store_url);
});

test('no source file carries the dead App Store id', () => {
  const hits = sourceFiles(path.join(__dirname, '..', 'src'))
    .filter((f) => fs.readFileSync(f, 'utf8').includes(DEAD_ID));
  assert.deepStrictEqual(hits, []);
});
