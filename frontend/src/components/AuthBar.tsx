"use client";

import { useAuth } from "@/contexts/AuthContext";
import { isFirebaseConfigured } from "@/lib/firebase";
import { LogOut, UserCircle } from "lucide-react";

export default function AuthBar() {
  const { user, loading, signOutUser } = useAuth();

  if (!isFirebaseConfigured() || loading || !user) {
    return null;
  }

  const label = user.isAnonymous
    ? "Guest"
    : user.displayName || user.email || "Signed in";

  return (
    <div
      className="flex items-center gap-2 rounded-lg px-2.5 py-1.5 backdrop-blur-md shadow-lg"
      style={{
        background: "var(--pill-bg, rgba(255,255,255,0.08))",
        border: "1px solid var(--pill-border, rgba(255,255,255,0.1))",
      }}
    >
      {user.photoURL ? (
        <img
          src={user.photoURL}
          alt=""
          className="w-5 h-5 rounded-full"
          referrerPolicy="no-referrer"
        />
      ) : (
        <UserCircle className="w-4 h-4 shrink-0" style={{ color: "var(--panel-text-muted)" }} />
      )}
      <span
        className="text-xs max-w-[120px] truncate hidden sm:inline"
        style={{ color: "var(--pill-text, #ccc)" }}
        title={label}
      >
        {label}
      </span>
      <button
        onClick={() => void signOutUser()}
        className="p-1 rounded transition-colors hover:bg-white/10"
        style={{ color: "var(--panel-text-muted)" }}
        title="Sign out"
      >
        <LogOut className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}
