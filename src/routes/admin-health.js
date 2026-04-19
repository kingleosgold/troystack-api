const express = require('express');
const { runAllChecks, runCheck } = require('../admin/health');

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

module.exports = router;
