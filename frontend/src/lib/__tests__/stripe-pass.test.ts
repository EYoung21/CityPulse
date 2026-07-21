import { describe, expect, it } from "vitest";
import {
  isActiveStripeSubscriptionStatus,
  nextPassExpiryMillis,
  stripeCustomerId,
  stripePaymentIntentId,
} from "@/lib/stripe-pass";

describe("Stripe one-time pass grants", () => {
  it("uses the same idempotency key for string and expanded PaymentIntents", () => {
    expect(stripePaymentIntentId("pi_citypulse123")).toBe("pi_citypulse123");
    expect(stripePaymentIntentId({ id: "pi_citypulse123" })).toBe("pi_citypulse123");
  });

  it("rejects missing or path-like IDs", () => {
    expect(stripePaymentIntentId(null)).toBeNull();
    expect(stripePaymentIntentId({ id: "pi_bad/path" })).toBeNull();
    expect(stripePaymentIntentId("checkout_session_123")).toBeNull();
  });

  it("normalizes string and expanded Stripe customer relationships", () => {
    expect(stripeCustomerId("cus_citypulse123")).toBe("cus_citypulse123");
    expect(stripeCustomerId({ id: "cus_citypulse123" })).toBe("cus_citypulse123");
    expect(stripeCustomerId({ id: "cus_bad/path" })).toBeNull();
  });

  it("starts an expired pass from now and stacks a separate future pass", () => {
    const hour = 60 * 60 * 1000;
    expect(nextPassExpiryMillis(900, 1_000, 72)).toBe(1_000 + 72 * hour);
    expect(nextPassExpiryMillis(1_000 + 10 * hour, 1_000, 72)).toBe(
      1_000 + 82 * hour
    );
  });

  it("recognizes only currently entitled subscription states", () => {
    expect(isActiveStripeSubscriptionStatus("active")).toBe(true);
    expect(isActiveStripeSubscriptionStatus("trialing")).toBe(true);
    expect(isActiveStripeSubscriptionStatus("past_due")).toBe(false);
    expect(isActiveStripeSubscriptionStatus("canceled")).toBe(false);
  });
});
