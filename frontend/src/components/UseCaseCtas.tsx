"use client";

/**
 * Client wrapper for marketing CTAs that need to react to auth state.
 *
 * Why this exists: campaign pages under `/use-cases/<slug>` are server-
 * rendered and statically generated, so the CTA list comes from a config
 * file with no awareness of who's looking. We still want to hide the
 * "Sign in" CTA for users who are already signed in — showing it to them
 * is noise at best and makes Pro users think they're not authenticated.
 *
 * Convention: any CTA whose `href` begins with `/login` is treated as the
 * sign-in entry point and is hidden once `useAuth().user` is populated.
 * If filtering would remove every CTA we still render an empty container
 * so layout doesn't shift.
 */

import Link from "next/link";
import type { CSSProperties } from "react";
import { useAuth } from "@/contexts/AuthContext";

export interface UseCaseCta {
  label: string;
  href: string;
}

interface Props {
  ctas: UseCaseCta[];
  className?: string;
  itemClassName?: string;
  containerStyle?: CSSProperties;
  itemStyle?: CSSProperties;
}

export default function UseCaseCtas({
  ctas,
  className,
  itemClassName = "lp-hero-cta",
  containerStyle,
  itemStyle,
}: Props) {
  const { user, loading } = useAuth();
  // While auth is still resolving, show the full list — flashing the
  // sign-in button briefly is preferable to flashing it back in once the
  // signed-in user finishes loading. The opposite (showing nothing) is
  // worse for first paint on slow connections.
  //
  // Anonymous guests count as signed-OUT here: with auto-guest entry
  // every visitor is a guest, so treating a guest as "signed in" would
  // strip the "Sign in / Create account" CTA from every marketing page
  // and kill the sign-up funnel. Only a real account hides the CTA.
  const signedIn = !!user && !user.isAnonymous;
  const visible =
    !loading && signedIn
      ? ctas.filter((c) => !c.href.startsWith("/login"))
      : ctas;

  return (
    <div className={className} style={containerStyle}>
      {visible.map((cta) => (
        <Link
          key={cta.href + cta.label}
          href={cta.href}
          className={itemClassName}
          style={itemStyle}
        >
          {cta.label}
        </Link>
      ))}
    </div>
  );
}
