// Tests that pin the reply rules in Troy's shared prompt, so a later edit
// can't quietly bring back the purchasing power script or drop the length rule.
//   node --test

const test = require('node:test');
const assert = require('node:assert');
const { TROY_PERSONA, TROY_KNOWLEDGE } = require('../src/services/troy-prompt');

test('Troy answers first and keeps replies phone length', () => {
  assert.match(TROY_PERSONA, /Answer the question in your first sentence\./);
  assert.match(TROY_PERSONA, /about two short paragraphs and 120 words/);
});

test('stack questions over a day, a week or a month go to STACK MOVES', () => {
  assert.match(TROY_PERSONA, /answer from the STACK MOVES numbers/);
});

test('purchasing power is no longer required in every stack answer', () => {
  assert.doesNotMatch(TROY_KNOWLEDGE, /USE THIS IN EVERY PORTFOLIO DISCUSSION/);
  assert.doesNotMatch(TROY_KNOWLEDGE, /The dollars are losing value, not the metals gaining it/);
  assert.doesNotMatch(TROY_KNOWLEDGE, /Always lead with the real-world comparison/);
  assert.doesNotMatch(TROY_KNOWLEDGE, /include at least one purchasing power comparison/);
  assert.match(TROY_KNOWLEDGE, /PURCHASING POWER, USED SPARINGLY:/);
  assert.match(TROY_KNOWLEDGE, /at most one comparison in a reply/);
});

test('the injected 1971 numbers are still the ones Troy uses', () => {
  assert.match(TROY_KNOWLEDGE, /use those numbers rather than estimating/);
});
