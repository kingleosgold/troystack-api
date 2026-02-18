const express = require('express');
const router = express.Router();
const supabase = require('../lib/supabase');

// GET /v1/vault-watch - COMEX warehouse inventory
router.get('/', async (req, res) => {
  try {
    const { metal = 'silver' } = req.query;
    const validMetals = ['gold', 'silver', 'platinum', 'palladium'];

    if (!validMetals.includes(metal)) {
      return res.status(400).json({ error: `Invalid metal. Use: ${validMetals.join(', ')}` });
    }

    const { data, error } = await supabase
      .from('vault_watch')
      .select('*')
      .eq('metal', metal)
      .order('date', { ascending: false })
      .limit(1)
      .single();

    if (error) throw error;

    res.json({
      metal,
      date: data.date,
      registered_oz: data.registered,
      eligible_oz: data.eligible,
      combined_oz: data.combined,
      daily_change_oz: data.daily_change,
      oversubscribed_ratio: data.oversubscribed_ratio,
      source: 'CME Group',
      updated_at: data.updated_at,
    });
  } catch (err) {
    console.error('Vault watch error:', err);
    res.status(500).json({ error: 'Failed to fetch vault data' });
  }
});

// GET /v1/vault-watch/history?metal=silver&days=30
router.get('/history', async (req, res) => {
  try {
    const { metal = 'silver', days = 30 } = req.query;
    const since = new Date();
    since.setDate(since.getDate() - parseInt(days));

    const { data, error } = await supabase
      .from('vault_watch')
      .select('date, registered, eligible, combined, daily_change')
      .eq('metal', metal)
      .gte('date', since.toISOString().split('T')[0])
      .order('date', { ascending: true });

    if (error) throw error;

    res.json({ metal, days: parseInt(days), data_points: data.length, history: data });
  } catch (err) {
    console.error('Vault history error:', err);
    res.status(500).json({ error: 'Failed to fetch vault history' });
  }
});

module.exports = router;
