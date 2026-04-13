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

    const priceId = plan === "monthly"
      ? process.env.STRIPE_PRICE_MONTHLY
      : plan === "annual"
        ? process.env.STRIPE_PRICE_ANNUAL
        : undefined;
    if (!priceId) {
      return NextResponse.json({ error: "Invalid plan" }, { status: 400 });
    }

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      payment_method_types: ["card"],
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${req.nextUrl.origin}/?upgraded=1`,
      cancel_url: `${req.nextUrl.origin}/`,
      metadata: { firebaseUid: uid || "" },
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
