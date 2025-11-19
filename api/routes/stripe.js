const express = require('express');
const router = express.Router();
const Stripe = require('stripe');
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const Airtable = require('airtable');
const { authenticateApiKey } = require('../middleware/auth');

const base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(process.env.AIRTABLE_BASE_ID);

function getPriceId() {
  if (!process.env.STRIPE_PRICE_ID) {
    throw new Error('STRIPE_PRICE_ID environment variable is not set');
  }
  return process.env.STRIPE_PRICE_ID;
}

function getDaysUntilDue() {
  const parsed = parseInt(process.env.STRIPE_DAYS_UNTIL_DUE || '7', 10);
  if (Number.isNaN(parsed)) {
    return 7;
  }
  return Math.min(Math.max(parsed, 0), 30);
}

function normalizePlanOption(planInput = 'pro') {
  const planMap = {
    pro: 'Pro',
    free: 'Free'
  };
  const normalized = planInput.trim().toLowerCase();
  return planMap[normalized] || planInput;
}

function formatDateForAirtable(unixSeconds) {
  if (!unixSeconds) {
    return null;
  }
  return new Date(unixSeconds * 1000).toISOString().split('T')[0];
}

// Create checkout session (now creates subscription directly)
router.post('/create-checkout-session', authenticateApiKey, async (req, res) => {
  try {
    const { email, plan_tier, plan } = req.body;
    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    const selectedPlan = plan_tier || plan || 'pro';
    const normalizedPlan = normalizePlanOption(selectedPlan);

    // Ensure Airtable record exists (create on-demand if missing)
    let airtableRecord;
    let records = await base('Users').select({
      filterByFormula: `LOWER({Email}) = LOWER('${email.toLowerCase()}')`,
      maxRecords: 1
    }).firstPage();

    if (records.length === 0) {
      const created = await base('Users').create([
        {
          fields: { Email: email }
        }
      ]);
      airtableRecord = created[0];
    } else {
      airtableRecord = records[0];
    }

    // Get or create Stripe customer (prefer Airtable stored id)
    let customer;
    if (airtableRecord.fields.StripeCustomerId) {
      try {
        customer = await stripe.customers.retrieve(airtableRecord.fields.StripeCustomerId);
      } catch (err) {
        console.warn('Stored Stripe customer not found, recreating:', err.message);
      }
    }

    if (!customer) {
      const customers = await stripe.customers.list({
        email: email,
        limit: 1
      });

      if (customers.data.length > 0) {
        customer = customers.data[0];
      } else {
        customer = await stripe.customers.create({
          email,
          metadata: {
            source: 'gpt_paywall'
          }
        });
      }
    }

    // Look for existing active/trialing subscription
    const existingSubscriptions = await stripe.subscriptions.list({
      customer: customer.id,
      status: 'all',
      limit: 10
    });
    const activeSubscription = existingSubscriptions.data.find(
      sub => sub.status === 'active' || sub.status === 'trialing'
    );

    let subscription;
    let subscriptionCreated = false;
    if (activeSubscription) {
      subscription = activeSubscription;
    } else {
      subscription = await stripe.subscriptions.create({
        customer: customer.id,
        items: [
          {
            price: getPriceId()
          }
        ],
        trial_period_days: 1,
        collection_method: 'send_invoice',
        days_until_due: getDaysUntilDue(),
        metadata: {
          email,
          plan: normalizedPlan,
          source: 'gpt_paywall'
        }
      });
      subscriptionCreated = true;
    }

    const airtableStatus = mapStripeStatusToAirtable(subscription.status);
    const currentPeriodEnd = formatDateForAirtable(subscription.current_period_end);

    // Update Airtable with latest subscription details
    const updateFields = {
      StripeCustomerId: customer.id,
      SubscriptionId: subscription.id,
      Status: airtableStatus,
      Plan: normalizedPlan
    };
    if (currentPeriodEnd) {
      updateFields.CurrentPeriodEnd = currentPeriodEnd;
    }

    try {
      await base('Users').update([
        {
          id: airtableRecord.id,
          fields: updateFields
        }
      ]);
    } catch (airtableError) {
      console.error('Airtable error:', airtableError);
      // Don't fail the subscription creation if Airtable update fails
    }

    res.json({
      subscription_id: subscription.id,
      status: subscription.status,
      subscription_created: subscriptionCreated,
      collection_method: subscription.collection_method,
      trial_end: subscription.trial_end ? new Date(subscription.trial_end * 1000).toISOString() : null,
      current_period_end: subscription.current_period_end ? new Date(subscription.current_period_end * 1000).toISOString() : null,
      customer_id: customer.id
    });

  } catch (error) {
    console.error('Subscription creation error:', error);
    res.status(500).json({ error: 'Failed to create subscription' });
  }
});

