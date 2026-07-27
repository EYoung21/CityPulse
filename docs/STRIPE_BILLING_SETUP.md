# Stripe Billing Setup (PhillyPulse)

This guide is specific to the current PhillyPulse codebase.

It covers:
- Stripe products/prices
- Vercel environment variables
- Webhook setup
- How customer tier updates happen in Firestore
- Test + production rollout checklist

---

## 1) How billing works in this project

Current flow in code:
- Frontend upgrade button calls `POST /api/create-checkout`
- API route creates a Stripe Checkout Session in `subscription` mode
- Stripe redirects user to hosted checkout
- Stripe webhook posts to `POST /api/stripe-webhook`
- Webhook updates Firestore user tier:
  - `pro` on successful checkout
  - `free` when subscription is canceled/inactive

Relevant files:
- `frontend/src/components/UpgradePrompt.tsx`
- `frontend/src/app/api/create-checkout/route.ts`
- `frontend/src/app/api/stripe-webhook/route.ts`
- `frontend/src/contexts/AuthContext.tsx` (reads `users/{uid}.tier`)

---

## 2) Create Stripe products and prices

In Stripe Dashboard:
1. Go to **Product catalog**.
2. Create one product (example: `CityPulse Pro`).
3. Add two recurring prices:
   - Monthly (example: `$4.99/month`)
   - Annual (example: `$39.99/year`)
4. Copy both **Price IDs** (`price_...`).

You will use these for:
- `STRIPE_PRICE_MONTHLY`
- `STRIPE_PRICE_ANNUAL`

---

## 3) Configure Vercel environment variables

Set these on the Vercel project(s) serving checkout:

- `STRIPE_SECRET_KEY` (starts with `sk_test_` or `sk_live_`)
- `STRIPE_PRICE_MONTHLY` (`price_...`)
- `STRIPE_PRICE_ANNUAL` (`price_...`)
- `STRIPE_WEBHOOK_SECRET` (from Stripe webhook endpoint, `whsec_...`)

Also ensure Firebase envs are already set for webhook writes:
- `NEXT_PUBLIC_FIREBASE_PROJECT_ID`
- `FIREBASE_ADMIN_KEY` (JSON string) **or** runtime credentials on host

Important for your multi-domain setup:
- Any domain/project that can start checkout should have the Stripe key + price vars.
- You can use **one webhook endpoint** (recommended) that writes to the shared Firestore project.

---

## 4) Create Stripe webhook endpoint

In Stripe Dashboard:
1. Go to **Developers -> Webhooks**.
2. Add endpoint:
   - Production example: `https://www.phlpulse.com/api/stripe-webhook`
   - Test/dev example: local tunnel URL (see section 6)
3. Subscribe to events:
   - `checkout.session.completed`
   - `payment_intent.succeeded`
   - `charge.refunded`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
4. Copy the webhook signing secret (`whsec_...`) into `STRIPE_WEBHOOK_SECRET`.

Notes:
- This route verifies Stripe signature; wrong secret will fail verification.
- Webhook updates:
  - `users/{uid}.tier`
  - `users/{uid}.stripeCustomerId`

---

## 5) Firestore data expectations

The webhook writes under:
- `users/{firebaseUid}`

Fields used:
- `tier`: `"free"` or `"pro"`
- `stripeCustomerId`: `"cus_..."`
- `tierUpdatedAt`: timestamp

The checkout route attaches user UID via session metadata:
- `metadata.firebaseUid`

If a user checks out while not authenticated, tier cannot be mapped correctly.
Recommendation: require logged-in users before showing paid upgrade CTA.

---

## 6) Local testing with Stripe CLI

From `frontend/`:

1. Run app:
```bash
npm run dev
```

2. In another terminal, forward Stripe events:
```bash
stripe listen --forward-to localhost:3000/api/stripe-webhook
```

3. Copy printed webhook secret into local env:
- `STRIPE_WEBHOOK_SECRET=whsec_...`

4. Use test secret key + test price IDs + Stripe test card:
- `4242 4242 4242 4242`

5. Confirm in Firestore that `users/{uid}.tier` becomes `pro` after checkout.

---

## 7) Production checklist

- [ ] Stripe product and both recurring prices created
- [ ] `STRIPE_SECRET_KEY` set (live) in Vercel
- [ ] `STRIPE_PRICE_MONTHLY` and `STRIPE_PRICE_ANNUAL` set in Vercel
- [ ] Webhook endpoint created and `STRIPE_WEBHOOK_SECRET` set in Vercel
- [ ] Webhook events include all five checkout, pass, refund, and subscription events
- [ ] Firestore user doc updates verified for a live test customer
- [ ] Successful redirect works (`/?upgraded=1`)
- [ ] Cancellation path tested (`customer.subscription.deleted`)

---

## 8) Operational notes

- If webhooks fail, Stripe will retry automatically; check Stripe webhook logs first.
- If users are charged but not upgraded, verify:
  - webhook delivery success
  - `firebaseUid` metadata exists on session
  - Firestore credentials (`FIREBASE_ADMIN_KEY`) are valid
- If you need self-serve cancellation/plan management, add Stripe Customer Portal next (not implemented yet in this repo).
