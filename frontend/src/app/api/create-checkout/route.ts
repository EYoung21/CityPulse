import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { stripeCustomerId } from "@/lib/stripe-pass";
import { readJsonBody, RequestBodyError } from "@/lib/server-body";

function getStripe() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_SECRET_KEY not configured");
  return new Stripe(key, { apiVersion: "2026-03-25.dahlia" });
}

function ensureAdmin() {
  if (getApps().length === 0) {
    const projectId = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
    if (process.env.FIREBASE_ADMIN_KEY) {
      initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_ADMIN_KEY)) });
    } else {
      initializeApp({ projectId });
    }
  }
  return getAuth();
}

export async function POST(req: NextRequest) {
  try {
    // Derive the caller's identity from a verified Firebase ID token.
    // The uid that ends up in Stripe metadata.firebaseUid MUST come from
    // the token, never the request body — otherwise a client could mint
    // a Pro grant for any account by passing someone else's uid. Any
    // `uid` in the body is ignored; only `plan` is still read from it.
    const authHeader = req.headers.get("authorization") || "";
    const idToken = authHeader.startsWith("Bearer ")
      ? authHeader.slice("Bearer ".length).trim()
      : "";
    if (!idToken) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    let uid: string;
    let email: string | undefined;
    try {
      const decoded = await ensureAdmin().verifyIdToken(idToken, true);
      uid = decoded.uid;
      email = decoded.email;
    } catch (err) {
      console.error("Checkout token verification failed:", err);
      return NextResponse.json({ error: "Invalid or expired token" }, { status: 401 });
    }

    // Initialize billing only after authentication. Otherwise a deployment
    // with missing Stripe configuration turns a normal signed-out request
    // into a misleading 500 and leaks configuration state ahead of the auth
    // gate.
    const stripe = getStripe();

    // Reuse the subscription customer recorded by the webhook. Otherwise each
    // checkout creates a new Customer, and canceling one subscription can no
    // longer reliably answer whether the same account has another active one.
    let existingCustomerId: string | null = null;
    try {
      const userSnap = await getFirestore().doc(`users/${uid}`).get();
      existingCustomerId = stripeCustomerId(userSnap.data()?.stripeCustomerId);
    } catch (err) {
      // Billing can still proceed if the optional lookup is temporarily
      // unavailable; the webhook metadata remains the identity authority.
      console.warn("Checkout customer lookup failed:", err);
    }

    let body: { plan?: unknown };
    try {
      body = await readJsonBody<{ plan?: unknown }>(req, 16 * 1024);
    } catch (err) {
      if (err instanceof RequestBodyError) {
        return NextResponse.json({ error: err.message }, { status: err.status });
      }
      throw err;
    }
    const { plan } = body;

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
      ? { firebaseUid: uid, passType: "3day" }
      : { firebaseUid: uid };

    const session = await stripe.checkout.sessions.create({
      mode: isOneTimePass ? "payment" : "subscription",
      payment_method_types: ["card"],
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${req.nextUrl.origin}/?upgraded=1`,
      cancel_url: `${req.nextUrl.origin}/`,
      metadata: sessionMetadata,
      ...(isOneTimePass
        ? { payment_intent_data: { metadata: sessionMetadata } }
        : { subscription_data: { metadata: sessionMetadata } }),
      ...(existingCustomerId
        ? { customer: existingCustomerId }
        : email
          ? { customer_email: email }
          : {}),
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
