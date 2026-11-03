// The scraper's Gemini extraction prompt, shared with the Gemini probe so
// the probe tests the same request production sends.

const EXTRACTION_PROMPT = `Extract key claims, price targets, specific numbers, and sentiment from this precious metals content. Return ONLY valid JSON:

{
  "claims": ["string array of key claims or predictions"],
  "price_targets": [{"metal": "gold|silver", "target": 5000, "timeframe": "by end of 2026"}],
  "key_figures": [{"label": "COMEX registered silver", "value": "120 million oz"}],
  "sentiment": "bullish|bearish|neutral",
  "topics": ["fed", "comex", "central-banks", "silver-squeeze", "inflation"],
  "summary": "One-sentence summary of the main point"
}

If no precious metals content is found, return {"claims":[],"price_targets":[],"key_figures":[],"sentiment":"neutral","topics":[],"summary":"Not relevant to precious metals"}`;

module.exports = { EXTRACTION_PROMPT };
