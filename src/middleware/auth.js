const supabase = require('../lib/supabase');

async function authenticateApiKey(req, res, next) {
  const authHeader = req.headers.authorization;
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({
      error: 'Authentication required',
      message: 'Include your API key as: Authorization: Bearer YOUR_API_KEY',
      signup: 'Generate API keys in TroyStack app → Settings → Developer Access'
    });
  }

  const apiKey = authHeader.split(' ')[1];

  try {
    // Look up API key in database
    const { data, error } = await supabase
      .from('api_keys')
      .select('id, user_id, name, tier, rate_limit, is_active, last_used_at')
      .eq('key_hash', hashApiKey(apiKey))
      .eq('is_active', true)
      .single();

    if (error || !data) {
      return res.status(401).json({ error: 'Invalid or inactive API key' });
    }

    // Update last used timestamp
    await supabase
      .from('api_keys')
      .update({ last_used_at: new Date().toISOString(), request_count: data.request_count + 1 })
      .eq('id', data.id);

    // Attach user context to request
    req.userId = data.user_id;
    req.apiKeyId = data.id;
    req.tier = data.tier; // 'free', 'pro', 'enterprise'
    req.rateLimit = data.rate_limit;

    next();
  } catch (err) {
    console.error('Auth error:', err);
    return res.status(500).json({ error: 'Authentication failed' });
  }
}

function hashApiKey(key) {
  const crypto = require('crypto');
  return crypto.createHash('sha256').update(key).digest('hex');
}

module.exports = { authenticateApiKey, hashApiKey };
