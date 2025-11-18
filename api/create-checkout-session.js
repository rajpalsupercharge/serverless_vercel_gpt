// pages/api/create-checkout-session.js
import Stripe from "stripe";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2024-06-20",
});

export default async function handler(req, res) {
  // Allow only POST
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { email, plan_tier = "pro" } = req.body || {};

    // 1) Validate input
    if (!email) {
      return res.status(400).json({ error: "Email is required" });
    }

    // 2) Map plan_tier -> Stripe price ID
    let priceId;
    switch (plan_tier) {
      case "pro":
        // e.g. price_1SHwa8DoBVpeHi4xjJnwi4va
        priceId = process.env.STRIPE_PRICE_PRO;
        break;
      default:
        return res.status(400).json({ error: "Invalid plan_tier" });
    }

    if (!priceId) {
      return res
        .status(500)
        .json({ error: "Missing Stripe price ID environment variable" });
    }

    // 3) Find or create customer
    const existing = await stripe.customers.list({ email, limit: 1 });
    const customer =
      existing.data[0] ||
      (await stripe.customers.create({
        email,
      }));

    // 4) Build base URL (MUST include scheme in env)
    const BASE_URL = process.env.FRONTEND_URL || "http://localhost:3000";

    const successUrl = `${BASE_URL}/success?session_id={CHECKOUT_SESSION_ID}`;
    const cancelUrl = `${BASE_URL}/cancel`;

    // 5) Create checkout session
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
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata: {
        email,
        plan: plan_tier,
      },
    });

    // 6) Return data to GPT / frontend
    return res.status(200).json({
      id: session.id,
      url: session.url,
      session_id: session.id,
      checkout_url: session.url,
    });
  } catch (err) {
    console.error("Stripe checkout error:", err);
    return res
      .status(500)
      .json({ error: err.message || "Something went wrong" });
  }
}
