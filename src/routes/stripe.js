const express = require('express');
const supabase = require('../lib/supabase');

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
          try {
            const subscription = await stripe.subscriptions.retrieve(session.subscription);
            const priceId = subscription.items?.data?.[0]?.price?.id;
            if (priceId) {
              tier = mapStripePriceToTier(priceId);
            }
            subscriptionStatus = subscription.status || 'active';
            if (subscription.trial_end) {
              trialEnd = new Date(subscription.trial_end * 1000).toISOString();
            }
          } catch (e) {
            console.warn('⚠️ [Stripe Webhook] Could not retrieve subscription:', e.message);
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

    const tier = mapStripePriceToTier(price_id);
    const isLifetime = isLifetimePrice(price_id);

    const sessionParams = {
      mode: isLifetime ? 'payment' : 'subscription',
      customer: customerId,
      line_items: [{ price: price_id, quantity: 1 }],
      success_url: success_url || 'https://stacktrackergold.com/settings?session_id={CHECKOUT_SESSION_ID}',
      cancel_url: cancel_url || 'https://stacktrackergold.com/settings',
      client_reference_id: user_id,
      metadata: { user_id, tier },
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
      const priceId = subscription.items?.data?.[0]?.price?.id;
      if (priceId) {
        tier = mapStripePriceToTier(priceId);
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
      return_url: return_url || 'https://stacktrackergold.com/settings',
    });

    console.log(`💳 [Stripe] Customer portal session created for user ${user_id}`);
    return res.json({ url: session.url });

  } catch (error) {
    console.error('❌ [Stripe] Customer portal error:', error.message);
    return res.status(500).json({ error: error.message });
  }
});

module.exports = router;
module.exports.stripeWebhookHandler = stripeWebhookHandler;
