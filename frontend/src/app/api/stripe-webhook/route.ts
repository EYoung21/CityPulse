import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import {
  isActiveStripeSubscriptionStatus,
  nextPassExpiryMillis,
  stripeCustomerId,
  stripePaymentIntentId,
} from "@/lib/stripe-pass";
import { readBodyText, RequestBodyError } from "@/lib/server-body";

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
async function grantPassOnce(
  uid: string,
  durationHours: number,
  paymentIntentId: string,
  sourceEventId: string
) {
  const db = getAdminDb();
  const userRef = db.doc(`users/${uid}`);
  const grantRef = db.doc(`stripePassGrants/${paymentIntentId}`);
  const now = Date.now();

  return db.runTransaction(async (transaction) => {
    // Both webhook event families use the same PaymentIntent document. A
    // Firestore transaction makes the check-and-grant atomic, so concurrent
    // delivery and Stripe retries cannot extend the pass more than once.
    const [grantSnap, userSnap] = await Promise.all([
      transaction.get(grantRef),
      transaction.get(userRef),
    ]);
    if (grantSnap.exists) return false;

    const existing = userSnap.data()?.proUntil as Timestamp | undefined;
    const existingMs = existing?.toMillis() ?? null;
    const expiryMs = nextPassExpiryMillis(existingMs, now, durationHours);
    const proUntil = Timestamp.fromMillis(expiryMs);
    const grantedAt = Timestamp.fromMillis(now);

    transaction.set(
      userRef,
      { proUntil, passGrantedAt: grantedAt },
      { merge: true }
    );
    transaction.create(grantRef, {
      uid,
      paymentIntentId,
      durationHours,
      previousExpiry: existing ?? null,
      proUntil,
      grantedAt,
      sourceEventId,
    });
    return true;
  });
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

export async function customerHasActiveSubscription(
  stripe: Stripe,
  customerId: string
): Promise<boolean> {
  // Stripe is the authoritative source here. Looking only at the event that
  // happened to arrive is wrong when a customer has two subscriptions or
  // when webhook delivery is out of order. Query entitled states directly;
  // scanning the first 100 records with status="all" can miss an older active
  // subscription behind a large canceled history.
  for (const status of ["active", "trialing"] as const) {
    const subscriptions = await stripe.subscriptions.list({
      customer: customerId,
      status,
      limit: 1,
    });
    if (subscriptions.data.some((sub) =>
      isActiveStripeSubscriptionStatus(sub.status)
    )) {
      return true;
    }
  }
  return false;
}

export async function POST(req: NextRequest) {
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!process.env.STRIPE_SECRET_KEY || !webhookSecret) {
    return NextResponse.json(
      { error: "Stripe webhook not configured" },
      { status: 503 }
    );
  }
  const stripe = getStripe();

  let body: string;
  try {
    body = await readBodyText(req, 1024 * 1024);
  } catch (err) {
    if (err instanceof RequestBodyError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
  const sig = req.headers.get("stripe-signature");
  if (!sig) {
    return NextResponse.json({ error: "Missing signature" }, { status: 400 });
  }

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
        const customerId = stripeCustomerId(session.customer);
        // Branch on Checkout mode: subscriptions flip the persistent
        // `tier` field; one-time pass payments instead grant a
        // finite `proUntil` window without touching `tier`. This
        // keeps the two grant types independent so a user who buys
        // a 3-day pass while already subscribed (or vice versa)
        // doesn't get their access state corrupted on refund/cancel.
        if (session.mode === "subscription") {
          if (customerId) {
            const isActive = await customerHasActiveSubscription(stripe, customerId);
            await updateUserTier(uid, isActive ? "pro" : "free");
          } else {
            console.warn(
              "checkout.session.completed: subscription has no valid customer",
              { sessionId: session.id }
            );
          }
        } else if (session.mode === "payment") {
          const passType = session.metadata?.passType;
          const hours = passType ? PASS_DURATIONS_HOURS[passType] : undefined;
          const paymentIntentId = stripePaymentIntentId(session.payment_intent);
          if (hours && session.payment_status === "paid" && paymentIntentId) {
            await grantPassOnce(uid, hours, paymentIntentId, event.id);
          } else {
            console.warn(
              "checkout.session.completed: one-time pass not ready to grant",
              {
                passType,
                paymentStatus: session.payment_status,
                hasPaymentIntent: !!paymentIntentId,
                sessionId: session.id,
              }
            );
          }
        }

        // Mirror the Stripe customer ID for subscriptions so legacy
        // customer.subscription.* handlers below can find the user
        // doc by reverse lookup. One-time purchases may get a different
        // Customer and must never overwrite this subscription mapping.
        if (session.mode === "subscription" && customerId) {
          const db = getAdminDb();
          await db.doc(`users/${uid}`).set(
            { stripeCustomerId: customerId },
            { merge: true }
          );
        }
      }
      break;
    }

    case "payment_intent.succeeded": {
      // Belt-and-suspenders for the 3-day pass flow. Both this event and
      // checkout.session.completed can arrive, in either order, and Stripe
      // can retry either event. grantPassOnce keys both paths by the same
      // PaymentIntent and atomically ignores every replay after the first.
      // Subscription invoices also fire payment_intent.succeeded
      // events; we ignore those by requiring the metadata.passType
      // marker that only one-time pass Checkout sessions carry.
      const pi = event.data.object as Stripe.PaymentIntent;
      const uid = pi.metadata?.firebaseUid;
      const passType = pi.metadata?.passType;
      const hours = passType ? PASS_DURATIONS_HOURS[passType] : undefined;
      if (uid && hours) {
        await grantPassOnce(uid, hours, pi.id, event.id);
      }
      break;
    }

    case "customer.subscription.deleted":
    case "customer.subscription.updated": {
      const sub = event.data.object as Stripe.Subscription;
      // New Checkout Sessions put the Firebase uid directly on the
      // Subscription, so delivery order and multiple Stripe Customers cannot
      // disconnect cancellation from the correct account. Reverse lookup is
      // retained for subscriptions created before this metadata was added.
      const customerId = stripeCustomerId(sub.customer);
      const uid = sub.metadata?.firebaseUid
        || (customerId ? await findUidByStripeCustomer(customerId) : null);
      if (uid) {
        const isActive = customerId
          ? await customerHasActiveSubscription(stripe, customerId)
          : isActiveStripeSubscriptionStatus(sub.status);
        await updateUserTier(uid, isActive ? "pro" : "free");
      }
      break;
    }
  }

  return NextResponse.json({ received: true });
}
