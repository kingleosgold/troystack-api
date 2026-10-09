const express = require('express');
const supabase = require('../lib/supabase');
const { safeRedirect, cleanCampaign, signedInUserId, liveSubscriptions, subscriptionTier, paidLifetimeSessions } = require('../lib/stripe-checks');

const router = express.Router();

// Initialize Stripe (conditionally)
const stripe = process.env.STRIPE_SECRET_KEY
  ? require('stripe')(process.env.STRIPE_SECRET_KEY)
  : null;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const STRIPE_GOLD_MONTHLY_PRICE_ID = process.env.STRIPE_GOLD_MONTHLY_PRICE_ID;
const STRIPE_GOLD_YEARLY_PRICE_ID = process.env.STRIPE_GOLD_YEARLY_PRICE_ID;
const STRIPE_GOLD_LIFETIME_PRICE_ID = process.env.STRIPE_GOLD_LIFETIME_PRICE_ID;

if (!stripe) {
  console.warn('⚠️ Stripe disabled: missing STRIPE_SECRET_KEY');
}

// ============================================
// HELPERS
// ============================================

function isUUID(str) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str);
}

function mapStripePriceToTier(priceId) {
  if (!priceId) return 'free';
  if (priceId === STRIPE_GOLD_LIFETIME_PRICE_ID) return 'lifetime';
  if (priceId === STRIPE_GOLD_MONTHLY_PRICE_ID) return 'gold';
  if (priceId === STRIPE_GOLD_YEARLY_PRICE_ID) return 'gold';
  return 'free';
}

function isLifetimePrice(priceId) {
  return priceId === STRIPE_GOLD_LIFETIME_PRICE_ID;
}

// The products the Gold prices belong to, read from Stripe and kept for six
// hours. A subscriber on an older Gold price still counts, and a subscription
// to anything else in the account never does. A failed read throws rather
// than caching half the list, so nobody gets a confident answer from it.
const GOLD_PRODUCT_TTL_MS = 6 * 60 * 60 * 1000;
let goldProductCache = { at: 0, ids: new Set() };
async function goldProductIds() {
  if (goldProductCache.ids.size > 0 && Date.now() - goldProductCache.at < GOLD_PRODUCT_TTL_MS) return goldProductCache.ids;
  const configured = [STRIPE_GOLD_MONTHLY_PRICE_ID, STRIPE_GOLD_YEARLY_PRICE_ID, STRIPE_GOLD_LIFETIME_PRICE_ID].filter(Boolean);
  if (configured.length === 0) throw new Error('No Gold prices are configured');
  const ids = new Set();
  for (const priceId of configured) {
    const price = await stripe.prices.retrieve(priceId);
    const product = typeof price.product === 'string' ? price.product : price.product?.id;
    if (product) ids.add(product);
  }
  goldProductCache = { at: Date.now(), ids };
  return ids;
}

function resetGoldProductCache() {
  goldProductCache = { at: 0, ids: new Set() };
}

// The plan a subscription's price gives: a configured Gold price, or another
// price on the Gold product. Anything else gives free. Throws when the Gold
// product can't be read, since that isn't an answer.
async function tierForSubscriptionPrice(price) {
  const mapped = price?.id ? mapStripePriceToTier(price.id) : 'free';
  if (mapped !== 'free') return mapped;
  return subscriptionTier(price, mapStripePriceToTier, await goldProductIds()) || 'free';
}

// The tier for a completed checkout's subscription. When the Gold product
// can't be read, the tier this API wrote on the session when it opened the
// checkout stands, since it only opens checkouts for Gold prices. A session
// without one is retried rather than recorded as free.
async function tierForCheckout(session, price) {
  try {
    return await tierForSubscriptionPrice(price);
  } catch (e) {
    const recorded = session.metadata?.tier;
    if (recorded === 'gold' || recorded === 'lifetime') {
      console.warn(`⚠️ [Stripe] Gold product unreadable, keeping the session's ${recorded}:`, e.message);
      return recorded;
    }
    throw e;
  }
}

