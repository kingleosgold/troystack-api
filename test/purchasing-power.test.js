// The purchasing power card under Troy's answer and the figures in his prompt
// come from one set of benchmarks, so they can't disagree. node --test
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.SUPABASE_URL ||= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-dummy-service-role-key';

const { purchasingPowerCard, PURCHASING_POWER_BENCHMARKS: B } = require('../src/routes/troy-chat');

test('the card divides by the benchmarks Troy is given', () => {
  const card = purchasingPowerCard({ gold: 4200, silver: 52.5 }, 18000);
  assert.equal(card.goldPerBarrelOfOil, 4200 / B.oil_per_barrel);
  assert.equal(card.silverPerGallonOfGas, 52.5 / B.gas_per_gallon);
  assert.equal(card.stackBarrelsOfOil, 18000 / B.oil_per_barrel);
  assert.equal(card.stackMonthsOfRent, 18000 / B.rent_monthly);
  assert.equal(card.stackHoursOfLabor, 18000 / B.labor_hourly);
});

test('the card matches the stack figures in the prompt for the same stack', () => {
  // The prompt says the stack buys totalValue / oil_per_barrel barrels and
  // totalValue / rent_monthly months of rent. The card has to say the same.
  const totalValue = 25000;
  const card = purchasingPowerCard({ gold: 4000, silver: 50 }, totalValue);
  assert.equal(card.stackBarrelsOfOil.toFixed(1), (totalValue / B.oil_per_barrel).toFixed(1));
  assert.equal(card.stackMonthsOfRent.toFixed(1), (totalValue / B.rent_monthly).toFixed(1));
  assert.equal(card.stackHoursOfLabor.toFixed(1), (totalValue / B.labor_hourly).toFixed(1));
});

test('no hard-coded divisor is left in the card', () => {
  const src = require('node:fs').readFileSync(require.resolve('../src/routes/troy-chat'), 'utf8');
  assert.ok(!/\/\s*85\b/.test(src), 'no division by 85');
  assert.ok(!/\/\s*1850\b/.test(src), 'no division by 1850');
});
