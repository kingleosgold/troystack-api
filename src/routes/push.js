const express = require('express');
const { Expo } = require('expo-server-sdk');
const supabase = require('../lib/supabase');

const router = express.Router();
const expo = new Expo();

// ============================================
// HELPERS
// ============================================

function isUUID(str) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str);
}

function isValidExpoPushToken(token) {
  return typeof token === 'string' && (token.startsWith('ExponentPushToken[') || token.startsWith('ExpoPushToken['));
}

/**
 * Send a single push notification via Expo Push API
 */
async function sendPush(token, notification) {
  if (!isValidExpoPushToken(token)) {
    return { success: false, error: 'Invalid token' };
  }

  try {
    const messages = [{
      to: token,
      sound: notification.sound || 'default',
      title: notification.title,
      body: notification.body,
      data: notification.data || {},
    }];

    const chunks = expo.chunkPushNotifications(messages);
    for (const chunk of chunks) {
      await expo.sendPushNotificationsAsync(chunk);
    }
    return { success: true };
  } catch (error) {
    console.error('Push send error:', error.message);
    return { success: false, error: error.message };
  }
}

/**
 * Send batch push notifications
 */
async function sendBatchPush(tokens, notification) {
  const messages = tokens
    .filter(token => isValidExpoPushToken(token))
    .map(token => ({
      to: token,
      sound: notification.sound || 'default',
      title: notification.title,
      body: notification.body,
      data: notification.data || {},
    }));

  if (messages.length === 0) return [];

  const results = [];
  const chunks = expo.chunkPushNotifications(messages);
  for (const chunk of chunks) {
    try {
      const tickets = await expo.sendPushNotificationsAsync(chunk);
      results.push(...tickets.map(t => ({ success: t.status === 'ok' })));
    } catch (error) {
      console.error('Batch push error:', error.message);
      results.push(...chunk.map(() => ({ success: false })));
    }
  }
  return results;
}

// ============================================
// PUSH TOKEN ROUTES
// ============================================