// Every completed checkout for a customer, newest first, a page at a time.
// Abandoned checkouts aren't complete, so they never crowd out a purchase.
async function* completedCheckouts(customerId, { pageSize = 100, maxPages = 10 } = {}) {
  let startingAfter;
  for (let page = 0; page < maxPages; page += 1) {
    const res = await stripe.checkout.sessions.list({
      customer: customerId,
      status: 'complete',
      limit: pageSize,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });
    const data = res.data || [];
    for (const session of data) yield session;
    if (!res.has_more || data.length === 0) return;
    startingAfter = data[data.length - 1].id;
  }
}

// What Stripe says a customer paid for, or null. Lifetime comes first, since
// it outlasts any subscription the customer also has. It's a one-time payment
// with no subscription, so it counts when any paid lifetime checkout wasn't
// refunded in full. Otherwise a live subscription to a Gold price or product
// gives Gold, and a subscription to anything else gives nothing.
async function planFromStripe(customerId) {
  for await (const checkout of completedCheckouts(customerId)) {
    const [session] = paidLifetimeSessions([checkout]);
    if (!session) continue;
    const intentId = typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id;
    if (!intentId) return { tier: 'lifetime', status: 'active', trialEnd: null };
    const intent = await stripe.paymentIntents.retrieve(intentId, { expand: ['latest_charge'] });
    const charge = intent.latest_charge;
    if (!(charge && typeof charge === 'object' && charge.refunded)) return { tier: 'lifetime', status: 'active', trialEnd: null };
  }

  const subs = await stripe.subscriptions.list({ customer: customerId, status: 'all', limit: 10 });
  const live = liveSubscriptions(subs.data);
  if (live.length === 0) return null;
  const products = await goldProductIds();
  for (const sub of live) {
    const tier = subscriptionTier(sub.items?.data?.[0]?.price, mapStripePriceToTier, products);
    if (tier) {
      return { tier, status: sub.status, trialEnd: sub.trial_end ? new Date(sub.trial_end * 1000).toISOString() : null };
    }
  }
  return null;
}

// ============================================
// WEBHOOK — MUST use express.raw() (handled in index.js)
// ============================================

// Standalone webhook handler — mounted directly in index.js before express.json()
async function stripeWebhookHandler(req, res) {
  try {
    if (!stripe) {
      return res.status(503).send('Stripe not configured');
    }

    const sig = req.headers['stripe-signature'];
    let event;

    try {
      event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
    } catch (err) {
      console.warn('⚠️ [Stripe Webhook] Signature verification failed:', err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    console.log(`💳 [Stripe Webhook] Event: ${event.type}`);

    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        const userId = session.client_reference_id || session.metadata?.user_id;
        if (!userId || !isUUID(userId)) {
          console.warn('⚠️ [Stripe Webhook] No valid user_id in checkout session');
          break;
        }

        let tier = session.metadata?.tier || 'gold';
        let subscriptionStatus = 'active';
        let trialEnd = null;

        if (session.subscription) {
          let subscription = null;
          try {
            subscription = await stripe.subscriptions.retrieve(session.subscription);
          } catch (e) {
            console.warn('⚠️ [Stripe Webhook] Could not retrieve subscription:', e.message);
          }
          if (subscription) {
            const price = subscription.items?.data?.[0]?.price;
            // A Gold product Stripe can't read throws here, the handler answers
            // 500 and Stripe sends the event again, rather than free being saved.
            if (price?.id) {
              tier = await tierForCheckout(session, price);
            }
            subscriptionStatus = subscription.status || 'active';
            if (subscription.trial_end) {
              trialEnd = new Date(subscription.trial_end * 1000).toISOString();
            }
          }
        } else if (session.mode === 'payment') {
          tier = session.metadata?.tier || 'lifetime';
        }

        const { error } = await supabase
          .from('profiles')
          .update({
            subscription_tier: tier,
            stripe_customer_id: session.customer,
            subscription_status: subscriptionStatus,
            trial_end: trialEnd,
          })
          .eq('id', userId);

        if (error) {
          console.error('❌ [Stripe Webhook] Failed to update profile:', error.message);
        } else {
          console.log(`✅ [Stripe Webhook] checkout.session.completed: user=${userId}, tier=${tier}`);
        }
        break;
      }

      case 'customer.subscription.updated': {
        const subscription = event.data.object;
        const customerId = subscription.customer;

        const { data: profile } = await supabase
          .from('profiles')
          .select('id, subscription_tier')
          .eq('stripe_customer_id', customerId)
          .single();

        if (profile) {
          // Don't downgrade lifetime users via subscription events
          if (profile.subscription_tier === 'lifetime') break;

          const newTier = (subscription.status === 'active' || subscription.status === 'trialing') ? 'gold' : 'free';
          const updateData = {
            subscription_tier: newTier,
            subscription_status: subscription.status,
          };
          if (subscription.trial_end) {
            updateData.trial_end = new Date(subscription.trial_end * 1000).toISOString();
          } else {
            updateData.trial_end = null;
          }
          await supabase
            .from('profiles')
            .update(updateData)
            .eq('id', profile.id);
          console.log(`✅ [Stripe Webhook] subscription.updated: user=${profile.id}, tier=${newTier}, status=${subscription.status}`);
        }
        break;
      }

      case 'customer.subscription.deleted': {
        const subscription = event.data.object;
        const customerId = subscription.customer;

        const { data: profile } = await supabase
          .from('profiles')
          .select('id, subscription_tier')
          .eq('stripe_customer_id', customerId)
          .single();

        if (profile) {
          if (profile.subscription_tier === 'lifetime') break;

          await supabase
            .from('profiles')
            .update({ subscription_tier: 'free' })
            .eq('id', profile.id);
          console.log(`✅ [Stripe Webhook] subscription.deleted: user=${profile.id}, downgraded to free`);
        }
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        console.warn(`⚠️ [Stripe Webhook] invoice.payment_failed: customer=${invoice.customer}, amount=${invoice.amount_due}`);
        break;
      }

      default:
        console.log(`💳 [Stripe Webhook] Unhandled event: ${event.type}`);
    }

    return res.json({ received: true });

  } catch (error) {
    console.error('❌ [Stripe Webhook] Error:', error.message);
    return res.status(500).send('Webhook handler error');
  }
}

