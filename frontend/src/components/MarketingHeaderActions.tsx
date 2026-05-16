"use client";

import Link from "next/link";
import { useAuth } from "@/contexts/AuthContext";

/** Auth-aware right-side controls for the marketing shell.
 *  Replaces the historical static "Create Account / Sign In" CTA so a
 *  signed-in user landing on `/use-cases/*` or `/teams` from the app's
 *  in-product links isn't asked to create an account they already have. */
export default function MarketingHeaderActions() {
  const { user, loading, isPro } = useAuth();

  // Server render and first paint show the signed-out CTA so there's no
  // hydration mismatch; useAuth fills in once Firebase resolves.
  if (loading || !user || user.isAnonymous) {
    return (
      <Link href="/login" className="lp-header-cta">
        Create Account / Sign In
      </Link>
    );
  }

  const label = user.displayName?.trim() || user.email || "Account";
  const shortLabel = label.length > 22 ? label.slice(0, 20) + "…" : label;

  return (
    <div className="lp-header-account" aria-label={`Signed in as ${label}`}>
      <span className="lp-header-account-name">
        {shortLabel}
        {isPro && <span className="lp-header-account-tier">Pro</span>}
      </span>
      <Link href="/" className="lp-header-cta lp-header-cta--ghost">
        Open app
      </Link>
    </div>
  );
}
