import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { email, plan_tier } = req.body || {};
    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    const BASE_URL =
      process.env.FRONTEND_URL || 'http://localhost:3000'; // MUST include http(s) in env

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      allow_promotion_codes: true,
      payment_method_collection: 'if_required',
      line_items: [
        {
          price: process.env.STRIPE_PRO_PRICE_ID, // e.g. price_1SHwa8DoBVpeHi4xjJnwi4va
          quantity: 1,
        },
      ],
      success_url: `${BASE_URL}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${BASE_URL}/cancel`,
      metadata: {
        email,
        plan: plan_tier || 'pro',
      },
    });

    return res.status(200).json({
      session_id: session.id,
      checkout_url: session.url,
    });
  } catch (err) {
    console.error('Stripe checkout error:', err);
    return res.status(500).json({
      error: err.message || 'Something went wrong',
    });
  }
}
