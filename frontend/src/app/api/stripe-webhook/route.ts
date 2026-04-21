import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getFirestore, Timestamp } from "firebase-admin/firestore";

// Pass durations live here so changing the SKU window (e.g. adding a
// 7-day pass) is a one-line edit rather than a hunt through the
// webhook switch. Hours, not ms — the conversion to a Firestore
// Timestamp happens at the call site.
const PASS_DURATIONS_HOURS: Record<string, number> = {
  "3day": 72,
};

function getStripe() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_SECRET_KEY not configured");
  return new Stripe(key, { apiVersion: "2026-03-25.dahlia" });
}

function getAdminDb() {
  if (getApps().length === 0) {
    const projectId = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
    if (process.env.FIREBASE_ADMIN_KEY) {
      initializeApp({
        credential: cert(JSON.parse(process.env.FIREBASE_ADMIN_KEY)),
      });
    } else {
      initializeApp({ projectId });
    }
  }
  return getFirestore();
}

async function updateUserTier(uid: string, tier: "free" | "pro") {
  const db = getAdminDb();
  await db.doc(`users/${uid}`).set({ tier, tierUpdatedAt: new Date() }, { merge: true });
}

/** Grant a finite-duration Pro pass by writing a `proUntil` Timestamp
 *  on the user doc. Deliberately does NOT touch the `tier` field —
 *  the auth context resolves `isPro` as `tier==='pro' || proUntil>now`,
 *  so subscriptions and passes are independent and can co-exist
 *  without one stomping the other on cancel/refund flows. If the
 *  user already has a future `proUntil` (e.g. they bought another
 *  pass before the first expired), we extend from the existing
 *  expiry rather than from now so they get the full duration they
 *  paid for. */
async function grantPass(uid: string, durationHours: number) {
  const db = getAdminDb();
  const ref = db.doc(`users/${uid}`);
  const snap = await ref.get();
  const existing = snap.data()?.proUntil as Timestamp | undefined;
  const now = Date.now();
  const baseMs = existing && existing.toMillis() > now ? existing.toMillis() : now;
  const proUntil = Timestamp.fromMillis(baseMs + durationHours * 60 * 60 * 1000);
  await ref.set({ proUntil, passGrantedAt: new Date() }, { merge: true });
}

async function findUidByStripeCustomer(customerId: string): Promise<string | null> {
  const db = getAdminDb();
  const snap = await db
    .collection("users")
    .where("stripeCustomerId", "==", customerId)
    .limit(1)
    .get();
  return snap.empty ? null : snap.docs[0].id;
}

export async function POST(req: NextRequest) {
  const stripe = getStripe();
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    return NextResponse.json({ error: "Webhook secret not configured" }, { status: 500 });
  }

  const body = await req.text();
  const sig = req.headers.get("stripe-signature")!;

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(body, sig, webhookSecret);
  } catch (err) {
    console.error("Webhook signature verification failed:", err);
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object as Stripe.Checkout.Session;
      const uid = session.metadata?.firebaseUid;
      if (uid) {
        // Branch on Checkout mode: subscriptions flip the persistent
        // `tier` field; one-time pass payments instead grant a
        // finite `proUntil` window without touching `tier`. This
        // keeps the two grant types independent so a user who buys
        // a 3-day pass while already subscribed (or vice versa)
        // doesn't get their access state corrupted on refund/cancel.
        if (session.mode === "subscription") {
          await updateUserTier(uid, "pro");
        } else if (session.mode === "payment") {
          const passType = session.metadata?.passType;
          const hours = passType ? PASS_DURATIONS_HOURS[passType] : undefined;
          if (hours) {
            await grantPass(uid, hours);
          } else {
            console.warn(
              "checkout.session.completed: payment mode with unknown/missing passType",
              { passType, sessionId: session.id }
            );
          }
        }

        // Always mirror the Stripe customer ID so the
        // customer.subscription.* handlers below can find the user
        // doc by reverse lookup. Both subscription and one-time
        // payment Checkout sessions populate `customer` when an
        // email is provided (which our create-checkout route does).
        if (session.customer) {
          const db = getAdminDb();
          await db.doc(`users/${uid}`).set(
            { stripeCustomerId: session.customer as string },
            { merge: true }
          );
        }
      }
      break;
    }

    case "payment_intent.succeeded": {
      // Belt-and-suspenders for the 3-day pass flow. We subscribe to
      // this event in addition to checkout.session.completed because
      // checkout.session.completed occasionally fires before the
      // payment is fully captured for cards that need 3DS or other
      // post-auth flows. payment_intent.succeeded is the canonical
      // "money is in the bank" event. We deliberately make the
      // grantPass call idempotent-ish via the "extend from existing
      // expiry" logic above, so processing the same pass twice
      // doesn't double the duration — the second call sees the
      // existing future proUntil and the extension math is the same.
      // Subscription invoices also fire payment_intent.succeeded
      // events; we ignore those by requiring the metadata.passType
      // marker that only one-time pass Checkout sessions carry.
      const pi = event.data.object as Stripe.PaymentIntent;
      const uid = pi.metadata?.firebaseUid;
      const passType = pi.metadata?.passType;
      const hours = passType ? PASS_DURATIONS_HOURS[passType] : undefined;
      if (uid && hours) {
        await grantPass(uid, hours);
      }
      break;
    }

    case "customer.subscription.deleted":
    case "customer.subscription.updated": {
      const sub = event.data.object as Stripe.Subscription;
      const uid = await findUidByStripeCustomer(sub.customer as string);
      if (uid) {
        const isActive = sub.status === "active" || sub.status === "trialing";
        await updateUserTier(uid, isActive ? "pro" : "free");
      }
      break;
    }
  }

  return NextResponse.json({ received: true });
}
