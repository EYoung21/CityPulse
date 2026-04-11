"use client";

import { useAuth } from "@/contexts/AuthContext";
import { isFirebaseConfigured } from "@/lib/firebase";
import { Button } from "@/components/ui/button";
import { LogIn, LogOut, UserCircle } from "lucide-react";

export default function AuthBar() {
  const { user, loading, signInWithGoogle, signInAsGuest, signOutUser } =
    useAuth();

  if (!isFirebaseConfigured()) {
    return null;
  }

  if (loading) {
    return (
      <span className="text-xs text-muted-foreground px-2">…</span>
    );
  }

  if (user) {
    const label = user.isAnonymous
      ? "Guest"
      : user.displayName || user.email || "Signed in";
    return (
      <div className="flex items-center gap-2 bg-card/90 backdrop-blur-sm rounded-lg px-2 py-1.5 border border-border/50">
        <UserCircle className="w-4 h-4 shrink-0 text-muted-foreground" />
        <span className="text-xs max-w-[140px] truncate" title={label}>
          {label}
        </span>
        {user.isAnonymous && (
          <span className="text-[10px] text-muted-foreground hidden sm:inline">
            No saved history
          </span>
        )}
        <Button
          size="sm"
          variant="ghost"
          className="h-7 px-2"
          onClick={() => void signOutUser()}
        >
          <LogOut className="w-3.5 h-3.5" />
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-1 bg-card/90 backdrop-blur-sm rounded-lg px-2 py-1 border border-border/50">
      <Button
        size="sm"
        variant="secondary"
        className="h-7 text-xs"
        onClick={() => void signInWithGoogle().catch(console.error)}
      >
        <LogIn className="w-3.5 h-3.5 mr-1" />
        Google
      </Button>
      <Button
        size="sm"
        variant="ghost"
        className="h-7 text-xs"
        onClick={() => void signInAsGuest().catch(console.error)}
      >
        Guest
      </Button>
    </div>
  );
}