// POST /v1/push/register — Register or update a push token
router.post('/register', async (req, res) => {
  try {
    const { expo_push_token, platform, app_version, user_id, device_id } = req.body;
    console.log('🔔 [Push Token] Register request:', { expo_push_token: expo_push_token?.substring(0, 30) + '...', platform, user_id: user_id?.substring(0, 8), device_id });

    if (!expo_push_token || !isValidExpoPushToken(expo_push_token)) {
      return res.status(400).json({ success: false, error: 'Valid expo_push_token is required' });
    }

    // Check if token already exists
    const { data: existing, error: checkError } = await supabase
      .from('push_tokens')
      .select('id')
      .eq('expo_push_token', expo_push_token)
      .single();

    if (checkError && checkError.code !== 'PGRST116') {
      console.error('🔔 [Push Token] Error checking existing token:', checkError);
    }

    if (existing) {
      // Update existing token
      const { error: updateError } = await supabase
        .from('push_tokens')
        .update({
          user_id: user_id || null,
          device_id: device_id || null,
          platform: platform || null,
          app_version: app_version || null,
          last_active: new Date().toISOString(),
        })
        .eq('id', existing.id);

      if (updateError) {
        console.error('🔔 [Push Token] Error updating:', updateError);
        return res.status(500).json({ success: false, error: updateError.message });
      }

      console.log(`✅ [Push Token] Updated: ${expo_push_token.substring(0, 30)}... (id: ${existing.id})`);
      return res.json({ success: true, action: 'updated', id: existing.id });
    }

    // Insert new token
    const { data: inserted, error: insertError } = await supabase
      .from('push_tokens')
      .insert({
        user_id: user_id || null,
        device_id: device_id || null,
        expo_push_token,
        platform: platform || null,
        app_version: app_version || null,
      })
      .select()
      .single();

    if (insertError) {
      console.error('🔔 [Push Token] Error inserting:', insertError);
      return res.status(500).json({ success: false, error: insertError.message });
    }

    console.log(`✅ [Push Token] Registered NEW: ${expo_push_token.substring(0, 30)}... (id: ${inserted.id})`);
    res.json({ success: true, action: 'created', id: inserted.id });
  } catch (error) {
    console.error('❌ [Push Token] Register error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// DELETE /v1/push/delete — Delete a push token
router.delete('/delete', async (req, res) => {
  try {
    const { expo_push_token } = req.body;

    if (!expo_push_token) {
      return res.status(400).json({ success: false, error: 'expo_push_token is required' });
    }

    const { error } = await supabase
      .from('push_tokens')
      .delete()
      .eq('expo_push_token', expo_push_token);

    if (error) {
      console.error('Error deleting push token:', error);
      return res.status(500).json({ success: false, error: error.message });
    }

    console.log(`✅ Deleted push token: ${expo_push_token.substring(0, 30)}...`);
    res.json({ success: true });
  } catch (error) {
    console.error('Error in push token delete:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// PRICE ALERT ROUTES
// ============================================

// POST /v1/push/price-alerts — Create a price alert
router.post('/price-alerts', async (req, res) => {
  try {
    const { id, userId, device_id, metal, targetPrice, direction, enabled } = req.body;

    if (!metal || !targetPrice || !direction) {
      return res.status(400).json({ success: false, error: 'metal, targetPrice, and direction are required' });
    }
    if (!['gold', 'silver', 'platinum', 'palladium'].includes(metal)) {
      return res.status(400).json({ success: false, error: 'Invalid metal' });
    }
    if (!['above', 'below'].includes(direction)) {
      return res.status(400).json({ success: false, error: 'direction must be above or below' });
    }
    if (!userId && !device_id) {
      return res.status(400).json({ success: false, error: 'Either userId or device_id is required' });
    }

    const row = {
      metal,
      target_price: parseFloat(targetPrice),
      direction,
      enabled: enabled !== false,
      device_id: device_id || null,
    };
    if (id) row.id = id;
    if (userId && userId.match(/^[0-9a-f]{8}-[0-9a-f]{4}-/i)) {
      row.user_id = userId;
    }

    const { data, error } = await supabase
      .from('price_alerts')
      .upsert(row, { onConflict: 'id' })
      .select()
      .single();

    if (error) {
      console.error('🔔 Error creating price alert:', error);
      return res.status(500).json({ success: false, error: error.message });
    }

    console.log(`✅ Created price alert: ${data.id} (${metal} ${direction} $${targetPrice})`);
    res.json({ success: true, alert: data });
  } catch (error) {
    console.error('Error in POST price-alerts:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /v1/push/price-alerts — Get user's price alerts
router.get('/price-alerts', async (req, res) => {
  try {
    const { user_id, device_id } = req.query;

    if (!user_id && !device_id) {
      return res.status(400).json({ success: false, error: 'Either user_id or device_id is required' });
    }

    let query = supabase.from('price_alerts').select('*');
    const orConditions = [];
    if (user_id) orConditions.push(`user_id.eq.${user_id}`);
    if (device_id) orConditions.push(`device_id.eq.${device_id}`);
    query = query.or(orConditions.join(','));

    const { data, error } = await query.order('created_at', { ascending: false });

    if (error) {
      console.error('Error fetching price alerts:', error);
      return res.status(500).json({ success: false, error: error.message });
    }

    res.json({ success: true, alerts: data || [] });
  } catch (error) {
    console.error('Error in GET price-alerts:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// PATCH /v1/push/price-alerts/:id — Update a price alert
router.patch('/price-alerts/:id', async (req, res) => {
  try {
    const alertId = req.params.id;
    const { enabled, metal, targetPrice, direction } = req.body;

    const updates = { updated_at: new Date().toISOString() };
    if (typeof enabled === 'boolean') updates.enabled = enabled;
    if (metal) updates.metal = metal;
    if (targetPrice !== undefined) updates.target_price = parseFloat(targetPrice);
    if (direction) updates.direction = direction;

    if (Object.keys(updates).length === 1) {
      return res.status(400).json({ success: false, error: 'No valid fields to update' });
    }

    const { data, error } = await supabase
      .from('price_alerts')
      .update(updates)
      .eq('id', alertId)
      .select()
      .single();

    if (error) {
      console.error('Error updating price alert:', error);
      return res.status(500).json({ success: false, error: error.message });
    }

    console.log(`✅ Updated price alert ${alertId}:`, JSON.stringify(updates));
    res.json({ success: true, alert: data });
  } catch (error) {
    console.error('Error in PATCH price-alerts:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// DELETE /v1/push/price-alerts/:id — Delete a price alert
router.delete('/price-alerts/:id', async (req, res) => {
  try {
    const alertId = req.params.id;

    const { error } = await supabase
      .from('price_alerts')
      .delete()
      .eq('id', alertId);

    if (error) {
      console.error('Error deleting price alert:', error);
      return res.status(500).json({ success: false, error: error.message });
    }

    console.log(`✅ Deleted price alert: ${alertId}`);
    res.json({ success: true });
  } catch (error) {
    console.error('Error in DELETE price-alerts:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// DELETE /v1/push/price-alerts — Delete all price alerts for a user/device
router.delete('/price-alerts', async (req, res) => {
  try {
    const { user_id, device_id } = req.query;
    if (!user_id && !device_id) {
      return res.status(400).json({ success: false, error: 'Either user_id or device_id is required' });
    }

    let query = supabase.from('price_alerts').delete();
    if (user_id && device_id) {
      query = query.or(`user_id.eq.${user_id},device_id.eq.${device_id}`);
    } else if (user_id) {
      query = query.eq('user_id', user_id);
    } else {
      query = query.eq('device_id', device_id);
    }
    const { error } = await query;
    if (error) {
      console.error('Error deleting all price alerts:', error);
      return res.status(500).json({ success: false, error: error.message });
    }
    console.log(`✅ Deleted all price alerts for user_id=${user_id}, device_id=${device_id}`);
    res.json({ success: true });
  } catch (error) {
    console.error('Error in DELETE all price-alerts:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// NOTIFICATION PREFERENCES
// ============================================

// GET /v1/push/notification-preferences
router.get('/notification-preferences', async (req, res) => {
  try {
    const userId = req.query.userId;
    if (!userId || !isUUID(userId)) {
      return res.status(400).json({ error: 'Valid userId is required' });
    }

    const { data, error } = await supabase
      .from('notification_preferences')
      .select('daily_brief, price_alerts, breaking_news')
      .eq('user_id', userId)
      .single();

    if (error || !data) {
      return res.json({ daily_brief: true, price_alerts: true, breaking_news: true });
    }

    res.json(data);
  } catch (error) {
    console.error('❌ [Notification Prefs] Get error:', error.message);
    res.json({ daily_brief: true, price_alerts: true, breaking_news: true });
  }
});

// POST /v1/push/notification-preferences
router.post('/notification-preferences', async (req, res) => {
  try {
    const { userId, daily_brief, price_alerts, breaking_news } = req.body;
    if (!userId || !isUUID(userId)) {
      return res.status(400).json({ error: 'Valid userId is required' });
    }

    const prefs = {
      user_id: userId,
      daily_brief: daily_brief !== false,
      price_alerts: price_alerts !== false,
      breaking_news: breaking_news !== false,
    };

    const { error } = await supabase
      .from('notification_preferences')
      .upsert(prefs, { onConflict: 'user_id' });

    if (error) {
      console.error('❌ [Notification Prefs] Save error:', error.message);
      return res.status(500).json({ error: error.message });
    }

    console.log(`🔔 [Notification Prefs] Saved for ${userId}: brief=${prefs.daily_brief}, alerts=${prefs.price_alerts}, breaking=${prefs.breaking_news}`);
    res.json({ success: true, ...prefs });
  } catch (error) {
    console.error('❌ [Notification Prefs] Save error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Export helper functions for inter-module use (intelligence.js needs these)
module.exports = router;
module.exports.sendPush = sendPush;
module.exports.sendBatchPush = sendBatchPush;
module.exports.isValidExpoPushToken = isValidExpoPushToken;
