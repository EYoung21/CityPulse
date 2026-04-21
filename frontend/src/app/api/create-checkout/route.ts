import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";

function getStripe() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_SECRET_KEY not configured");
  return new Stripe(key, { apiVersion: "2026-03-25.dahlia" });
}

export async function POST(req: NextRequest) {
  try {
    const stripe = getStripe();

    const { plan, uid, email } = await req.json();

    // Resolve the Stripe Price ID and Checkout mode for the selected
    // plan. The 3-day pass is the only one-time SKU we sell — it uses
    // Checkout `mode: "payment"` and a non-recurring Price configured
    // in the Stripe dashboard. The webhook (stripe-webhook/route.ts)
    // branches on `session.mode` + `metadata.passType` to decide
    // whether to set `tier: "pro"` (subscription) or `proUntil`
    // (timed pass).
    const priceId =
      plan === "monthly"
        ? process.env.STRIPE_PRICE_MONTHLY
        : plan === "annual"
          ? process.env.STRIPE_PRICE_ANNUAL
          : plan === "3day"
            ? process.env.STRIPE_PRICE_3DAY
            : undefined;
    if (!priceId) {
      return NextResponse.json({ error: "Invalid plan" }, { status: 400 });
    }

    const isOneTimePass = plan === "3day";

    // Build metadata explicitly per branch. Stripe's MetadataParam
    // type rejects `undefined` values (only string/number/null are
    // allowed), so we can't use a spread of an "empty or {passType}"
    // object — TS sees the optional-key shape and complains. The
    // payment_intent_data mirror exists because Stripe does not
    // automatically copy Checkout Session metadata to the underlying
    // PaymentIntent, so without it the payment_intent.succeeded
    // backup handler in the webhook would fire blind. Subscriptions
    // don't need that mirror because they're handled via the
    // customer.subscription.* event family on the customer object.
    const sessionMetadata: Record<string, string> = isOneTimePass
      ? { firebaseUid: uid || "", passType: "3day" }
      : { firebaseUid: uid || "" };

    const session = await stripe.checkout.sessions.create({
      mode: isOneTimePass ? "payment" : "subscription",
      payment_method_types: ["card"],
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${req.nextUrl.origin}/?upgraded=1`,
      cancel_url: `${req.nextUrl.origin}/`,
      metadata: sessionMetadata,
      ...(isOneTimePass
        ? { payment_intent_data: { metadata: sessionMetadata } }
        : {}),
      ...(email ? { customer_email: email } : {}),
    });

    return NextResponse.json({ url: session.url });
  } catch (err) {
    console.error("Stripe checkout error:", err);
    return NextResponse.json(
      { error: "Failed to create checkout session" },
      { status: 500 }
    );
  }
}
