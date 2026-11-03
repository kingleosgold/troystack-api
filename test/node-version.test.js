// Railway builds this API with Railpack, which picks Node from
// package.json engines.node. A range like ">=20.9.0" resolves to its lower
// major, so production ran Node 20 while yahoo-finance2 needs 22 or later and
// CI tests on 22. This keeps the pin, the lockfile and CI on the same major.
//   node --test

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const pkg = require('../package.json');
const lock = require('../package-lock.json');

test('engines.node pins Node 22 so Railpack builds on 22', () => {
  assert.strictEqual(pkg.engines.node, '22.x');
});

test('the lockfile root carries the same engines.node', () => {
  assert.strictEqual(lock.packages[''].engines.node, pkg.engines.node);
});

test('CI tests on the same Node major production runs', () => {
  const ci = fs.readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8');
  const m = ci.match(/node-version:\s*['"]?(\d+)/);
  assert.ok(m, 'ci.yml sets node-version');
  assert.strictEqual(m[1], pkg.engines.node.split('.')[0]);
});

test('yahoo-finance2 supports the pinned Node major', (t) => {
  // Not an exported path, so read the file directly. Skip if a later
  // yahoo-finance2 moves it rather than fail an unrelated bump.
  const file = path.join(root, 'node_modules/yahoo-finance2/esm/src/createYahooFinance.js');
  if (!fs.existsSync(file)) return t.skip('yahoo-finance2 moved its runtime check');
  const m = fs.readFileSync(file, 'utf8').match(/node:\s*"(\d+)\./);
  if (!m) return t.skip('yahoo-finance2 no longer names a minimum Node');
  assert.ok(Number(pkg.engines.node.split('.')[0]) >= Number(m[1]));
});
