const express = require('express');
const router = express.Router();
const supabase = require('../lib/supabase');

const VALID_METALS = ['gold', 'silver', 'platinum', 'palladium'];
const ALL_FIELDS = 'date, metal, registered_oz, eligible_oz, combined_oz, registered_change_oz, eligible_change_oz, combined_change_oz, open_interest_oz, oversubscribed_ratio, source, created_at';

// GET /v1/vault-watch?metal=gold&days=30
router.get('/', async (req, res) => {
  try {
    const { metal, days } = req.query;

    // If days param is provided, return history
    if (days) {
      const numDays = Math.min(Math.max(parseInt(days) || 30, 1), 365);
      const since = new Date();
      since.setDate(since.getDate() - numDays);

      let query = supabase
        .from('vault_data')
        .select(ALL_FIELDS)
        .eq('source', 'comex')
        .gte('date', since.toISOString().split('T')[0])
        .order('date', { ascending: true });

      if (metal) {
        if (!VALID_METALS.includes(metal)) {
          return res.status(400).json({ error: `Invalid metal. Use: ${VALID_METALS.join(', ')}` });
        }
        query = query.eq('metal', metal);
      }

      const { data, error } = await query;
      if (error) throw error;

      return res.json({
        metal: metal || 'all',
        days: numDays,
        data_points: data.length,
        history: data,
      });
    }

    // Default: return latest entry per metal (or for specific metal)
    if (metal) {
      if (!VALID_METALS.includes(metal)) {
        return res.status(400).json({ error: `Invalid metal. Use: ${VALID_METALS.join(', ')}` });
      }

      const { data, error } = await supabase
        .from('vault_data')
        .select(ALL_FIELDS)
        .eq('metal', metal)
        .eq('source', 'comex')
        .order('date', { ascending: false })
        .limit(1)
        .single();

      if (error) throw error;

      return res.json({
        metal,
        date: data.date,
        registered_oz: data.registered_oz,
        eligible_oz: data.eligible_oz,
        combined_oz: data.combined_oz,
        registered_change_oz: data.registered_change_oz,
        eligible_change_oz: data.eligible_change_oz,
        combined_change_oz: data.combined_change_oz,
        open_interest_oz: data.open_interest_oz,
        oversubscribed_ratio: parseFloat(data.oversubscribed_ratio),
        source: data.source,
        updated_at: data.created_at,
      });
    }

    // No metal specified: return latest for all metals
    const results = {};
    for (const m of VALID_METALS) {
      const { data } = await supabase
        .from('vault_data')
        .select(ALL_FIELDS)
        .eq('metal', m)
        .eq('source', 'comex')
        .order('date', { ascending: false })
        .limit(1)
        .single();

      if (data) {
        results[m] = {
          date: data.date,
          registered_oz: data.registered_oz,
          eligible_oz: data.eligible_oz,
          combined_oz: data.combined_oz,
          registered_change_oz: data.registered_change_oz,
          eligible_change_oz: data.eligible_change_oz,
          combined_change_oz: data.combined_change_oz,
          open_interest_oz: data.open_interest_oz,
          oversubscribed_ratio: parseFloat(data.oversubscribed_ratio),
          source: data.source,
          updated_at: data.created_at,
        };
      }
    }

    res.json(results);
  } catch (err) {
    console.error('Vault watch error:', err);
    res.status(500).json({ error: 'Failed to fetch vault data' });
  }
});

// GET /v1/vault-watch/history?metal=silver&days=30
router.get('/history', async (req, res) => {
  try {
    const { metal = 'silver', days = 30 } = req.query;
    const numDays = Math.min(Math.max(parseInt(days) || 30, 1), 365);
    const since = new Date();
    since.setDate(since.getDate() - numDays);

    if (!VALID_METALS.includes(metal)) {
      return res.status(400).json({ error: `Invalid metal. Use: ${VALID_METALS.join(', ')}` });
    }

    const { data, error } = await supabase
      .from('vault_data')
      .select(ALL_FIELDS)
      .eq('metal', metal)
      .eq('source', 'comex')
      .gte('date', since.toISOString().split('T')[0])
      .order('date', { ascending: true });

    if (error) throw error;

    res.json({ metal, days: numDays, data_points: data.length, history: data });
  } catch (err) {
    console.error('Vault history error:', err);
    res.status(500).json({ error: 'Failed to fetch vault history' });
  }
});

// POST /v1/vault-watch/refresh — Manual trigger for COMEX XLS scrape
router.post('/refresh', async (req, res) => {
  try {
    const apiKey = req.headers['x-api-key'] || req.query.api_key;
    if (!apiKey || apiKey !== process.env.INTELLIGENCE_API_KEY) {
      return res.status(401).json({ success: false, error: 'Invalid API key' });
    }

    console.log('🏦 [Vault Refresh] Manual COMEX scrape triggered via API');
    const { scrapeComexVaultData } = require('../services/comex-scraper');
    const result = await scrapeComexVaultData();

    res.json({ success: result.inserted > 0, ...result });
  } catch (error) {
    console.error('Vault refresh error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
