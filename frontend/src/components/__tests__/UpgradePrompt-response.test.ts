import { describe, expect, it } from "vitest";
import { normalizeCheckoutResponse } from "@/components/UpgradePrompt";

describe("checkout response validation", () => {
  it("allows only HTTPS Stripe checkout destinations", () => {
    expect(normalizeCheckoutResponse({ url: "https://checkout.stripe.com/c/pay/cs_test" }).url)
      .toBe("https://checkout.stripe.com/c/pay/cs_test");
    expect(normalizeCheckoutResponse({ url: "javascript:alert(1)" }).url).toBeNull();
    expect(normalizeCheckoutResponse({ url: "https://stripe.com.evil.example/checkout" }).url).toBeNull();
    expect(normalizeCheckoutResponse({ url: "http://checkout.stripe.com/session" }).url).toBeNull();
  });

  it("bounds server error text", () => {
    expect(normalizeCheckoutResponse({ error: `  ${"x".repeat(600)}  ` }).error).toHaveLength(500);
  });
});
