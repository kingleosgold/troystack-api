const express = require('express');
const router = express.Router();
const supabase = require('../lib/supabase');

// POST /v1/snapshots — Save a daily portfolio snapshot
router.post('/', async (req, res) => {
  try {
    const {
      userId, totalValue, goldValue, silverValue, platinumValue, palladiumValue,
      goldOz, silverOz, platinumOz, palladiumOz,
      goldSpot, silverSpot, platinumSpot, palladiumSpot,
    } = req.body;

    if (!userId) {
      return res.status(400).json({ error: 'userId is required' });
    }

    const today = new Date().toISOString().split('T')[0];

    const { data, error } = await supabase
      .from('portfolio_snapshots')
      .upsert({
        user_id: userId,
        snapshot_date: today,
        total_value: totalValue || 0,
        gold_value: goldValue || 0,
        silver_value: silverValue || 0,
        platinum_value: platinumValue || 0,
        palladium_value: palladiumValue || 0,
        gold_oz: goldOz || 0,
        silver_oz: silverOz || 0,
        platinum_oz: platinumOz || 0,
        palladium_oz: palladiumOz || 0,
        gold_spot: goldSpot || 0,
        silver_spot: silverSpot || 0,
        platinum_spot: platinumSpot || 0,
        palladium_spot: palladiumSpot || 0,
      }, {
        onConflict: 'user_id,snapshot_date',
      })
      .select()
      .single();

    if (error) throw error;

    res.json({ success: true, snapshot: { date: data.snapshot_date } });
  } catch (err) {
    console.error('Snapshot save error:', err);
    res.status(500).json({ error: 'Failed to save snapshot' });
  }
});

// GET /v1/snapshots/:userId — Retrieve portfolio snapshots
router.get('/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const range = (req.query.range || 'ALL').toUpperCase();

    if (!userId) {
      return res.status(400).json({ error: 'userId is required' });
    }

    // Calculate date cutoff
    let since = null;
    const now = new Date();
    switch (range) {
      case '1W': since = new Date(now - 7 * 86400000); break;
      case '1M': since = new Date(now - 30 * 86400000); break;
      case '3M': since = new Date(now - 90 * 86400000); break;
      case '6M': since = new Date(now - 180 * 86400000); break;
      case '1Y': since = new Date(now - 365 * 86400000); break;
      case 'ALL': default: since = null; break;
    }

    let query = supabase
      .from('portfolio_snapshots')
      .select('snapshot_date, total_value, gold_value, silver_value, platinum_value, palladium_value, gold_oz, silver_oz, platinum_oz, palladium_oz, gold_spot, silver_spot, platinum_spot, palladium_spot')
      .eq('user_id', userId)
      .order('snapshot_date', { ascending: true });

    if (since) {
      query = query.gte('snapshot_date', since.toISOString().split('T')[0]);
    }

    const { data, error } = await query;

    if (error) throw error;

    // Map snapshot_date to date for frontend compatibility
    const snapshots = (data || []).map(s => ({
      ...s,
      date: s.snapshot_date,
    }));

    res.json({
      success: true,
      snapshots,
      count: snapshots.length,
      range,
    });
  } catch (err) {
    console.error('Snapshot fetch error:', err);
    res.status(500).json({ error: 'Failed to fetch snapshots' });
  }
});

module.exports = router;
