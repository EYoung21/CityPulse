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

/** Exact paths that skip the auth gate entirely. Marketing / campaign URLs
 *  must be reachable from ads, decks, and partner email without a login wall. */
const PUBLIC_ROUTES = ["/landing", "/login", "/teams", "/use-cases"];

/** Path prefixes that skip the auth gate (for dynamic segments). */
const PUBLIC_ROUTE_PREFIXES = ["/use-cases/"];

function isPublicRoute(pathname: string): boolean {
  if (PUBLIC_ROUTES.includes(pathname)) return true;
  return PUBLIC_ROUTE_PREFIXES.some((prefix) => pathname.startsWith(prefix));
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

  // Skip auth for public routes (e.g. /landing, /teams, /use-cases/*).
  // These render the same content for signed-out visitors, signed-in users,
  // and admins — the product gate only kicks in once you deep-link into
  // the authenticated map or feed.
  if (isPublicRoute(pathname)) {
    return <>{children}</>;
  }

  if (!isFirebaseConfigured()) {
    return <>{children}</>;
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: "var(--map-bg, #0a0a14)" }}>
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
    if (!adminMode || adminMode === "launcher") {
      return (
        <AdminLauncher
          onChoose={(mode) => setAdminMode(mode)}
        />
      );
    }
    if (adminMode === "admin") {
      return <AdminPanel onBack={() => setAdminMode("launcher")} />;
    }
    if (adminMode === "moderation") {
      return <ModerationPanel onBack={() => setAdminMode("launcher")} />;
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
