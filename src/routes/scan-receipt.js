const express = require('express');
const axios = require('axios');

const router = express.Router();

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = 'gemini-2.5-flash';

// POST /v1/scan-receipt
router.post('/', async (req, res) => {
  const startTime = Date.now();
  console.log('\n🧾 [Receipt Scan] Request received');

  try {
    let base64Image;
    let mediaType;

    // Expect JSON with base64 image
    if (req.body && req.body.image) {
      base64Image = req.body.image;
      mediaType = req.body.mimeType || 'image/jpeg';
      console.log(`   Base64 length: ${base64Image.length} chars, type: ${mediaType}`);
    } else {
      return res.status(400).json({ error: 'No image provided. Send { image: base64String, mimeType: "image/jpeg" }' });
    }

    // Prompt for receipt extraction
    const prompt = `Extract precious metals purchase data from this receipt image. Read every number EXACTLY as printed.

RULES:
1. ONLY include precious metal products: coins, bars, rounds
2. EXCLUDE accessories: tubes, capsules, boxes, cases, albums, flips, holders
3. EXCLUDE items under $10 (accessories)
4. Read prices EXACTLY - do not estimate
5. Extract purchase TIME if visible (from timestamp, order time, transaction time, etc.)

Return ONLY valid JSON (no markdown, no explanation):
{
  "dealer": "dealer name",
  "purchaseDate": "YYYY-MM-DD",
  "purchaseTime": "HH:MM",
  "items": [
    {
      "description": "product name exactly as printed",
      "quantity": 1,
      "unitPrice": 123.45,
      "extPrice": 123.45,
      "metal": "silver",
      "ozt": 1.0
    }
  ]
}

If a field is unreadable, use null. Metal must be: gold, silver, platinum, or palladium. purchaseTime should be in 24-hour format (e.g., "14:30" for 2:30 PM).`;

    let responseText;
    let apiSource;

    if (!GEMINI_API_KEY) {
      return res.status(503).json({ error: 'Receipt scanner is not configured (missing GEMINI_API_KEY)' });
    }

    try {
      console.log('🤖 Calling Gemini 2.5 Flash API...');

      const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
      const geminiResponse = await axios.post(geminiUrl, {
        contents: [{
          parts: [
            { text: prompt },
            {
              inline_data: {
                mime_type: mediaType,
                data: base64Image
              }
            }
          ]
        }],
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: 2048,
        }
      }, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 60000
      });

      if (geminiResponse.data?.candidates?.[0]?.content?.parts?.[0]?.text) {
        responseText = geminiResponse.data.candidates[0].content.parts[0].text;
        apiSource = 'gemini-2.5-flash';
        console.log('✅ Gemini response received');
      } else {
        throw new Error('Invalid Gemini response structure');
      }
    } catch (geminiError) {
      console.error('❌ Gemini API error:', geminiError.message);
      if (geminiError.response) {
        console.error(`   Status: ${geminiError.response.status}`);
      }
      return res.status(500).json({ error: 'Receipt scanning failed' });
    }

    const apiDuration = Date.now() - startTime;
    console.log(`⏱️  API call completed in ${apiDuration}ms (${apiSource})`);

    // Extract JSON from response
    let extractedData;
    try {
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        extractedData = JSON.parse(jsonMatch[0]);
      } else {
        throw new Error('No JSON found in response');
      }
    } catch (parseError) {
      console.error('❌ JSON parse error:', parseError.message);
      extractedData = { items: [] };
    }

    // Ensure items array exists
    if (!extractedData.items || !Array.isArray(extractedData.items)) {
      extractedData.items = [];
    }

    // Verify and correct unit prices using ext price
    extractedData.items = extractedData.items.map((item) => {
      const qty = item.quantity || 1;
      if (item.extPrice && qty > 0) {
        const calcUnit = item.extPrice / qty;
        if (item.unitPrice && Math.abs(item.unitPrice - calcUnit) > 0.02) {
          item.unitPrice = Math.round(calcUnit * 100) / 100;
        }
        if (!item.unitPrice) {
          item.unitPrice = Math.round(calcUnit * 100) / 100;
        }
      }
      return item;
    });

    const totalDuration = Date.now() - startTime;
    console.log(`✅ [Receipt Scan] Complete in ${totalDuration}ms — ${extractedData.items.length} items extracted`);

    res.json({
      success: true,
      data: extractedData,
      apiSource,
      processingTimeMs: totalDuration,
    });

  } catch (error) {
    console.error('❌ [Receipt Scan] Error:', error.message);
    res.status(500).json({ error: 'Receipt scanning failed' });
  }
});

module.exports = router;
