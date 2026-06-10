"use client";

import { Lock, Zap, X } from "lucide-react";
import { useState } from "react";
import { useAuth } from "@/contexts/AuthContext";

const CHECKOUT_URL = "/api/create-checkout";

interface UpgradePromptProps {
  feature: string;
  description?: string;
  inline?: boolean;
  onClose?: () => void;
}

export default function UpgradePrompt({ feature, description, inline, onClose }: UpgradePromptProps) {
  const [loading, setLoading] = useState(false);
  const { user, signInWithGoogle } = useAuth();

  async function handleUpgrade(plan: "monthly" | "annual" | "3day") {
    // Checkout now requires a verified Firebase ID token (the server
    // derives firebaseUid from it and ignores any client-supplied uid).
    // Anonymous/signed-out users can't get a real token, so route them
    // through sign-in first; they re-tap upgrade once auth settles.
    if (!user || user.isAnonymous) {
      try {
        await signInWithGoogle();
      } catch {
        // Popup cancel is silent; other failures set lastAuthError in context.
      }
      return;
    }
    setLoading(true);
    try {
      const idToken = await user.getIdToken();
      const res = await fetch(CHECKOUT_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${idToken}`,
        },
        body: JSON.stringify({ plan }),
      });
      const data = await res.json();
      if (data.url) {
        window.location.href = data.url;
      }
    } catch {
      console.error("Failed to create checkout session");
    } finally {
      setLoading(false);
    }
  }

  if (inline) {
    return (
      <button
        onClick={() => handleUpgrade("monthly")}
        disabled={loading}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: "4px",
          padding: "2px 8px",
          fontSize: "10px",
          fontWeight: 600,
          borderRadius: "4px",
          background: "rgba(139,92,246,0.15)",
          color: "#a78bfa",
          border: "1px solid rgba(139,92,246,0.25)",
          cursor: "pointer",
          transition: "all 0.15s ease",
        }}
      >
        <Lock size={10} />
        PRO
      </button>
    );
  }

  return (
    <div
      style={{
        position: "relative",
        background: "rgba(20, 20, 35, 0.95)",
        backdropFilter: "blur(20px)",
        border: "1px solid rgba(139,92,246,0.2)",
        borderRadius: "16px",
        padding: "28px 24px",
        maxWidth: "360px",
        width: "100%",
        boxShadow: "0 12px 40px rgba(0,0,0,0.4)",
      }}
    >
      {onClose && (
        <button
          onClick={onClose}
          style={{
            position: "absolute",
            top: "12px",
            right: "12px",
            background: "none",
            border: "none",
            color: "rgba(255,255,255,0.4)",
            cursor: "pointer",
            padding: "4px",
          }}
        >
          <X size={16} />
        </button>
      )}

      <div style={{ textAlign: "center", marginBottom: "20px" }}>
        <div
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: "48px",
            height: "48px",
            borderRadius: "12px",
            background: "rgba(139,92,246,0.15)",
            marginBottom: "12px",
          }}
        >
          <Zap size={24} style={{ color: "#a78bfa" }} />
        </div>
        <h3
          style={{
            fontSize: "18px",
            fontWeight: 700,
            color: "white",
            marginBottom: "6px",
          }}
        >
          Unlock {feature}
        </h3>
        {description && (
          <p style={{ fontSize: "13px", color: "rgba(255,255,255,0.5)", lineHeight: 1.5 }}>
            {description}
          </p>
        )}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
        <button
          onClick={() => handleUpgrade("monthly")}
          disabled={loading}
          style={{
            padding: "12px",
            borderRadius: "10px",
            border: "1px solid rgba(139,92,246,0.3)",
            background: "linear-gradient(135deg, #7c3aed, #6d28d9)",
            color: "white",
            fontSize: "14px",
            fontWeight: 600,
            cursor: loading ? "wait" : "pointer",
            transition: "all 0.2s ease",
            opacity: loading ? 0.6 : 1,
          }}
        >
          Upgrade — $7.99/mo
        </button>
        <button
          onClick={() => handleUpgrade("annual")}
          disabled={loading}
          style={{
            padding: "12px",
            borderRadius: "10px",
            border: "1px solid rgba(139,92,246,0.15)",
            background: "rgba(139,92,246,0.08)",
            color: "#a78bfa",
            fontSize: "14px",
            fontWeight: 600,
            cursor: loading ? "wait" : "pointer",
            transition: "all 0.2s ease",
            opacity: loading ? 0.6 : 1,
          }}
        >
          Annual — $59.99/yr
          <span
            style={{
              display: "block",
              fontSize: "11px",
              fontWeight: 400,
              color: "rgba(167,139,250,0.6)",
              marginTop: "2px",
            }}
          >
            Save 37%
          </span>
        </button>

        {/* Lower-commitment one-time pass for tourists / event-night
         *  buyers / try-before-you-subscribe users. Visually muted vs
         *  the monthly+annual stack so it reads as a secondary path,
         *  not the headline offer — but still discoverable enough to
         *  capture revenue from anyone who would otherwise bounce on
         *  the subscription ask. The "no auto-renew" subtitle is the
         *  single most important UX detail here: subscription regret
         *  is the #1 reason people don't tap upgrade modals, and a
         *  one-time pass with that promise neutralizes that fear. */}
        <button
          onClick={() => handleUpgrade("3day")}
          disabled={loading}
          style={{
            padding: "10px",
            marginTop: "4px",
            borderRadius: "10px",
            border: "1px dashed rgba(255,255,255,0.12)",
            background: "transparent",
            color: "rgba(255,255,255,0.7)",
            fontSize: "13px",
            fontWeight: 500,
            cursor: loading ? "wait" : "pointer",
            transition: "all 0.2s ease",
            opacity: loading ? 0.6 : 1,
          }}
        >
          Just visiting? 3-Day Pass — $5.99
          <span
            style={{
              display: "block",
              fontSize: "10px",
              fontWeight: 400,
              color: "rgba(255,255,255,0.4)",
              marginTop: "2px",
            }}
          >
            One-time charge · no auto-renew
          </span>
        </button>
      </div>
    </div>
  );
}

export function ProBadge() {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "3px",
        padding: "1px 6px",
        fontSize: "9px",
        fontWeight: 700,
        borderRadius: "3px",
        background: "rgba(139,92,246,0.2)",
        color: "#a78bfa",
        letterSpacing: "0.5px",
        verticalAlign: "middle",
      }}
    >
      <Lock size={8} />
      PRO
    </span>
  );
}
