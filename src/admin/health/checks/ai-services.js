const axios = require('axios');
const { defineCheck } = require('../define-check');
const { callClaude, callGemini, MODELS } = require('../../../services/ai-router');

function classifyLatency(ms, okMs, warnMs) {
  if (ms < okMs) return 'green';
  if (ms < warnMs) return 'yellow';
  return 'red';
}

module.exports = [
  defineCheck({
    id: 'claude_api_reachable',
    category: 'ai_services',
    label: 'Claude API',
    async run() {
      const t0 = Date.now();
      try {
        await callClaude('You are a ping responder. Reply with exactly "pong".', 'ping', { maxTokens: 10 });
        const ms = Date.now() - t0;
        return {
          status: classifyLatency(ms, 3000, 5000),
          details: `Round-trip ${ms}ms`,
          metric: { value: ms, unit: 'ms', label: 'Round-trip' },
        };
      } catch (err) {
        return { status: 'red', details: `Claude error: ${err.message}` };
      }
    },
  }),

  defineCheck({
    id: 'gemini_api_reachable',
    category: 'ai_services',
    label: 'Gemini Flash API',
    async run() {
      const t0 = Date.now();
      try {
        await callGemini(MODELS.flash, 'You are a ping responder. Reply with exactly "pong".', 'ping', {
          maxOutputTokens: 10,
        });
        const ms = Date.now() - t0;
        return {
          status: classifyLatency(ms, 3000, 5000),
          details: `Round-trip ${ms}ms`,
          metric: { value: ms, unit: 'ms', label: 'Round-trip' },
        };
      } catch (err) {
        return { status: 'red', details: `Gemini error: ${err.message}` };
      }
    },
  }),

  defineCheck({
    id: 'elevenlabs_api_reachable',
    category: 'ai_services',
    label: 'ElevenLabs API',
    async run() {
      const key = process.env.ELEVENLABS_API_KEY;
      if (!key) return { status: 'red', details: 'ELEVENLABS_API_KEY not configured' };
      const t0 = Date.now();
      try {
        // /v1/user is scope-agnostic: any valid key authenticates, regardless of
        // whether it has Voices/Models/TTS permissions set. /v1/voices previously
        // 401'd on keys scoped only to text-to-speech even though prod TTS works.
        const resp = await axios.get('https://api.elevenlabs.io/v1/user', {
          headers: { 'xi-api-key': key },
          timeout: 4000,
        });
        const ms = Date.now() - t0;
        if (resp.status !== 200) return { status: 'red', details: `Account probe status ${resp.status}, ${ms}ms` };
        const status = ms < 2000 ? 'green' : 'red';
        return {
          status,
          details: `Account probe ${ms}ms`,
          metric: { value: ms, unit: 'ms', label: 'Round-trip' },
        };
      } catch (err) {
        return { status: 'red', details: `Account probe failed: ${err.message}` };
      }
    },
  }),

  defineCheck({
    id: 'yahoo_finance_reachable',
    category: 'ai_services',
    label: 'Yahoo Finance',
    async run() {
      const t0 = Date.now();
      try {
        const resp = await axios.get('https://query1.finance.yahoo.com/v8/finance/chart/GC=F', {
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TroyStack/1.0)' },
          timeout: 4000,
        });
        const ms = Date.now() - t0;
        const price = resp.data && resp.data.chart && resp.data.chart.result
          && resp.data.chart.result[0] && resp.data.chart.result[0].meta
          && resp.data.chart.result[0].meta.regularMarketPrice;
        if (!price) return { status: 'red', details: `Yahoo returned no price, ${ms}ms` };
        const status = ms < 3000 ? 'green' : 'red';
        return {
          status,
          details: `Round-trip ${ms}ms, GC=F $${price}`,
          metric: { value: ms, unit: 'ms', label: 'Round-trip' },
        };
      } catch (err) {
        return { status: 'red', details: `Yahoo error: ${err.message}` };
      }
    },
  }),
];
