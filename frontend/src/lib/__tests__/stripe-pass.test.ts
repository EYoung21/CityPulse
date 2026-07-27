import { describe, expect, it } from "vitest";
import {
  isActiveStripeSubscriptionStatus,
  nextPassExpiryMillis,
  passExpiryAfterRefundMillis,
  remainingPassEntitlementMillis,
  stripeCustomerId,
  stripePaymentIntentId,
  type StripePassGrantWindow,
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

  const hour = 60 * 60 * 1000;

  function grant(
    paymentIntentId: string,
    startHour: number,
    endHour: number,
    previousExpiryHour: number | null = null,
    revoked = false
  ): StripePassGrantWindow {
    return {
      paymentIntentId,
      grantedAtMillis: startHour * hour,
      previousExpiryMillis:
        previousExpiryHour == null ? null : previousExpiryHour * hour,
      proUntilMillis: endHour * hour,
      revoked,
    };
  }

  it("counts only unused pass time and preserves future stacked passes", () => {
    const grants = [
      grant("pi_first", 0, 72),
      grant("pi_second", 1, 144, 72),
      grant("pi_third", 2, 216, 144),
    ];

    expect(remainingPassEntitlementMillis(grants, 80 * hour)).toBe(136 * hour);
    expect(
      passExpiryAfterRefundMillis(grants, "pi_second", 216 * hour, 80 * hour)
    ).toBe(152 * hour);
  });

  it("revokes the only active pass immediately", () => {
    const grants = [grant("pi_only", 0, 72)];
    expect(
      passExpiryAfterRefundMillis(grants, "pi_only", 72 * hour, 24 * hour)
    ).toBe(24 * hour);
  });

  it("does not remove a newer pass when an already-consumed pass is refunded", () => {
    const grants = [
      grant("pi_old", 0, 72),
      grant("pi_new", 100, 172, 72),
    ];
    expect(
      passExpiryAfterRefundMillis(grants, "pi_old", 172 * hour, 120 * hour)
    ).toBe(172 * hour);
  });

  it("preserves entitlement time not represented by Stripe pass grants", () => {
    const grants = [grant("pi_only", 0, 72)];
    expect(
      passExpiryAfterRefundMillis(grants, "pi_only", 96 * hour, 24 * hour)
    ).toBe(48 * hour);
  });
});
