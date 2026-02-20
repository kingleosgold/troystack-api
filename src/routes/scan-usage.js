const express = require('express');
const router = express.Router();
const supabase = require('../lib/supabase');

const FREE_SCAN_LIMIT = 5;
const SCAN_PERIOD_DAYS = 30;

// GET /v1/scan-status?userId= — Check receipt scan usage
router.get('/scan-status', async (req, res) => {
  try {
    const userId = req.query.userId || req.query.rcUserId;
    if (!userId) {
      return res.status(400).json({ error: 'userId is required' });
    }

    const { data, error } = await supabase
      .from('scan_usage')
      .select('scans_used, period_start')
      .eq('user_id', userId)
      .single();

    if (error && error.code !== 'PGRST116') throw error; // PGRST116 = no rows

    const now = new Date();

    if (!data) {
      // No record yet — fresh user
      return res.json({
        success: true,
        scansUsed: 0,
        scansLimit: FREE_SCAN_LIMIT,
        periodStart: now.toISOString(),
        resetsAt: new Date(now.getTime() + SCAN_PERIOD_DAYS * 86400000).toISOString(),
      });
    }

    // Check if period has reset
    const periodStart = new Date(data.period_start);
    const resetsAt = new Date(periodStart.getTime() + SCAN_PERIOD_DAYS * 86400000);

    if (now > resetsAt) {
      // Period expired, reset
      await supabase
        .from('scan_usage')
        .update({ scans_used: 0, period_start: now.toISOString() })
        .eq('user_id', userId);

      return res.json({
        success: true,
        scansUsed: 0,
        scansLimit: FREE_SCAN_LIMIT,
        periodStart: now.toISOString(),
        resetsAt: new Date(now.getTime() + SCAN_PERIOD_DAYS * 86400000).toISOString(),
      });
    }

    res.json({
      success: true,
      scansUsed: data.scans_used,
      scansLimit: FREE_SCAN_LIMIT,
      periodStart: data.period_start,
      resetsAt: resetsAt.toISOString(),
    });
  } catch (err) {
    console.error('Scan status error:', err);
    res.status(500).json({ error: 'Failed to get scan status' });
  }
});

// POST /v1/increment-scan — Increment scan count
router.post('/increment-scan', async (req, res) => {
  try {
    const userId = req.body.userId || req.body.rcUserId;
    if (!userId) {
      return res.status(400).json({ error: 'userId is required' });
    }

    const now = new Date();

    // Try to get existing record
    const { data: existing } = await supabase
      .from('scan_usage')
      .select('scans_used, period_start')
      .eq('user_id', userId)
      .single();

    let scansUsed;
    let periodStart;

    if (!existing) {
      // First scan ever — create record
      scansUsed = 1;
      periodStart = now.toISOString();
      await supabase.from('scan_usage').insert({
        user_id: userId,
        scans_used: 1,
        period_start: periodStart,
      });
    } else {
      periodStart = existing.period_start;
      const resetsAt = new Date(new Date(periodStart).getTime() + SCAN_PERIOD_DAYS * 86400000);

      if (now > resetsAt) {
        // Period expired, reset and count this scan
        scansUsed = 1;
        periodStart = now.toISOString();
        await supabase
          .from('scan_usage')
          .update({ scans_used: 1, period_start: periodStart })
          .eq('user_id', userId);
      } else {
        scansUsed = existing.scans_used + 1;
        await supabase
          .from('scan_usage')
          .update({ scans_used: scansUsed })
          .eq('user_id', userId);
      }
    }

    const resetsAt = new Date(new Date(periodStart).getTime() + SCAN_PERIOD_DAYS * 86400000);

    res.json({
      success: true,
      scansUsed,
      scansLimit: FREE_SCAN_LIMIT,
      periodStart,
      resetsAt: resetsAt.toISOString(),
    });
  } catch (err) {
    console.error('Increment scan error:', err);
    res.status(500).json({ error: 'Failed to increment scan count' });
  }
});

module.exports = router;
