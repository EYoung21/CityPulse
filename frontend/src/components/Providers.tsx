"use client";

import { useState, useEffect } from "react";
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

function isPublicRoute(pathname: string): boolean {
  if (PUBLIC_ROUTES.includes(pathname)) return true;
  return PUBLIC_ROUTE_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

/** Signed-in but still on /login — must leave for the app (guest, Google, email).
 *  Exception: email/password users who have not verified yet stay on the
 *  verification panel inside LoginScreen. */
function shouldLeaveLoginForApp(user: User): boolean {
  if (user.isAnonymous) return true;
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

function AuthGate({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { user, loading, isAdmin } = useAuth();
  // Mirror the small allow-list of synced preferences (theme, units,
  // basemap, POI overlays, avoidance prefs, etc.) to/from Firestore so
  // they roam across the user's devices.
  usePrefsSync();
  const [adminMode, setAdminMode] = useState<"launcher" | "dashboard" | "admin" | "moderation" | null>(null);
  const [adminModeInitialized, setAdminModeInitialized] = useState(false);

  useEffect(() => {
    if (!isAdmin) {
      setAdminModeInitialized(true);
      return;
    }
    const saved = sessionStorage.getItem("pulse_admin_mode");
    if (saved) {
      setAdminMode(saved as any);
    }
    setAdminModeInitialized(true);
  }, [isAdmin]);

  const changeAdminMode = (mode: "launcher" | "dashboard" | "admin" | "moderation") => {
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
    return (
      <div className="min-h-dvh flex items-center justify-center" style={{ background: "var(--map-bg, #0a0a14)" }}>
        <div className="w-8 h-8 border-2 border-blue-400/30 border-t-blue-400 rounded-full animate-spin" />
      </div>
    );
  }

  if (!user) {
    if (pathname === "/") {
      return <RedirectTo to="/landing" />;
    }
    return <LoginScreen />;
  }

  if (isAdmin) {
    if (!adminModeInitialized) return null;

    if (!adminMode || adminMode === "launcher") {
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
