/**
 * Junk Silver Melt Value Calculator
 *
 * GET /v1/junk-silver — calculates melt value for pre-1965 US coins
 *
 * Public endpoint. No auth required.
 */

const express = require('express');
const router = express.Router();
const { getSpotPrices } = require('../services/price-fetcher');

// Silver content per coin (troy ounces)
const SILVER_CONTENT = {
  dimes: 0.07234,         // Roosevelt / Mercury (pre-1965)
  quarters: 0.18084,      // Washington (pre-1965)
  half_dollars: 0.36169,  // Walking Liberty / Franklin / Kennedy 1964
  kennedy_40: 0.14792,    // Kennedy 1965-1970 (40% silver)
  dollars: 0.77344,       // Morgan / Peace
  war_nickels: 0.05626,   // Jefferson 1942-1945
};

// Face value per coin (dollars)
const FACE_VALUE = {
  dimes: 0.10,
  quarters: 0.25,
  half_dollars: 0.50,
  kennedy_40: 0.50,
  dollars: 1.00,
  war_nickels: 0.05,
};

function parseIntSafe(value) {
  if (value === undefined || value === null || value === '') return 0;
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

router.get('/', async (req, res) => {
  try {
    const quantities = {
      dimes: parseIntSafe(req.query.dimes),
      quarters: parseIntSafe(req.query.quarters),
      half_dollars: parseIntSafe(req.query.half_dollars),
      kennedy_40: parseIntSafe(req.query.kennedy_40),
      dollars: parseIntSafe(req.query.dollars),
      war_nickels: parseIntSafe(req.query.war_nickels),
    };

    const spotData = await getSpotPrices();
    const silverSpot = spotData?.prices?.silver;

    if (!silverSpot || silverSpot <= 0) {
      return res.status(503).json({ error: 'Silver spot price unavailable' });
    }

    const coins = {};
    let totalSilverOz = 0;
    let totalMeltValue = 0;
    const perFaceDollar = {};

    for (const [coin, qty] of Object.entries(quantities)) {
      if (qty <= 0) continue;

      const ozPerCoin = SILVER_CONTENT[coin];
      const silverOz = qty * ozPerCoin;
      const meltValue = silverOz * silverSpot;

      coins[coin] = {
        quantity: qty,
        silver_oz: Math.round(silverOz * 1000) / 1000,
        melt_value: Math.round(meltValue * 100) / 100,
      };

      totalSilverOz += silverOz;
      totalMeltValue += meltValue;

      // Melt value per $1 face for this coin type
      const coinsPerDollarFace = 1 / FACE_VALUE[coin];
      perFaceDollar[coin] = Math.round(ozPerCoin * silverSpot * coinsPerDollarFace * 100) / 100;
    }

    res.json({
      spot_silver: silverSpot,
      coins,
      total_silver_oz: Math.round(totalSilverOz * 1000) / 1000,
      total_melt_value: Math.round(totalMeltValue * 100) / 100,
      per_face_dollar: perFaceDollar,
      spot_updated_at: spotData.timestamp,
    });
  } catch (err) {
    console.error('[JunkSilver] Error:', err.message);
    res.status(500).json({ error: 'Failed to calculate junk silver melt value' });
  }
});

module.exports = router;
