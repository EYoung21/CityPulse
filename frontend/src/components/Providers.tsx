"use client";

import { useState, useEffect, useRef } from "react";
import { usePathname, useRouter } from "next/navigation";
import { AuthProvider, useAuth } from "@/contexts/AuthContext";
import { isFirebaseConfigured } from "@/lib/firebase";
import { usePrefsSync } from "@/lib/prefs-sync";
import LoginScreen from "@/components/LoginScreen";
import AdminLauncher from "@/components/AdminLauncher";
import AdminPanel from "@/app/admin/AdminPanel";
import ModerationPanel from "@/app/admin/ModerationPanel";
import type { ReactNode } from "react";
import type { User } from "firebase/auth";

/** Exact paths that skip the auth gate entirely. Marketing / campaign URLs
 *  must be reachable from ads, decks, and partner email without a login wall. */
const PUBLIC_ROUTES = ["/landing", "/login", "/teams", "/use-cases"];

/** Path prefixes that skip the auth gate (for dynamic segments). */
const PUBLIC_ROUTE_PREFIXES = ["/use-cases/"];

type AdminMode = "launcher" | "dashboard" | "admin" | "moderation";

function readInitialAdminMode(): AdminMode {
  if (typeof window === "undefined") return "launcher";
  const saved = window.sessionStorage.getItem("pulse_admin_mode");
  return saved === "dashboard" || saved === "admin" || saved === "moderation"
    ? saved
    : "launcher";
}

function isPublicRoute(pathname: string): boolean {
  if (PUBLIC_ROUTES.includes(pathname)) return true;
  return PUBLIC_ROUTE_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

/** Signed-in but still on /login — must leave for the app (Google, email).
 *  Exceptions:
 *   - Anonymous guests reach /login specifically to UPGRADE to a real
 *     account, so they must stay on the form. ("Continue as guest" in
 *     LoginScreen navigates to the app itself.) Before auto-guest this
 *     returned true, but now that every visitor is a guest, bouncing them
 *     off /login would leave no way to create a real account.
 *   - Email/password users who have not verified yet stay on the
 *     verification panel inside LoginScreen. */
function shouldLeaveLoginForApp(user: User): boolean {
  if (user.isAnonymous) return false;
  if (!user.email) return true;
  return user.emailVerified;
}

function RedirectTo({ to }: { to: string }) {
  const router = useRouter();
  useEffect(() => {
    router.replace(to);
  }, [router, to]);
  return null;
}

/** Full-screen spinner shown while auth resolves or an auto-guest sign-in
 *  is in flight. */
function GateSpinner() {
  return (
    <div className="min-h-dvh flex items-center justify-center" style={{ background: "var(--map-bg, #0a0a14)" }}>
      <div className="w-8 h-8 border-2 border-blue-400/30 border-t-blue-400 rounded-full animate-spin" />
    </div>
  );
}

function AuthGate({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { user, loading, isAdmin, continueAsGuest } = useAuth();
  // Mirror the small allow-list of synced preferences (theme, units,
  // basemap, POI overlays, avoidance prefs, etc.) to/from Firestore so
  // they roam across the user's devices.
  usePrefsSync();
  const [adminMode, setAdminMode] = useState<AdminMode>(readInitialAdminMode);

  // ── Auto-guest ────────────────────────────────────────────────────
  // Rather than gate the whole app behind a login wall, drop signed-out
  // visitors straight onto the map as an anonymous guest. The core map
  // (incidents/extractions) is public-read, and every account-bound
  // feature (saving places, cross-device sync, alerts, keyword watches,
  // votes) is already gated on a *non-anonymous* account by the Firestore
  // rules — so a guest gets the full browse experience and is prompted to
  // sign in only when they reach for one of those features.
  //
  // Safety: only attempt on a GATED route, and only once auth has fully
  // resolved to "no user". Never on public routes (so /landing, /teams,
  // /use-cases, and — critically — the /login sign-up funnel stay
  // genuinely signed-out), and never while `loading` (which folds in the
  // cross-domain __pulse_token exchange and the session-restore window),
  // so we can't pre-empt a returning real/admin session or an in-flight
  // token sign-in. If anonymous auth is unavailable (provider disabled,
  // offline first load), we fall back to the manual LoginScreen below so
  // nobody is stranded on a spinner.
  const needsGuest =
    !loading && !user && isFirebaseConfigured() && !isPublicRoute(pathname);
  const [guestFailed, setGuestFailed] = useState(false);
  const guestingRef = useRef(false);
  useEffect(() => {
    if (!needsGuest) {
      // A user resolved, or we navigated to a public route: reset the
      // in-flight guard (a ref, not state) so a later sign-out re-enters
      // the auto-guest path cleanly. `guestFailed` is deliberately left
      // as-is — it's only read in the `!user` render branch below, so a
      // stale `true` is never observed once a real/guest user exists.
      guestingRef.current = false;
      return;
    }
    if (guestingRef.current) return;
    guestingRef.current = true;
    // Firebase can leave signInAnonymously pending indefinitely during a
    // partial outage. Give the gate a deadline so a visitor gets the manual
    // login fallback instead of an endless spinner.
    let active = true;
    const timeout = window.setTimeout(() => {
      if (active) setGuestFailed(true);
    }, 8000);
    continueAsGuest()
      .then(() => {
        window.clearTimeout(timeout);
        if (active) setGuestFailed(false);
      })
      .catch(() => {
        window.clearTimeout(timeout);
        if (active) setGuestFailed(true);
      });
    return () => {
      active = false;
      window.clearTimeout(timeout);
    };
  }, [needsGuest, continueAsGuest]);

  const changeAdminMode = (mode: AdminMode) => {
    setAdminMode(mode);
    if (mode === "launcher") {
      sessionStorage.removeItem("pulse_admin_mode");
    } else {
      sessionStorage.setItem("pulse_admin_mode", mode);
    }
  };

  // Skip auth for public routes (e.g. /landing, /teams, /use-cases/*).
  // These render the same content for signed-out visitors, signed-in users,
  // and admins — the product gate only kicks in once you deep-link into
  // the authenticated map or feed.
  if (isPublicRoute(pathname)) {
    // /login stays public, but Firebase sign-in (guest, Google, email) must
    // navigate into the app; otherwise anonymous auth succeeds with no UI change.
    if (pathname === "/login" && user && shouldLeaveLoginForApp(user)) {
      return <RedirectTo to="/" />;
    }
    return <>{children}</>;
  }

  if (!isFirebaseConfigured()) {
    return <>{children}</>;
  }

  if (loading) {
    return <GateSpinner />;
  }

  if (!user) {
    // Auto-guest (effect above) is signing the visitor in anonymously →
    // hold on the spinner until `user` resolves and the map renders. If
    // anonymous auth failed (provider disabled / offline), fall back to
    // the manual login screen so there's always a way in.
    return guestFailed ? <LoginScreen /> : <GateSpinner />;
  }

  if (isAdmin) {
    if (adminMode === "launcher") {
      return (
        <AdminLauncher
          onChoose={(mode) => changeAdminMode(mode)}
        />
      );
    }
    if (adminMode === "admin") {
      return <AdminPanel onBack={() => changeAdminMode("launcher")} />;
    }
    if (adminMode === "moderation") {
      return <ModerationPanel onBack={() => changeAdminMode("launcher")} />;
    }
  }

  return <>{children}</>;
}

export default function Providers({ children }: { children: ReactNode }) {
  return (
    <AuthProvider>
      <AuthGate>{children}</AuthGate>
    </AuthProvider>
  );
}