// ============================================
// CHECKOUT + VERIFY + PORTAL
// ============================================

// POST /v1/stripe/create-checkout-session
router.post('/create-checkout-session', async (req, res) => {
  try {
    if (!stripe) {
      return res.status(503).json({ error: 'Stripe is not configured' });
    }

    const { user_id, price_id, success_url, cancel_url } = req.body;

    if (!user_id || !isUUID(user_id)) {
      return res.status(400).json({ error: 'Valid user_id is required' });
    }
    if (!price_id) {
      return res.status(400).json({ error: 'price_id is required' });
    }

    // Checkout opens only for the account that's signed in.
    const auth = await signedInUserId(req, supabase);
    if (auth.error) return res.status(auth.status).json({ error: auth.error });
    if (auth.userId !== user_id) {
      return res.status(403).json({ error: 'That account is not the one signed in' });
    }
    const campaign = cleanCampaign(req.body.campaign);

    // Checkout only sells Gold, a configured Gold price or another price on the
    // Gold product. Anything else is turned away, since a subscription to it
    // could later be mistaken for Gold. Another Gold-product price is sold as
    // lifetime when it's one-time and as Gold when it recurs.
    let tier = mapStripePriceToTier(price_id);
    let isLifetime = isLifetimePrice(price_id);
    if (tier === 'free') {
      let price = null;
      try {
        price = await stripe.prices.retrieve(price_id);
      } catch {
        // an unknown price id
      }
      const product = typeof price?.product === 'string' ? price.product : price?.product?.id;
      const products = await goldProductIds();
      if (!product || !products.has(product)) {
        return res.status(400).json({ error: 'That price is not a TroyStack Gold plan' });
      }
      isLifetime = price.type === 'one_time';
      tier = isLifetime ? 'lifetime' : 'gold';
    }

    // Look up user profile
    let { data: profile } = await supabase
      .from('profiles')
      .select('email, stripe_customer_id')
      .eq('id', user_id)
      .single();

    // If profile doesn't exist, create from auth.users
    if (!profile) {
      const { data: authUser, error: authError } = await supabase.auth.admin.getUserById(user_id);
      if (authError || !authUser?.user) {
        return res.status(404).json({ error: 'User not found' });
      }
      const userEmail = authUser.user.email || '';
      await supabase
        .from('profiles')
        .upsert({ id: user_id, email: userEmail, subscription_tier: 'free' }, { onConflict: 'id' });
      profile = { email: userEmail, stripe_customer_id: null };
      console.log(`📝 [Stripe] Created missing profile for user ${user_id}`);
    }

    let customerId = profile.stripe_customer_id;

    // Create Stripe customer if needed
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: profile.email,
        metadata: { supabase_user_id: user_id },
      });
      customerId = customer.id;
      await supabase
        .from('profiles')
        .update({ stripe_customer_id: customerId })
        .eq('id', user_id);
    }

    const sessionParams = {
      mode: isLifetime ? 'payment' : 'subscription',
      customer: customerId,
      line_items: [{ price: price_id, quantity: 1 }],
      success_url: safeRedirect(success_url, 'https://troystack.ai/settings?session_id={CHECKOUT_SESSION_ID}'),
      cancel_url: safeRedirect(cancel_url, 'https://troystack.ai/settings'),
      client_reference_id: user_id,
      metadata: campaign ? { user_id, tier, campaign } : { user_id, tier },
    };

    if (isLifetime) {
      sessionParams.invoice_creation = { enabled: true };
    }

    if (!isLifetime) {
      sessionParams.subscription_data = {
        trial_period_days: 7,
        trial_settings: {
          end_behavior: { missing_payment_method: 'cancel' },
        },
        ...(campaign ? { metadata: { campaign } } : {}),
      };
    }

    const session = await stripe.checkout.sessions.create(sessionParams);

    console.log(`💳 [Stripe] Checkout session created for user ${user_id}, tier=${tier}`);
    return res.json({ url: session.url });

  } catch (error) {
    console.error('❌ [Stripe] Create checkout error:', error.message);
    return res.status(500).json({ error: error.message });
  }
});

