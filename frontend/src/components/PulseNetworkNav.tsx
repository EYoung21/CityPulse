"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { getAuth } from "firebase/auth";
import { PULSE_CITIES, getCurrentCity, type PulseCity } from "@/lib/pulse-cities";
import { useAuth } from "@/contexts/AuthContext";
import { getFirebaseApp, isFirebaseConfigured } from "@/lib/firebase";

/**
 * Pulse Network navigation dropdown.
 *
 * Renders a compact globe button in the header that opens a dropdown
 * listing all Pulse cities. The current city is highlighted; tapping
 * any other city navigates to that deployment's read-only view.
 *
 * Cross-city *reads* are free (matches Citizen, lowers acquisition
 * friction, makes the network effect actually visible). Cross-city
 * *writes* — saved places, push subs, user reports, custom alert
 * zones — remain gated to the user's home city or behind Pro on the
 * destination deployment, enforced at the relevant write endpoints
 * rather than at this navigation surface.
 */
export default function PulseNetworkNav() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const current = getCurrentCity();
  const { user } = useAuth();

  const navigateToCity = useCallback(async (city: PulseCity) => {
    // Preview-only cities don't have a real domain yet — view them by
    // overriding the slug on the current host via `?city=<slug>`.
    if (city.previewOnly) {
      const url = new URL(window.location.href);
      url.searchParams.set("city", city.slug);
      window.location.href = url.toString();
      return;
    }
    let url = `https://${city.domain}`;
    if (user && isFirebaseConfigured()) {
      try {
        const auth = getAuth(getFirebaseApp());
        const idToken = await auth.currentUser?.getIdToken();
        if (idToken) {
          url += `?__pulse_token=${encodeURIComponent(idToken)}`;
        }
      } catch { /* navigate without token */ }
    }
    window.location.href = url;
  }, [user]);

  // Close on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  return (
    <div ref={ref} style={{ position: "relative", display: "inline-block" }}>
      {/* Trigger button */}
      <button
        onClick={() => setOpen((o) => !o)}
        aria-label="Pulse Network · Switch cities"
        title="Pulse Network · Switch cities"
        style={{
          display: "flex",
          alignItems: "center",
          gap: "8px",
          padding: "8px 16px",
          border: "1px solid rgba(255,255,255,0.15)",
          borderRadius: "10px",
          background: "rgba(255,255,255,0.06)",
          color: "rgba(255,255,255,0.8)",
          cursor: "pointer",
          fontSize: "14px",
          fontWeight: 500,
          transition: "all 0.2s ease",
          backdropFilter: "blur(8px)",
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = "rgba(255,255,255,0.12)";
          e.currentTarget.style.borderColor = "rgba(255,255,255,0.25)";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = "rgba(255,255,255,0.06)";
          e.currentTarget.style.borderColor = "rgba(255,255,255,0.15)";
        }}
      >
        <span style={{ fontSize: "18px" }}>🌐</span>
        <span>Pulse Network</span>
        <span
          style={{
            fontSize: "11px",
            transition: "transform 0.2s ease",
            transform: open ? "rotate(180deg)" : "rotate(0deg)",
          }}
        >
          ▼
        </span>
      </button>

      {/* Dropdown */}
      {open && (
        <div
          style={{
            position: "absolute",
            top: "calc(100% + 6px)",
            right: 0,
            minWidth: "260px",
            background: "rgba(20, 20, 30, 0.95)",
            backdropFilter: "blur(20px)",
            border: "1px solid rgba(255,255,255,0.12)",
            borderRadius: "12px",
            boxShadow: "0 12px 40px rgba(0,0,0,0.5)",
            padding: "8px 0",
            zIndex: 9999,
            animation: "fadeSlideIn 0.15s ease",
          }}
        >
          <div
            style={{
              padding: "10px 16px 8px",
              fontSize: "11px",
              fontWeight: 600,
              textTransform: "uppercase",
              letterSpacing: "1px",
              color: "rgba(255,255,255,0.4)",
            }}
          >
            Live Cities
          </div>

          {PULSE_CITIES.filter((c) => !c.previewOnly).map((city) => (
            <CityRow
              key={city.slug}
              city={city}
              isCurrent={city.slug === current.slug}
              onNavigate={navigateToCity}
              onClose={() => setOpen(false)}
            />
          ))}



          <div
            style={{
              borderTop: "1px solid rgba(255,255,255,0.08)",
              margin: "6px 0",
            }}
          />
          <div
            style={{
              padding: "6px 14px 8px",
              fontSize: "11px",
              color: "rgba(255,255,255,0.3)",
              textAlign: "center",
            }}
          >
            Real-time safety • Unverified scanner audio
          </div>
        </div>
      )}

      <style>{`
        @keyframes fadeSlideIn {
          from { opacity: 0; transform: translateY(-4px); }
          to   { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>
  );
}

function CityRow({
  city,
  isCurrent,
  onNavigate,
  onClose,
}: {
  city: PulseCity;
  isCurrent: boolean;
  onNavigate: (city: PulseCity) => void;
  onClose: () => void;
}) {
  return (
    <a
      href={
        isCurrent
          ? "#"
          : city.previewOnly
            ? `?city=${encodeURIComponent(city.slug)}`
            : `https://${city.domain}`
      }
      onClick={(e) => {
        e.preventDefault();
        if (isCurrent) return;
        onClose();
        onNavigate(city);
      }}
      style={{
        display: "flex",
        alignItems: "center",
        gap: "10px",
        padding: "10px 16px",
        textDecoration: "none",
        color: isCurrent ? "#60a5fa" : "rgba(255,255,255,0.8)",
        fontSize: "15px",
        fontWeight: isCurrent ? 600 : 400,
        transition: "background 0.15s ease",
        cursor: isCurrent ? "default" : "pointer",
        background: isCurrent ? "rgba(96,165,250,0.08)" : "transparent",
        borderLeft: isCurrent ? "2px solid #60a5fa" : "2px solid transparent",
      }}
      onMouseEnter={(e) => {
        if (!isCurrent) e.currentTarget.style.background = "rgba(255,255,255,0.06)";
      }}
      onMouseLeave={(e) => {
        if (!isCurrent) e.currentTarget.style.background = "transparent";
      }}
    >
      <span style={{ fontSize: "18px", width: "24px", textAlign: "center" }}>
        {city.emoji}
      </span>
      <div style={{ flex: 1 }}>
        <div>{city.name}</div>
        <div
          style={{
            fontSize: "11px",
            color: "rgba(255,255,255,0.35)",
            marginTop: "1px",
          }}
        >
          {city.domain}
        </div>
      </div>
      {isCurrent && (
        <span
          style={{
            fontSize: "10px",
            padding: "2px 6px",
            borderRadius: "4px",
            background: "rgba(96,165,250,0.15)",
            color: "#60a5fa",
            fontWeight: 600,
          }}
        >
          LIVE
        </span>
      )}
      {!isCurrent && city.previewOnly && (
        <span
          style={{
            fontSize: "9px",
            padding: "2px 6px",
            borderRadius: "4px",
            background: "rgba(255,255,255,0.08)",
            color: "rgba(255,255,255,0.5)",
            fontWeight: 600,
            letterSpacing: "0.5px",
          }}
        >
          PREVIEW
        </span>
      )}
      {!isCurrent && !city.previewOnly && (
        <span style={{ fontSize: "12px", color: "rgba(255,255,255,0.25)" }}>↗</span>
      )}
    </a>
  );
}
