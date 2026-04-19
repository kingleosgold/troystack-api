const fs = require('fs');
const path = require('path');

let CACHED = null;

function loadChecks() {
  if (CACHED) return CACHED;
  const dir = path.join(__dirname, 'checks');
  const all = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.js')) continue;
    const mod = require(path.join(dir, f));
    const arr = Array.isArray(mod) ? mod : Array.isArray(mod && mod.default) ? mod.default : [];
    for (const c of arr) {
      if (c && typeof c.execute === 'function') all.push(c);
    }
  }
  CACHED = all;
  return all;
}

function getChecks() {
  return loadChecks().map(c => ({ id: c.id, category: c.category, label: c.label }));
}

async function runAllChecks() {
  const checks = loadChecks();
  const startedAt = Date.now();
  const settled = await Promise.allSettled(checks.map(c => c.execute()));
  const results = settled.map((s, i) => {
    if (s.status === 'fulfilled') return s.value;
    const c = checks[i];
    return {
      id: c.id,
      category: c.category,
      label: c.label,
      status: 'unknown',
      details: 'orchestrator rejection (should not happen — defineCheck swallows errors)',
      timestamp: new Date().toISOString(),
      durationMs: 0,
    };
  });
  return { checks: results, totalDurationMs: Date.now() - startedAt };
}

async function runCheck(id) {
  const c = loadChecks().find(x => x.id === id);
  if (!c) return null;
  return await c.execute();
}

module.exports = { runAllChecks, runCheck, getChecks };
