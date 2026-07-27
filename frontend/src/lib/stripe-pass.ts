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

export interface StripePassGrantWindow {
  paymentIntentId: string;
  grantedAtMillis: number;
  previousExpiryMillis: number | null;
  proUntilMillis: number;
  revoked: boolean;
}

/** Remaining duration contributed by pass grants at `nowMillis`.
 *
 * A pass bought while another is active starts at the previous expiry. When
 * an earlier pass is refunded, later untouched passes move forward and keep
 * their full unused duration instead of being revoked accidentally. */
export function remainingPassEntitlementMillis(
  grants: readonly StripePassGrantWindow[],
  nowMillis: number
): number {
  return grants.reduce((total, grant) => {
    if (grant.revoked) return total;
    if (
      !Number.isFinite(grant.grantedAtMillis)
      || !Number.isFinite(grant.proUntilMillis)
      || grant.proUntilMillis <= nowMillis
    ) {
      return total;
    }

    const previous = grant.previousExpiryMillis;
    const startMillis = Math.max(
      grant.grantedAtMillis,
      previous != null && Number.isFinite(previous)
        ? previous
        : grant.grantedAtMillis
    );
    return total + Math.max(
      0,
      grant.proUntilMillis - Math.max(nowMillis, startMillis)
    );
  }, 0);
}

/** Recalculate a user's finite pass expiry after one confirmed refund.
 *
 * The result can only shorten (never extend) the current entitlement. Time
 * from unrelated/manual grants is preserved, as are unused durations from
 * other paid passes. */
export function passExpiryAfterRefundMillis(
  grants: readonly StripePassGrantWindow[],
  refundedPaymentIntentId: string,
  currentExpiryMillis: number | null,
  nowMillis: number
): number {
  const currentEndMillis = Math.max(nowMillis, currentExpiryMillis ?? nowMillis);
  const recordedBefore = remainingPassEntitlementMillis(grants, nowMillis);
  const recordedAfter = remainingPassEntitlementMillis(
    grants.filter((grant) => grant.paymentIntentId !== refundedPaymentIntentId),
    nowMillis
  );
  const currentRemaining = currentEndMillis - nowMillis;
  const untrackedRemaining = Math.max(0, currentRemaining - recordedBefore);
  const recalculatedEnd = nowMillis + untrackedRemaining + recordedAfter;
  return Math.min(currentEndMillis, recalculatedEnd);
}
