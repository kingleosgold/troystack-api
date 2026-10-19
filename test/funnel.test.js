// Funnel counts from troystack.ai's Gold page.
//   node --test
// Pure in-process tests: supabase is a fake that records each rpc call.

const test = require('node:test');
const assert = require('node:assert');

const { bumpFunnel, createFunnelHandler } = require('../src/routes/funnel');

function fakeSupabase(answer = { error: null }) {
  const calls = [];
  return {
    calls,
    rpc: async (name, args) => {
      calls.push([name, args]);
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
}

function fakeRes() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    end() { return this; },
  };
}

test('a site step counts once for today with its plan and surface', async () => {
  const supabase = fakeSupabase();
  const res = fakeRes();
  await createFunnelHandler({ supabase })({ body: { step: 'plan_tap', plan: 'yearly', campaign: 'webapp-gold' } }, res);
  assert.strictEqual(res.statusCode, 204);
  assert.strictEqual(supabase.calls.length, 1);
  const [name, args] = supabase.calls[0];
  assert.strictEqual(name, 'bump_funnel_count');
  assert.match(args.p_day, /^\d{4}-\d{2}-\d{2}$/);
  assert.deepStrictEqual({ ...args, p_day: undefined }, { p_day: undefined, p_step: 'plan_tap', p_plan: 'yearly', p_campaign: 'webapp-gold' });
});

test('checkout_open and unknown steps are refused from the site', async () => {
  for (const step of ['checkout_open', 'purchase', undefined]) {
    const supabase = fakeSupabase();
    const res = fakeRes();
    await createFunnelHandler({ supabase })({ body: { step } }, res);
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(supabase.calls.length, 0);
  }
});

test('an unknown plan or a malformed surface counts as blank', async () => {
  const supabase = fakeSupabase();
  await bumpFunnel(supabase, { step: 'gold_view', plan: 'forever', campaign: 'Not OK!' }, new Date('2026-10-19T12:00:00Z'));
  assert.deepStrictEqual(supabase.calls[0][1], { p_day: '2026-10-19', p_step: 'gold_view', p_plan: '', p_campaign: '' });
});

test('a count that fails never throws', async () => {
  assert.strictEqual(await bumpFunnel(fakeSupabase({ error: { message: 'down' } }), { step: 'signup' }), false);
  assert.strictEqual(await bumpFunnel(fakeSupabase(new Error('network')), { step: 'signup' }), false);
});
