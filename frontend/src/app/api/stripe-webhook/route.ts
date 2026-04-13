import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: "2026-03-25.dahlia",
});

const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET!;

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
        await updateUserTier(uid, "pro");
        const db = getAdminDb();
        await db.doc(`users/${uid}`).set(
          { stripeCustomerId: session.customer as string },
          { merge: true }
        );
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
