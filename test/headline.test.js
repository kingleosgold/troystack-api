// Google News' " - Publisher" tag comes off a Signal title only when the title
// is that source's headline copied whole.
//   node --test

const test = require('node:test');
const assert = require('node:assert');
const { stripSourceTag } = require('../src/services/headline');

const gn = 'https://news.google.com/rss/articles/CBMiabc?oc=5';

test('a copied Google News headline loses its publisher tag', () => {
  const title = 'Gold steady as yields rise - Reuters';
  assert.strictEqual(stripSourceTag(title, [{ url: gn, name: 'Google News PM', title }]), 'Gold steady as yields rise');
});

test('a raw feed item works the same, by link and title', () => {
  const title = 'Gold steady as yields rise - Reuters';
  assert.strictEqual(stripSourceTag(title, [{ link: gn, source: 'Google News PM', title }]), 'Gold steady as yields rise');
});

test("older rows match by Google's description or the publisher's name", () => {
  const title = 'Current price of gold as of March 6, 2026 - Fortune';
  assert.strictEqual(
    stripSourceTag(title, [{ url: gn, name: 'Google News PM', description: 'Current price of gold as of March 6, 2026  Fortune' }]),
    'Current price of gold as of March 6, 2026',
  );
  assert.strictEqual(stripSourceTag('Gold slips - KITCO', [{ url: gn, name: 'Kitco News' }]), 'Gold slips - KITCO');
  assert.strictEqual(stripSourceTag('Gold slips - CNBC', [{ url: gn, name: 'cnbc' }]), 'Gold slips');
});

test('only the last dash goes', () => {
  const title = 'Gold market analysis - key levels for traders - KITCO';
  assert.strictEqual(stripSourceTag(title, [{ url: gn, title }]), 'Gold market analysis - key levels for traders');
});

test("a dash in Troy's own title or a non-Google feed's headline stays", () => {
  const theme = 'Silver Down 3% - Large Range Formation Building?';
  assert.strictEqual(stripSourceTag(theme, [{ url: 'https://seekingalpha.com/article/1', title: theme }]), theme);
  assert.strictEqual(
    stripSourceTag('Central banks buy - and keep buying', [{ url: gn, title: 'Central banks add gold - Reuters' }]),
    'Central banks buy - and keep buying',
  );
});

test('titles with no tag, or odd input, come back as they were', () => {
  assert.strictEqual(stripSourceTag('Gold holds', [{ url: gn, title: 'Gold holds' }]), 'Gold holds');
  assert.strictEqual(stripSourceTag(' - Reuters', [{ url: gn, title: ' - Reuters' }]), ' - Reuters');
  assert.strictEqual(stripSourceTag('Gold - ', [{ url: gn, title: 'Gold - ' }]), 'Gold - ');
  assert.strictEqual(stripSourceTag(null, []), null);
  assert.strictEqual(stripSourceTag('A - B', null), 'A - B');
  assert.strictEqual(stripSourceTag('A - B', [{ url: 'not a url', title: 'A - B' }]), 'A - B');
});

test('a title with a dash before a double space stays whole, as the migration leaves it', () => {
  const title = 'Gold rallies - silver -  Reuters';
  assert.strictEqual(stripSourceTag(title, [{ url: gn, title }]), title);
});
