/**
 * pulse-navigate — shared helper for cross-city navigation.
 *
 * When an authenticated user moves to a different Pulse-network domain,
 * we append a one-shot Firebase ID token in the URL fragment. Fragments
 * stay in the browser and are not sent in HTTP request lines or referrer
 * headers. The destination's AuthContext consumes it on mount and signs
 * the user in without a round-trip to the login screen.
 *
 * Same pattern used by the in-app PulseNetworkNav; this helper lets the
 * landing-page surfaces (CitySwitcher, SisterCityCard, footer pills)
 * reuse it without duplicating logic.
 */

import { getAuth } from "firebase/auth";
import type { PulseCity } from "@/lib/pulse-cities";
import { getFirebaseApp, isFirebaseConfigured } from "@/lib/firebase";
import { attachPulseTokenFragment } from "@/lib/pulse-auth-handoff";

/** Build a `https://{domain}` URL with an attached ID token if possible. */
export async function buildCityUrl(city: PulseCity): Promise<string> {
  let url = `https://${city.domain}`;
  if (typeof window === "undefined" || !isFirebaseConfigured()) return url;
  try {
    const auth = getAuth(getFirebaseApp());
    const idToken = await auth.currentUser?.getIdToken();
    if (idToken) {
      url = attachPulseTokenFragment(url, idToken);
    }
  } catch {
    /* navigate without token on failure */
  }
  return url;
}

/** Hop to another city; passes auth token if available. */
export async function navigateToCity(city: PulseCity): Promise<void> {
  const url = await buildCityUrl(city);
  window.location.href = url;
}
