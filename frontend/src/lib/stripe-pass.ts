/** Stripe sometimes returns an expandable relationship as an ID string and
 * sometimes as an expanded object. Normalize both shapes before using the ID
 * as the durable idempotency key for a one-time pass grant. */
export function stripePaymentIntentId(value: unknown): string | null {
  const candidate =
    typeof value === "string"
      ? value
      : value && typeof value === "object" && "id" in value
        ? (value as { id?: unknown }).id
        : null;

  if (typeof candidate !== "string") return null;
  const id = candidate.trim();

  // Stripe PaymentIntent IDs are safe Firestore document IDs. Keeping the
  // validation narrow also prevents unexpected metadata from changing the
  // billing-grant document path.
  return /^pi_[A-Za-z0-9_]+$/.test(id) ? id : null;
}

/** Normalize Stripe's expandable Customer relationship without ever storing an
 * expanded customer object in Firestore where string reverse lookups fail. */
export function stripeCustomerId(value: unknown): string | null {
  const candidate =
    typeof value === "string"
      ? value
      : value && typeof value === "object" && "id" in value
        ? (value as { id?: unknown }).id
        : null;
  if (typeof candidate !== "string") return null;
  const id = candidate.trim();
  return /^cus_[A-Za-z0-9_]+$/.test(id) ? id : null;
}

export function isActiveStripeSubscriptionStatus(status: unknown): boolean {
  return status === "active" || status === "trialing";
}

/** Calculate the next expiry for a genuinely new pass purchase. Existing
 * future time is preserved so separate purchases stack; replay protection is
 * provided transactionally by the caller's PaymentIntent grant record. */
export function nextPassExpiryMillis(
  existingExpiryMillis: number | null,
  nowMillis: number,
  durationHours: number
): number {
  const base =
    existingExpiryMillis != null && existingExpiryMillis > nowMillis
      ? existingExpiryMillis
      : nowMillis;
  return base + durationHours * 60 * 60 * 1000;
}
