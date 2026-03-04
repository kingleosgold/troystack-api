/**
 * Price Alert Checker Service
 *
 * Runs every 5 minutes via cron. Checks active price alerts against
 * current spot prices and sends push notifications when triggered.
 *
 * Ported from stg-mobile/backend/services/priceAlertChecker.js
 */

const supabase = require('../lib/supabase');
const { sendPush, isValidExpoPushToken } = require('../routes/push');
const { getCachedPrices, getSpotPrices } = require('./price-fetcher');

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Get fresh spot prices, falling back to cache.
 */
async function getCurrentPrices() {
  let prices = getCachedPrices();
  if (!prices.gold || !prices.silver) {
    try {
      const fresh = await getSpotPrices();
      prices = fresh.prices;
    } catch (e) {
      console.log('[AlertChecker] Price fetch fallback failed:', e.message);
    }
  }
  return prices;
}

/**
 * Mark an alert as triggered in the database.
 */
async function markAlertTriggered(alertId, triggeredPrice) {
  try {
    const { error } = await supabase
      .from('price_alerts')
      .update({
        triggered: true,
        triggered_at: new Date().toISOString(),
        triggered_price: triggeredPrice,
      })
      .eq('id', alertId);

    if (error) console.log(`[AlertChecker] Failed to mark ${alertId} triggered: ${error.message}`);
  } catch (err) {
    console.log(`[AlertChecker] markTriggered error: ${err.message}`);
  }
}

/**
 * Log a notification to the notification_log table.
 */
async function logNotification(alert, pushToken, actualPrice, success, errorMessage) {
  try {
    await supabase.from('notification_log').insert({
      alert_id: alert.id,
      expo_push_token: pushToken,
      metal: alert.metal,
      target_price: alert.target_price,
      actual_price: actualPrice,
      direction: alert.direction,
      success,
      error_message: errorMessage || null,
    });
  } catch (err) {
    // Non-critical — don't let logging failures break the checker
  }
}

/**
 * Check all active price alerts and send push notifications for triggered ones.
 */
async function checkPriceAlerts() {
  const prices = await getCurrentPrices();

  if (!prices || !prices.gold || !prices.silver) {
    console.log('[AlertChecker] No valid prices available, skipping');
    return { checked: 0, triggered: 0, sent: 0, errors: 0 };
  }

  const stats = { checked: 0, triggered: 0, sent: 0, errors: 0 };

  try {
    const { data: alerts, error } = await supabase
      .from('price_alerts')
      .select('*')
      .eq('enabled', true)
      .eq('triggered', false);

    if (error) {
      console.log(`[AlertChecker] Fetch error: ${error.message}`);
      return stats;
    }

    if (!alerts || alerts.length === 0) return stats;

    stats.checked = alerts.length;

    for (const alert of alerts) {
      try {
        const currentPrice = prices[alert.metal];
        if (!currentPrice || currentPrice <= 0) continue;

        const shouldTrigger =
          (alert.direction === 'above' && currentPrice >= alert.target_price) ||
          (alert.direction === 'below' && currentPrice <= alert.target_price);

        if (!shouldTrigger) continue;

        stats.triggered++;
        console.log(`[AlertChecker] Triggered: ${alert.metal} ${alert.direction} $${alert.target_price} (now $${currentPrice})`);

        // Find push token
        const orConditions = [];
        if (alert.user_id) orConditions.push(`user_id.eq.${alert.user_id}`);
        if (alert.device_id) orConditions.push(`device_id.eq.${alert.device_id}`);

        if (orConditions.length === 0) {
          stats.errors++;
          await markAlertTriggered(alert.id, currentPrice);
          continue;
        }

        const { data: tokenData, error: tokenErr } = await supabase
          .from('push_tokens')
          .select('expo_push_token')
          .not('user_id', 'is', null)
          .or(orConditions.join(','))
          .order('last_active', { ascending: false })
          .limit(1)
          .single();

        if (tokenErr || !tokenData || !isValidExpoPushToken(tokenData.expo_push_token)) {
          stats.errors++;
          await markAlertTriggered(alert.id, currentPrice);
          continue;
        }

        // Check notification preferences
        if (alert.user_id) {
          try {
            const { data: pref } = await supabase
              .from('notification_preferences')
              .select('price_alerts')
              .eq('user_id', alert.user_id)
              .single();
            if (pref && pref.price_alerts === false) {
              await markAlertTriggered(alert.id, currentPrice);
              continue;
            }
          } catch (_) { /* no prefs row = defaults enabled */ }
        }

        // Send push
        const result = await sendPush(tokenData.expo_push_token, {
          title: `${capitalize(alert.metal)} Price Alert`,
          body: `${capitalize(alert.metal)} has ${alert.direction === 'above' ? 'risen to' : 'fallen to'} $${currentPrice.toFixed(2)}`,
          data: {
            type: 'price_alert',
            alert_id: alert.id,
            metal: alert.metal,
            target_price: alert.target_price,
            current_price: currentPrice,
            direction: alert.direction,
          },
          sound: 'default',
          priority: 'high',
        });

        if (result.success) {
          stats.sent++;
          await markAlertTriggered(alert.id, currentPrice);
          await logNotification(alert, tokenData.expo_push_token, currentPrice, true, null);
        } else {
          stats.errors++;
          await markAlertTriggered(alert.id, currentPrice);
          await logNotification(alert, tokenData.expo_push_token, currentPrice, false, result.error);
        }
      } catch (alertErr) {
        stats.errors++;
        console.log(`[AlertChecker] Error on alert ${alert.id}: ${alertErr.message}`);
      }
    }

    if (stats.triggered > 0) {
      console.log(`[AlertChecker] Done: ${stats.checked} checked, ${stats.triggered} triggered, ${stats.sent} sent, ${stats.errors} errors`);
    }

    return stats;
  } catch (err) {
    console.log(`[AlertChecker] Failed: ${err.message}`);
    return stats;
  }
}

module.exports = { checkPriceAlerts };
