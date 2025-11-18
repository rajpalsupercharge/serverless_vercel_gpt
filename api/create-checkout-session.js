// pages/api/create-checkout-session.js

import Stripe from "stripe";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2024-06-20",
});

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).end("Method Not Allowed");
  }

  try {
    const { email, plan_tier } = req.body || {};

    // 1) Map plan_tier to Stripe price ID
    let priceId;
    if (plan_tier === "pro") {
      priceId = process.env.STRIPE_PRICE_PRO;
    } else {
      // Fallback, or you can return error
      return res.status(400).json({ error: "Invalid plan_tier" });
    }

    // 2) Find or create customer
    const customers = await stripe.customers.list({ email, limit: 1 });
    const customer =
      customers.data[0] ||
      (await stripe.customers.create({
        email,
      }));

    // 3) Create checkout session
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customer.id,
      line_items: [
        {
          price: priceId,
          quantity: 1,
        },
      ],
      allow_promotion_codes: true,
      payment_method_collection: "if_required",
      metadata: {
        email,
        plan: plan_tier,
      },
      success_url:
        "https://serverless-vercel-gpt.vercel.app/success?session_id={CHECKOUT_SESSION_ID}",
      cancel_url:
        "https://serverless-vercel-gpt.vercel.app/cancel",
    });

    return res.status(200).json({
      id: session.id,
      url: session.url,
    });
  } catch (err) {
    console.error("Stripe error:", err);
    return res.status(500).json({ error: err.message });
  }
}
