const express = require('express');
const { runAllChecks, runCheck } = require('../admin/health');
const { runAllCostSources } = require('../admin/finance');
const supabase = require('../lib/supabase');

const router = express.Router();

function adminAuth(req, res, next) {
  const expected = process.env.ADMIN_AUTH_KEY;
  if (!expected) {
    console.error('[AdminHealth] ADMIN_AUTH_KEY not set — rejecting admin request (fail-closed)');
    return res.status(401).json({ error: 'unauthorized' });
  }
  const got = req.header('X-Admin-Auth-Key');
  if (got !== expected) return res.status(401).json({ error: 'unauthorized' });
  next();
}

function summarize(results) {
  const summary = { green: 0, yellow: 0, red: 0, unknown: 0 };
  for (const r of results) {
    const s = r && r.status;
    summary[s] = (summary[s] || 0) + 1;
  }
  let overall;
  if (summary.red > 0) overall = 'red';
  else if (summary.yellow > 0) overall = 'yellow';
  else overall = 'green';
  const total = results.length;
  if (total > 0 && summary.unknown / total > 0.5) overall = 'yellow';
  return { overall, summary };
}

function envelope(results, totalDurationMs) {
  const { overall, summary } = summarize(results);
  return {
    product: 'troystack',
    version: process.env.npm_package_version || 'unknown',
    timestamp: new Date().toISOString(),
    overall_status: overall,
    summary,
    total_duration_ms: totalDurationMs,
  };
}

router.get('/health', async (_req, res) => {
  try {
    const { checks, totalDurationMs } = await runAllChecks();
    res.json(envelope(checks, totalDurationMs));
  } catch (err) {
    console.error('[AdminHealth] /health failed:', err.message);
    res.status(500).json({ error: 'health check failed' });
  }
});

router.get('/health/detailed', adminAuth, async (_req, res) => {
  try {
    const { checks, totalDurationMs } = await runAllChecks();
    res.json({ ...envelope(checks, totalDurationMs), checks });
  } catch (err) {
    console.error('[AdminHealth] /health/detailed failed:', err.message);
    res.status(500).json({ error: 'health check failed' });
  }
});

router.get('/health/:checkId', adminAuth, async (req, res) => {
  try {
    const out = await runCheck(req.params.checkId);
    if (!out) return res.status(404).json({ error: 'check not found' });
    res.json(out);
  } catch (err) {
    console.error('[AdminHealth] single-check failed:', err.message);
    res.status(500).json({ error: 'check failed' });
  }
});

// Manually trigger the finance orchestrator (testing, backfill, investigation).
// GET would be wrong — this mutates cost_snapshots. POST is idempotent-by-upsert
// against today's (snapshot_date, source) key but still a state change.
router.post('/finance/run-now', adminAuth, async (_req, res) => {
  try {
    const result = await runAllCostSources();
    res.json(result);
  } catch (err) {
    console.error('[AdminHealth] /finance/run-now failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Read-only: most recent snapshot's rows, ordered by spend desc.
router.get('/finance/costs/latest', adminAuth, async (_req, res) => {
  try {
    const latestResp = await supabase.from('cost_snapshots')
      .select('snapshot_date').order('snapshot_date', { ascending: false }).limit(1);
    if (latestResp.error) {
      console.error('[AdminHealth] /finance/costs/latest latest-date query:', latestResp.error.message);
      return res.status(500).json({ error: 'cost_snapshots query failed' });
    }
    if (!latestResp.data || !latestResp.data.length) {
      return res.status(404).json({ error: 'no snapshots yet' });
    }
    const snapshot_date = latestResp.data[0].snapshot_date;
    const { data: rows, error } = await supabase.from('cost_snapshots')
      .select('source,category,amount_usd,units,unit_type,details,source_type,created_at')
      .eq('snapshot_date', snapshot_date)
      .order('amount_usd', { ascending: false });
    if (error) {
      console.error('[AdminHealth] /finance/costs/latest rows query:', error.message);
      return res.status(500).json({ error: 'cost_snapshots query failed' });
    }
    const total_usd = (rows || []).reduce((sum, r) => sum + parseFloat(r.amount_usd || 0), 0);
    res.json({
      snapshot_date,
      source_count: (rows || []).length,
      total_usd: total_usd.toFixed(2),
      sources: rows || [],
    });
  } catch (err) {
    console.error('[AdminHealth] /finance/costs/latest failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
