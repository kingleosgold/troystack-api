const axios = require('axios');
const { defineCostSource } = require('../define-source');

// Rough monthly base price per ElevenLabs subscription tier (USD).
// Overage billing is not captured here — ElevenLabs does not expose it
// cleanly via the subscription endpoint. Update when tier changes.
const TIER_BASE_USD = {
  free: 0,
  starter: 5,
  creator: 22,
  pro: 99,
  scale: 330,
  business: 1100,
  enterprise: 0, // custom billing
};

module.exports = defineCostSource({
  id: 'elevenlabs',
  category: 'ai_inference',
  label: 'ElevenLabs',
  source_type: 'api',
  async fetch() {
    const key = process.env.ELEVENLABS_API_KEY;
    if (!key) throw new Error('ELEVENLABS_API_KEY not configured');

    const { data } = await axios.get('https://api.elevenlabs.io/v1/user/subscription', {
      headers: { 'xi-api-key': key },
      timeout: 12000,
    });

    const tier = String(data.tier || data.subscription_tier || 'free').toLowerCase();
    const charUsed = Number(data.character_count || 0);
    const charLimit = Number(data.character_limit || 0);
    const extraCharLimit = Number(data.extra_character_limit_per_month || 0);
    const baseUsd = TIER_BASE_USD[tier] != null ? TIER_BASE_USD[tier] : 0;

    const details =
      `Tier: ${tier}, ${charUsed.toLocaleString()}/${charLimit.toLocaleString()} chars` +
      (extraCharLimit ? `, +${extraCharLimit.toLocaleString()} overage allotment` : '') +
      ` (base $${baseUsd.toFixed(2)}/mo; overages not captured)`;

    return {
      amount_cents: Math.round(baseUsd * 100),
      units: charUsed,
      unit_type: 'characters',
      details,
      raw_data: data,
    };
  },
});
