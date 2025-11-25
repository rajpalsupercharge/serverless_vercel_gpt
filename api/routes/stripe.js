const express = require('express');
const router = express.Router();
const Stripe = require('stripe');
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const supabase = require('../lib/supabase');
const { authenticateApiKey } = require('../middleware/auth');

function getPriceId() {
  if (!process.env.STRIPE_PRICE_ID) {
    throw new Error('STRIPE_PRICE_ID environment variable is not set');
  }
  return process.env.STRIPE_PRICE_ID;
}

function getDaysUntilDue() {
  // User requested 0 days grace period (due immediately)
  // If Stripe requires >= 1, we might need to adjust, but trying 0 as requested.
  const parsed = parseInt(process.env.STRIPE_DAYS_UNTIL_DUE || '0', 10);
  if (Number.isNaN(parsed)) {
    return 0;
  }
  return Math.max(parsed, 0);
}

function normalizePlanOption(planInput = 'pro') {
  const planMap = {
    pro: 'Pro',
    free: 'Free'
  };
  const normalized = planInput.trim().toLowerCase();
  return planMap[normalized] || planInput;
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

    // Ensure user exists in Supabase
    let user;
    const { data: users, error: findError } = await supabase
      .from('users')
      .select('*')
      .ilike('email', email)
      .limit(1);

    if (findError) throw findError;

    if (!users || users.length === 0) {
      const { data: newUser, error: createError } = await supabase
        .from('users')
        .insert([{ email: email }])
        .select()
        .single();
      if (createError) throw createError;
      user = newUser;
    } else {
      user = users[0];
    }

    // Get or create Stripe customer
    let customer;
    if (user.stripe_customer_id) {
      try {
        customer = await stripe.customers.retrieve(user.stripe_customer_id);
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

    // Initial status check - for new subscriptions with trial, it will be 'trialing'
    // For 'send_invoice', it might be 'active' immediately if no trial, but we want 'awaiting_payment'
    let dbStatus = mapStripeStatusToDb(subscription.status);

    // STRICT CHECK: If active but send_invoice, check if paid
    if (subscription.status === 'active' && subscription.collection_method === 'send_invoice') {
      // New subscription, likely unpaid invoice if just created
      // But if it's a trial, status is trialing.
      // If it's active, it means trial is over or didn't exist.
      // We assume awaiting payment until we confirm otherwise.
      dbStatus = 'awaiting_payment';
    }

    // Update Supabase
    const updateFields = {
      stripe_customer_id: customer.id,
      subscription_id: subscription.id,
      status: dbStatus,
      plan: normalizedPlan,
      updated_at: new Date().toISOString()
    };

    if (subscription.current_period_end) {
      updateFields.current_period_end = new Date(subscription.current_period_end * 1000).toISOString();
    }

    await supabase
      .from('users')
      .update(updateFields)
      .eq('id', user.id);

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

// Resend latest open invoice
router.post('/resend-invoice', authenticateApiKey, async (req, res) => {
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
      return res.status(404).json({ error: 'Customer not found' });
    }

    const customer = customers.data[0];

    // Find open invoices
    const invoices = await stripe.invoices.list({
      customer: customer.id,
      status: 'open',
      limit: 1
    });

    if (invoices.data.length === 0) {
      return res.status(404).json({ error: 'No open invoices found' });
    }

    const invoice = invoices.data[0];

    // Resend the invoice
    await stripe.invoices.sendInvoice(invoice.id);

    res.json({
      message: 'Invoice sent successfully',
      invoice_id: invoice.id
    });

  } catch (error) {
    console.error('Resend invoice error:', error);
    res.status(500).json({ error: 'Failed to resend invoice' });
  }
});

// Webhook handler
async function stripeWebhookHandler(req, res) {
  console.log('Webhook received');

  const sig = req.headers['stripe-signature'];
  const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!sig || !endpointSecret) {
    return res.status(400).send('Missing signature or secret');
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
        await handleCheckoutComplete(event.data.object);
        break;

      case 'customer.subscription.updated':
      case 'customer.subscription.deleted':
        await handleSubscriptionUpdate(event.data.object);
        break;

      case 'invoice.payment_succeeded':
        await handleInvoicePaid(event.data.object);
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

async function handleCheckoutComplete(session) {
  const customer = await stripe.customers.retrieve(session.customer);
  const subscription = await stripe.subscriptions.retrieve(session.subscription);

  await updateUserStatus(customer.email, {
    status: 'active',
    subscription_id: subscription.id,
    current_period_end: new Date(subscription.current_period_end * 1000).toISOString()
  });
}

async function handleSubscriptionUpdate(subscription) {
  const customer = await stripe.customers.retrieve(subscription.customer);
  let dbStatus = mapStripeStatusToDb(subscription.status);

  // STRICT LOGIC: If Stripe says 'active', we verify if the latest invoice is actually paid.
  // This prevents 'send_invoice' subscriptions from being active before payment.
  if (subscription.status === 'active' && subscription.collection_method === 'send_invoice') {
    try {
      // Fetch the latest invoice to check its status
      if (subscription.latest_invoice) {
        const invoice = await stripe.invoices.retrieve(subscription.latest_invoice);
        if (invoice.status !== 'paid') {
          console.log(`Strict Check: Subscription ${subscription.id} is active but invoice ${invoice.id} is ${invoice.status}. Setting status to awaiting_payment.`);
          dbStatus = 'awaiting_payment';
        }
      }
    } catch (err) {
      console.error('Error fetching invoice for strict check:', err);
      // Fallback: if we can't check, maybe default to awaiting_payment to be safe?
      // Or trust Stripe? Let's trust Stripe but log error.
    }
  }

  await updateUserStatus(customer.email, {
    status: dbStatus,
    current_period_end: new Date(subscription.current_period_end * 1000).toISOString()
  });
}

async function handleInvoicePaid(invoice) {
  if (!invoice.subscription) return;

  const customer = await stripe.customers.retrieve(invoice.customer);

  // Explicitly mark as active/paid when invoice is paid
  // This is the GOLDEN SIGNAL for access.
  await updateUserStatus(customer.email, {
    status: 'active',
    updated_at: new Date().toISOString()
  });
  console.log(`Invoice paid for ${customer.email}, status set to active`);
}

async function updateUserStatus(email, updates) {
  const { error } = await supabase
    .from('users')
    .update(updates)
    .ilike('email', email);

  if (error) console.error('Error updating user status:', error);
}

function mapStripeStatusToDb(stripeStatus) {
  const statusMap = {
    'active': 'active',
    'trialing': 'trialing',
    'past_due': 'past_due', // Strict handling: past_due means NO ACCESS
    'unpaid': 'past_due',
    'canceled': 'canceled',
    'incomplete': 'pending',
    'incomplete_expired': 'none'
  };
  return statusMap[stripeStatus] || 'none';
}

module.exports = {
  router,
  stripeWebhookHandler
};
