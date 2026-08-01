// Tests for sanitizeTTSText v2 fixes (troy-chat.js):
//   1. "The Fed" / "the Fed" no longer double the article
//   2. bare comma-grouped decimals expand fully (no stranded ".23")
//   3. 3+ decimal places on dollar amounts round to cents (no trailing digit)
//   node --test

const test = require('node:test');
const assert = require('node:assert');

require('dotenv').config(); // src/lib/supabase.js (transitively required) needs env at load
const { sanitizeTTSText } = require('../src/routes/troy-chat');

test('"The Fed held rates" keeps a single article', () => {
  assert.strictEqual(sanitizeTTSText('The Fed held rates'), 'The Fed held rates');
});

test('"the Fed" keeps a single article', () => {
  assert.strictEqual(sanitizeTTSText('the Fed'), 'the Fed');
});

test('bare "Fed" still gains its article', () => {
  assert.strictEqual(sanitizeTTSText('Fed'), 'the Fed');
  assert.strictEqual(sanitizeTTSText('What will Fed policy do?'), 'What will the Fed policy do?');
});

test('"6,196.00 oz of silver" expands fully (no stranded digits)', () => {
  assert.strictEqual(
    sanitizeTTSText('6,196.00 oz of silver'),
    'six thousand, one hundred ninety-six ounces of silver'
  );
});

test('"126,166.23 dollars" (no $) expands the full decimal', () => {
  assert.strictEqual(
    sanitizeTTSText('126,166.23 dollars'),
    'one hundred twenty-six thousand, one hundred sixty-six point two three dollars'
  );
});

test('"$126,166.234" rounds to cents, no trailing digit', () => {
  assert.strictEqual(
    sanitizeTTSText('$126,166.234'),
    'one hundred twenty-six thousand, one hundred sixty-six dollars and twenty-three cents'
  );
});

test('original "$126,166.23" expansion unchanged', () => {
  assert.strictEqual(
    sanitizeTTSText('$126,166.23'),
    'one hundred twenty-six thousand, one hundred sixty-six dollars and twenty-three cents'
  );
});

test('cents carry: "$1.999" rounds up to two dollars', () => {
  assert.strictEqual(sanitizeTTSText('$1.999'), 'two dollars');
});

test('half-cent rounds half-up via string math: "$1.005" → one cent', () => {
  assert.strictEqual(sanitizeTTSText('$1.005'), 'one dollar and one cent');
});

test('half-cent rounds half-up via string math: "$2.675" → sixty-eight cents', () => {
  assert.strictEqual(sanitizeTTSText('$2.675'), 'two dollars and sixty-eight cents');
});

test('no sanitized output contains a period glued to a digit', () => {
  const inputs = [
    'Your total gain is $126,166.23 since you started stacking.',
    'Your 6,196 oz of silver got you 22,202.3 gallons of gas.',
    'Up 126,166.23 dollars, or 44%.',
  ];
  for (const input of inputs) {
    const out = sanitizeTTSText(input);
    assert.ok(!/\.\d/.test(out), `stranded decimal in: ${JSON.stringify(out)}`);
    assert.ok(!/\b[Tt]he [Tt]he\b/.test(out), `doubled article in: ${JSON.stringify(out)}`);
  }
});
