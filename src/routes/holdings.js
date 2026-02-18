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
      .order('purchase_date', { ascending: false })
      .range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1);

    if (metal) {
      query = query.eq('metal', metal.toLowerCase());
    }

    const { data, error } = await query;
    if (error) throw error;

    res.json({
      count: data.length,
      holdings: data.map(h => ({
        id: h.id,
        metal: h.metal,
        product_name: h.product_name,
        quantity: h.quantity,
        weight_oz: h.weight_oz,
        total_oz: h.total_oz,
        purchase_price: h.purchase_price,
        total_cost: h.total_cost,
        premium: h.premium,
        dealer: h.dealer,
        purchase_date: h.purchase_date,
        notes: h.notes,
        created_at: h.created_at,
      })),
    });
  } catch (err) {
    console.error('Holdings error:', err);
    res.status(500).json({ error: 'Failed to fetch holdings' });
  }
});

// POST /v1/holdings - Add a purchase
router.post('/', async (req, res) => {
  try {
    const { metal, product_name, quantity, weight_oz, purchase_price, dealer, purchase_date, notes } = req.body;

    // Validation
    if (!metal || !quantity || !weight_oz || !purchase_price) {
      return res.status(400).json({
        error: 'Missing required fields',
        required: ['metal', 'quantity', 'weight_oz', 'purchase_price'],
        optional: ['product_name', 'dealer', 'purchase_date', 'notes'],
        example: {
          metal: 'silver',
          product_name: '2024 American Silver Eagle',
          quantity: 20,
          weight_oz: 1,
          purchase_price: 35.50,
          dealer: 'APMEX',
          purchase_date: '2024-11-21',
        }
      });
    }

    const validMetals = ['gold', 'silver', 'platinum', 'palladium'];
    if (!validMetals.includes(metal.toLowerCase())) {
      return res.status(400).json({ error: `Invalid metal. Use: ${validMetals.join(', ')}` });
    }

    const totalOz = quantity * weight_oz;
    const totalCost = quantity * purchase_price;

    const { data, error } = await supabase
      .from('holdings')
      .insert({
        user_id: req.userId,
        metal: metal.toLowerCase(),
        product_name: product_name || `${metal} purchase`,
        quantity,
        weight_oz,
        total_oz: totalOz,
        purchase_price,
        total_cost: totalCost,
        premium: purchase_price - (totalCost / totalOz), // rough premium calc
        dealer,
        purchase_date: purchase_date || new Date().toISOString().split('T')[0],
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
