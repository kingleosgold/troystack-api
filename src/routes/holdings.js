const express = require('express');
const router = express.Router();
const supabase = require('../lib/supabase');

// GET /v1/holdings - List all holdings
router.get('/', async (req, res) => {
  try {
    const { metal, limit = 50, offset = 0 } = req.query;

    let query = supabase
      .from('holdings')
      .select('*')
      .eq('user_id', req.userId)
      .is('deleted_at', null)
      .order('purchase_date', { ascending: false })
      .range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1);

    if (metal) {
      query = query.eq('metal', metal.toLowerCase());
    }

    const { data, error } = await query;
    if (error) throw error;

    res.json({
      count: data.length,
      holdings: data.map(h => {
        let premium = null;
        try { premium = JSON.parse(h.notes)?.premium; } catch(e) {}
        return {
          id: h.id,
          metal: h.metal,
          product_name: h.type,
          quantity: h.quantity,
          weight_oz: h.weight,
          weight_unit: h.weight_unit,
          total_oz: h.weight * h.quantity,
          purchase_price: h.purchase_price,
          total_cost: h.purchase_price * h.quantity,
          premium,
          purchase_date: h.purchase_date,
          created_at: h.created_at,
        };
      }),
    });
  } catch (err) {
    console.error('Holdings error:', err);
    res.status(500).json({ error: 'Failed to fetch holdings' });
  }
});

// POST /v1/holdings - Add a purchase
router.post('/', async (req, res) => {
  try {
    const { metal, type, weight, quantity, purchase_price, purchase_date, spot_price, premium } = req.body;

    // Validation
    if (!metal || !quantity || !weight || !purchase_price) {
      return res.status(400).json({
        error: 'Missing required fields',
        required: ['metal', 'quantity', 'weight', 'purchase_price'],
        optional: ['type', 'purchase_date', 'spot_price', 'premium'],
        example: {
          metal: 'silver',
          type: '2024 American Silver Eagle',
          quantity: 20,
          weight: 1,
          purchase_price: 35.50,
          purchase_date: '2024-11-21',
          spot_price: 30.25,
          premium: 5.25,
        }
      });
    }

    const validMetals = ['gold', 'silver', 'platinum', 'palladium'];
    if (!validMetals.includes(metal.toLowerCase())) {
      return res.status(400).json({ error: `Invalid metal. Use: ${validMetals.join(', ')}` });
    }

    const notes = JSON.stringify({
      spot_price: spot_price || null,
      premium: premium || null,
      source: 'api',
    });

    const { data, error } = await supabase
      .from('holdings')
      .insert({
        user_id: req.userId,
        metal: metal.toLowerCase(),
        type: type || `${metal} purchase`,
        weight: parseFloat(weight),
        quantity: parseInt(quantity),
        purchase_price: parseFloat(purchase_price),
        purchase_date: purchase_date || new Date().toISOString().split('T')[0],
        weight_unit: 'oz',
        notes,
      })
      .select()
      .single();

    if (error) throw error;

    res.status(201).json({ message: 'Holding added', holding: data });
  } catch (err) {
    console.error('Add holding error:', err);
    res.status(500).json({ error: 'Failed to add holding' });
  }
});

module.exports = router;
