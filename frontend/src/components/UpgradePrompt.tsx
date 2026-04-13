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
  const { user } = useAuth();

  async function handleUpgrade(plan: "monthly" | "annual") {
    setLoading(true);
    try {
      const res = await fetch(CHECKOUT_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan, uid: user?.uid, email: user?.email }),
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
          Upgrade — $4.99/mo
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
          Annual — $39.99/yr
          <span
            style={{
              display: "block",
              fontSize: "11px",
              fontWeight: 400,
              color: "rgba(167,139,250,0.6)",
              marginTop: "2px",
            }}
          >
            Save 33%
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
