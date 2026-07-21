import type Stripe from "stripe";
import { describe, expect, it, vi } from "vitest";
import { customerHasActiveSubscription } from "@/app/api/stripe-webhook/route";

describe("Stripe subscription entitlement lookup", () => {
  it("queries current entitled states instead of a capped all-status history", async () => {
    const list = vi.fn()
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValueOnce({ data: [{ status: "trialing" }] });
    const stripe = { subscriptions: { list } } as unknown as Stripe;

    await expect(customerHasActiveSubscription(stripe, "cus_citypulse123"))
      .resolves.toBe(true);
    expect(list).toHaveBeenNthCalledWith(1, {
      customer: "cus_citypulse123",
      status: "active",
      limit: 1,
    });
    expect(list).toHaveBeenNthCalledWith(2, {
      customer: "cus_citypulse123",
      status: "trialing",
      limit: 1,
    });
  });

  it("returns false when Stripe has no active or trialing subscriptions", async () => {
    const list = vi.fn().mockResolvedValue({ data: [] });
    const stripe = { subscriptions: { list } } as unknown as Stripe;

    await expect(customerHasActiveSubscription(stripe, "cus_citypulse123"))
      .resolves.toBe(false);
    expect(list).toHaveBeenCalledTimes(2);
  });
});