// Create customer portal session
router.post('/create-portal-session', authenticateApiKey, async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    // Get customer from Stripe
    const customers = await stripe.customers.list({
      email: email,
      limit: 1
    });

    if (customers.data.length === 0) {
      return res.status(404).json({ error: 'No subscription found for this email' });
    }

    const customer = customers.data[0];

    // Create portal session
    const session = await stripe.billingPortal.sessions.create({
      customer: customer.id,
      return_url: process.env.RETURN_URL || 'https://chat.openai.com'
    });

    res.json({
      portal_url: session.url
    });

  } catch (error) {
    console.error('Portal session error:', error);
    res.status(500).json({ error: 'Failed to create portal session' });
  }
});

// Webhook handler for Stripe events (exported so raw body can be provided before parsing)
async function stripeWebhookHandler(req, res) {
  console.log('Webhook received');
  console.log('   Headers:', JSON.stringify(req.headers, null, 2));
  
  const sig = req.headers['stripe-signature'];
  const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!sig) {
    console.error('Missing stripe-signature header');
    return res.status(400).send('Missing stripe-signature header');
  }

  if (!endpointSecret) {
    console.error('STRIPE_WEBHOOK_SECRET not set in environment');
    return res.status(500).send('Webhook secret not configured');
  }

  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
    console.log('Webhook verified - Event type:', event.type);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed':
        const session = event.data.object;
        await handleCheckoutComplete(session);
        break;

      case 'customer.subscription.updated':
      case 'customer.subscription.deleted':
        const subscription = event.data.object;
        await handleSubscriptionUpdate(subscription);
        break;

      default:
        console.log(`Unhandled event type ${event.type}`);
    }

    res.json({ received: true });
  } catch (error) {
    console.error('Webhook processing error:', error);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
}

// Helper function to handle checkout completion
async function handleCheckoutComplete(session) {
  const customer = await stripe.customers.retrieve(session.customer);
  const subscription = await stripe.subscriptions.retrieve(session.subscription);
  
  // Update user in Airtable
  const records = await base('Users').select({
    filterByFormula: `LOWER({Email}) = LOWER('${customer.email.toLowerCase()}')`,
    maxRecords: 1
  }).firstPage();

  if (records.length > 0) {
    await base('Users').update([
      {
        id: records[0].id,
        fields: {
          Status: 'active',
          SubscriptionId: subscription.id,
          CurrentPeriodEnd: formatDateForAirtable(subscription.current_period_end)
          // UpdatedAt is auto-managed by Airtable (computed field)
        }
      }
    ]);
  }
}

// Map Stripe subscription status to Airtable Status options
// Airtable options: active, trialing, canceled, none, pending
function mapStripeStatusToAirtable(stripeStatus) {
  const statusMap = {
    'active': 'active',
    'trialing': 'trialing',
    'past_due': 'trialing',
    'unpaid': 'trialing',
    'canceled': 'canceled',
    'cancelled': 'canceled',  // Handle both spellings
    'incomplete': 'pending',  // Incomplete checkout stays as pending
    'incomplete_expired': 'none'
  };
  
  return statusMap[stripeStatus] || 'none';
}

// Helper function to handle subscription updates
async function handleSubscriptionUpdate(subscription) {
  const customer = await stripe.customers.retrieve(subscription.customer);
  
  // Map Stripe status to Airtable status
  const airtableStatus = mapStripeStatusToAirtable(subscription.status);
  
  // Update user in Airtable
  const records = await base('Users').select({
    filterByFormula: `{StripeCustomerId} = '${subscription.customer}'`,
    maxRecords: 1
  }).firstPage();

  if (records.length > 0) {
    await base('Users').update([
      {
        id: records[0].id,
        fields: {
          Status: airtableStatus,  // Use mapped status instead of raw Stripe status
          CurrentPeriodEnd: formatDateForAirtable(subscription.current_period_end)
          // UpdatedAt is auto-managed by Airtable (computed field)
        }
      }
    ]);
  }
}

module.exports = {
  router,
  stripeWebhookHandler
};