// POST /v1/stripe/verify-session
router.post('/verify-session', async (req, res) => {
  try {
    if (!stripe) {
      return res.status(503).json({ error: 'Stripe is not configured' });
    }

    const { session_id } = req.body;
    if (!session_id || typeof session_id !== 'string') {
      return res.status(400).json({ error: 'session_id is required' });
    }

    const session = await stripe.checkout.sessions.retrieve(session_id, {
      expand: ['subscription'],
    });

    const userId = session.client_reference_id || session.metadata?.user_id;
    if (!userId || !isUUID(userId)) {
      return res.status(400).json({ error: 'No valid user_id in session' });
    }

    const subscription = session.subscription;
    const subStatus = subscription?.status;
    const isPaid = session.payment_status === 'paid';
    const isTrialing = subStatus === 'trialing';
    const isActive = subStatus === 'active';

    if (!isPaid && !isTrialing && !isActive) {
      return res.json({ success: false, reason: 'Session not yet paid or trialing' });
    }

    let tier = session.metadata?.tier || 'gold';
    let subscriptionStatus = 'active';
    let trialEnd = null;

    if (subscription) {
      const price = subscription.items?.data?.[0]?.price;
      if (price?.id) {
        tier = await tierForCheckout(session, price);
      }
      subscriptionStatus = subscription.status || 'active';
      if (subscription.trial_end) {
        trialEnd = new Date(subscription.trial_end * 1000).toISOString();
      }
    } else if (session.mode === 'payment') {
      tier = session.metadata?.tier || 'lifetime';
    }

    const { error } = await supabase
      .from('profiles')
      .update({
        subscription_tier: tier,
        stripe_customer_id: session.customer,
        subscription_status: subscriptionStatus,
        trial_end: trialEnd,
      })
      .eq('id', userId);

    if (error) {
      console.error('❌ [Stripe Verify] Failed to update profile:', error.message);
      return res.status(500).json({ error: 'Failed to update subscription' });
    }

    console.log(`✅ [Stripe Verify] Session verified: user=${userId}, tier=${tier}, status=${subscriptionStatus}`);
    return res.json({ success: true, tier });

  } catch (error) {
    console.error('❌ [Stripe Verify] Error:', error.message);
    return res.status(500).json({ error: error.message });
  }
});

