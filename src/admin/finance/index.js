const fs = require('fs');
const path = require('path');
const supabase = require('../../lib/supabase');

let CACHED = null;

function loadSources() {
  if (CACHED) return CACHED;
  const dir = path.join(__dirname, 'sources');
  const all = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.js')) continue;
    const mod = require(path.join(dir, f));
    if (mod && typeof mod.execute === 'function') all.push(mod);
  }
  CACHED = all;
  return all;
}

function getCostSources() {
  return loadSources().map(s => ({
    id: s.id,
    category: s.category,
    label: s.label,
    source_type: s.source_type,
  }));
}

async function runCostSource(id) {
  const s = loadSources().find(x => x.id === id);
  if (!s) return null;
  return await s.execute();
}

function todayET() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

async function runAllCostSources() {
  const sources = loadSources();
  const startedAt = Date.now();

  const settled = await Promise.allSettled(sources.map(s => s.execute()));
  const results = settled.map((s, i) => {
    if (s.status === 'fulfilled') return s.value;
    const src = sources[i];
    return {
      id: src.id,
      source: src.id,
      category: src.category,
      label: src.label,
      source_type: src.source_type,
      amount_usd: '0.0000',
      units: null,
      unit_type: null,
      details: 'ERROR: orchestrator rejection (should not happen — defineCostSource swallows)',
      raw_data: null,
      error: 'orchestrator rejection',
      durationMs: 0,
    };
  });

  const snapshot_date = todayET();
  const rows = results.map(r => ({
    snapshot_date,
    source: r.source,
    category: r.category,
    amount_usd: r.amount_usd,
    units: r.units,
    unit_type: r.unit_type,
    details: r.details,
    raw_data: r.raw_data,
    source_type: r.source_type || 'api',
  }));

  let upsertError = null;
  if (rows.length) {
    const { error } = await supabase
      .from('cost_snapshots')
      .upsert(rows, { onConflict: 'snapshot_date,source' });
    if (error) {
      console.error('[Finance] cost_snapshots upsert failed:', error.message);
      upsertError = error.message;
    }
  }

  const errored = results.filter(r => r.error || (r.details || '').startsWith('ERROR:')).length;
  const totalUsd = results.reduce((sum, r) => sum + parseFloat(r.amount_usd || 0), 0);

  const summary = {
    snapshot_date,
    total_sources: results.length,
    ok: results.length - errored,
    errored,
    total_usd: totalUsd.toFixed(2),
    duration_ms: Date.now() - startedAt,
    upsert_error: upsertError,
  };

  return { summary, results };
}

module.exports = { runAllCostSources, runCostSource, getCostSources };
