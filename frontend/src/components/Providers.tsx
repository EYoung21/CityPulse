"use client";

import { useState } from "react";
import { AuthProvider, useAuth } from "@/contexts/AuthContext";
import { isFirebaseConfigured } from "@/lib/firebase";
import { usePrefsSync } from "@/lib/prefs-sync";
import LoginScreen from "@/components/LoginScreen";
import AdminLauncher from "@/components/AdminLauncher";
import AdminPanel from "@/app/admin/AdminPanel";
import ModerationPanel from "@/app/admin/ModerationPanel";
import type { ReactNode } from "react";

function AuthGate({ children }: { children: ReactNode }) {
  const { user, loading, isAdmin } = useAuth();
  // Mirror the small allow-list of synced preferences (theme, units,
  // basemap, POI overlays, avoidance prefs, etc.) to/from Firestore so
  // they roam across the user's devices.
  usePrefsSync();
  const [adminMode, setAdminMode] = useState<"launcher" | "dashboard" | "admin" | "moderation" | null>(null);

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