// POST /v1/stripe/customer-portal
router.post('/customer-portal', async (req, res) => {
  try {
    if (!stripe) {
      return res.status(503).json({ error: 'Stripe is not configured' });
    }

    const { user_id, return_url } = req.body;

    if (!user_id || !isUUID(user_id)) {
      return res.status(400).json({ error: 'Valid user_id is required' });
    }

    // The billing page shows payment details and can cancel a plan, so it
    // opens only for the account that's signed in.
    const auth = await signedInUserId(req, supabase);
    if (auth.error) return res.status(auth.status).json({ error: auth.error });
    if (auth.userId !== user_id) {
      return res.status(403).json({ error: 'That account is not the one signed in' });
    }

    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('stripe_customer_id')
      .eq('id', user_id)
      .single();

    if (profileError || !profile?.stripe_customer_id) {
      return res.status(404).json({ error: 'No Stripe customer found for this user' });
    }

    const session = await stripe.billingPortal.sessions.create({
      customer: profile.stripe_customer_id,
      return_url: safeRedirect(return_url, 'https://troystack.ai/settings'),
    });

    console.log(`💳 [Stripe] Customer portal session created for user ${user_id}`);
    return res.json({ url: session.url });

  } catch (error) {
    console.error('❌ [Stripe] Customer portal error:', error.message);
    return res.status(500).json({ error: error.message });
  }
});

// GET /v1/stripe/my-plan
// The web plan Stripe holds for the signed-in account. A plan bought on
// troystack.ai lives in Stripe, not RevenueCat, so the iPhone app asks here
// before it treats an account with no App Store plan as free. Answers
// { plan: 'gold' | 'lifetime' | null, status, trial_end }.
router.get('/my-plan', async (req, res) => {
  try {
    const auth = await signedInUserId(req, supabase);
    if (auth.error) return res.status(auth.status).json({ error: auth.error });
    // Without Stripe the plan can't be checked, which is not the same as none.
    if (!stripe) return res.status(503).json({ error: 'Could not check the web plan' });

    const { data: profile, error } = await supabase
      .from('profiles')
      .select('stripe_customer_id')
      .eq('id', auth.userId)
      .single();
    // No profile row is a confirmed answer of no web plan. Any other failure
    // isn't, so the app hears that it couldn't be checked and leaves the
    // account alone.
    if (error && error.code !== 'PGRST116') {
      console.error('❌ [Stripe] my-plan profile lookup failed:', error.message);
      return res.status(503).json({ error: 'Could not check the web plan' });
    }
    if (!profile?.stripe_customer_id) return res.json({ plan: null, status: null, trial_end: null });

    const found = await planFromStripe(profile.stripe_customer_id);
    if (!found) return res.json({ plan: null, status: null, trial_end: null });
    return res.json({ plan: found.tier, status: found.status, trial_end: found.trialEnd });
  } catch (error) {
    console.error('❌ [Stripe] my-plan error:', error.message);
    return res.status(500).json({ error: 'Could not check the web plan' });
  }
});

// GET /sync-subscription?user_id=xxx — mounted at /v1 in index.js
router.get('/sync-subscription', async (req, res) => {
  try {
    const { user_id } = req.query;

    if (!user_id || !isUUID(user_id)) {
      return res.status(400).json({ error: 'Valid user_id is required' });
    }

    const { data: profile, error } = await supabase
      .from('profiles')
      .select('subscription_tier, subscription_status, stripe_customer_id')
      .eq('id', user_id)
      .single();

    if (error || !profile) {
      return res.status(404).json({ error: 'User not found' });
    }

    let tier = profile.subscription_tier || 'free';
    let status = profile.subscription_status || null;

    // The iPhone app writes its own tier to the profile, and when RevenueCat
    // has nothing for someone it writes free, even over Gold or Lifetime they
    // paid for on the web. Stripe is the record for web plans, so a free
    // profile with a live subscription or a paid lifetime purchase gets it
    // back here. The answer only changes once the profile update succeeds.
    if (tier === 'free' && stripe && profile.stripe_customer_id) {
      try {
        const restored = await planFromStripe(profile.stripe_customer_id);
        if (restored) {
          const { error: updateError } = await supabase
            .from('profiles')
            .update({ subscription_tier: restored.tier, subscription_status: restored.status, trial_end: restored.trialEnd })
            .eq('id', user_id);
          if (updateError) {
            console.error(`[Sync Subscription] Could not restore ${restored.tier} for ${user_id}:`, updateError.message);
          } else {
            tier = restored.tier;
            status = restored.status;
            console.log(`🔁 [Sync Subscription] Restored ${tier} from Stripe for ${user_id}`);
          }
        }
      } catch (healErr) {
        console.error('[Sync Subscription] Stripe check failed:', healErr.message);
      }
    }

    return res.json({
      user_id,
      subscription_tier: tier,
      subscription_status: status,
    });

  } catch (error) {
    console.error('❌ [Sync Subscription] Error:', error.message);
    return res.status(500).json({ error: 'Failed to fetch subscription status' });
  }
});

