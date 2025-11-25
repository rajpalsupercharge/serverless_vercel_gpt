// pages/api/create-checkout-session.js
import Stripe from "stripe";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2024-06-20",
});

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { email, plan_tier = "pro" } = req.body || {};

    if (!email) {
      return res.status(400).json({ error: "Email is required" });
    }

    // Map plan tier → Stripe price
    let priceId;
    switch (plan_tier) {
      case "pro":
        priceId = process.env.STRIPE_PRICE_PRO; // e.g. price_1SHwa8DoBVpeHi4xjJnwi4va
        break;
      default:
        return res.status(400).json({ error: "Invalid plan_tier" });
    }

    if (!priceId) {
      return res
        .status(500)
        .json({ error: "Missing STRIPE_PRICE_PRO environment variable" });
    }

    // Find or create customer
    const existing = await stripe.customers.list({ email, limit: 1 });
    const customer =
      existing.data[0] ||
      (await stripe.customers.create({
        email,
      }));

    // 🔥 Hard-coded, fully-qualified URLs (no env, no BASE_URL)
    const successUrl =
      "https://serverless-vercel-gpt.vercel.app/success?session_id={CHECKOUT_SESSION_ID}";
    const cancelUrl = "https://serverless-vercel-gpt.vercel.app/cancel";

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customer.id,
      allow_promotion_codes: true,
      payment_method_collection: "if_required",
      line_items: [
        {
          price: priceId,
          quantity: 1,
        },
      ],
      subscription_data: {
        trial_period_days: 1,
      },
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata: {
        email,
        plan: plan_tier,
      },
    });

    return res.status(200).json({
      id: session.id,
      url: session.url,
      session_id: session.id,
      checkout_url: session.url,
    });
  } catch (err) {
    console.error("Stripe checkout error:", err);
    return res.status(500).json({
      error: err.message || "Something went wrong",
    });
  }
}