// ============================================
// REVENUECAT WEBHOOK — iOS subscription events
// Always returns 200 to prevent RevenueCat retries
// ============================================

const REVENUECAT_WEBHOOK_SECRET = process.env.REVENUECAT_WEBHOOK_SECRET;

function mapProductToTier(productId) {
  if (!productId) return 'free';
  const pid = productId.toLowerCase();
  if (pid.includes('lifetime')) return 'lifetime';
  if (pid.includes('gold') || pid.includes('premium') || pid.includes('yearly') || pid.includes('monthly')) return 'gold';
  return 'free';
}

async function revenueCatWebhookHandler(req, res) {
  try {
    // Verify webhook secret
    if (REVENUECAT_WEBHOOK_SECRET) {
      const authHeader = req.headers['authorization'] || '';
      const token = authHeader.replace(/^Bearer\s+/i, '');
      if (token !== REVENUECAT_WEBHOOK_SECRET) {
        console.warn('[RevenueCat Webhook] Invalid authorization token');
        return res.status(401).json({ error: 'Unauthorized' });
      }
    }

    const event = req.body?.event || req.body;
    const eventType = event?.type;
    const appUserId = event?.app_user_id;
    const productId = event?.product_id;
    const expirationMs = event?.expiration_at_ms;

    console.log(`[RevenueCat Webhook] Event: ${eventType}, user: ${appUserId}, product: ${productId}`);

    // Skip anonymous users
    if (!appUserId || appUserId.startsWith('$RCAnonymousID:')) {
      return res.status(200).json({ success: true, skipped: true, reason: 'anonymous_user' });
    }

    // Validate UUID
    if (!isUUID(appUserId)) {
      return res.status(200).json({ success: true, skipped: true, reason: 'non_uuid_user' });
    }

    const tier = mapProductToTier(productId);
    const expirationDate = expirationMs ? new Date(expirationMs).toISOString() : null;

    switch (eventType) {
      case 'INITIAL_PURCHASE':
      case 'RENEWAL':
      case 'PRODUCT_CHANGE': {
        console.log(`  Setting tier=${tier}, expires=${expirationDate}`);
        const { error } = await supabase
          .from('profiles')
          .update({
            subscription_tier: tier,
            subscription_expires_at: expirationDate,
          })
          .eq('id', appUserId);

        if (error) console.error('  Supabase update failed:', error.message);
        break;
      }

      case 'CANCELLATION': {
        // Keep access until expiration — only update expiry date
        console.log(`  Cancellation — keeping tier, setting expiry=${expirationDate}`);
        const { error } = await supabase
          .from('profiles')
          .update({ subscription_expires_at: expirationDate })
          .eq('id', appUserId);

        if (error) console.error('  Supabase update failed:', error.message);
        break;
      }

      case 'EXPIRATION': {
        console.log('  Subscription expired — downgrading to free');
        const { error } = await supabase
          .from('profiles')
          .update({
            subscription_tier: 'free',
            subscription_expires_at: null,
          })
          .eq('id', appUserId);

        if (error) console.error('  Supabase update failed:', error.message);
        break;
      }

      case 'BILLING_ISSUE_DETECTED': {
        console.log('  Billing issue detected — no tier change (grace period)');
        break;
      }

      default:
        console.log(`  Unhandled event type: ${eventType}`);
    }

    return res.status(200).json({ success: true, processed: true });

  } catch (error) {
    console.error('[RevenueCat Webhook] Error:', error.message);
    // Still return 200 to prevent retries
    return res.status(200).json({ success: false, error: error.message });
  }
}

module.exports = router;
module.exports.stripeWebhookHandler = stripeWebhookHandler;
module.exports.revenueCatWebhookHandler = revenueCatWebhookHandler;
module.exports.resetGoldProductCache = resetGoldProductCache;
