"use client";

import {
  useState,
  useRef,
  useEffect,
  useCallback,
  useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";
import { getAuth } from "firebase/auth";
import { PULSE_CITIES, getCurrentCity, type PulseCity } from "@/lib/pulse-cities";
import { useAuth } from "@/contexts/AuthContext";
import { getFirebaseApp, isFirebaseConfigured } from "@/lib/firebase";
import { MOBILE_NAV_HEIGHT_PX } from "@/components/MobileBottomNav";

const MOBILE_LAYOUT_QUERY = "(max-width: 767px)";
/** Above the MobileBottomNav portal. Scrim uses the overlay layer just
 *  below so a stray tap on the scrim doesn't fight the menu it sits under. */
const MOBILE_MENU_Z = "var(--pp-z-mobile-menu)";
const MOBILE_SCRIM_Z = "var(--pp-z-mobile-overlay)";

function subscribeMobileLayout(onStoreChange: () => void) {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return () => {};
  }
  const mql = window.matchMedia(MOBILE_LAYOUT_QUERY);
  if (typeof mql.addEventListener === "function") {
    mql.addEventListener("change", onStoreChange);
    return () => mql.removeEventListener("change", onStoreChange);
  }
  if (typeof mql.addListener === "function") {
    mql.addListener(onStoreChange);
    return () => mql.removeListener(onStoreChange);
  }
  return () => {};
}

function getMobileLayoutSnapshot() {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia(MOBILE_LAYOUT_QUERY).matches
  );
}

function getServerMobileLayoutSnapshot() {
  return false;
}

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
  const [mounted, setMounted] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const current = getCurrentCity();
  const { user } = useAuth();

  const isMobile = useSyncExternalStore(
    subscribeMobileLayout,
    getMobileLayoutSnapshot,
    getServerMobileLayoutSnapshot
  );

  useEffect(() => {
    setMounted(true);
  }, []);

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

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  // Close on outside click (mobile menu is portaled — include panel ref)
  useEffect(() => {
    if (!open) return;
    function handlePointerDown(e: PointerEvent) {
      const t = e.target as Node;
      if (ref.current?.contains(t)) return;
      if (panelRef.current?.contains(t)) return;
      setOpen(false);
    }
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [open]);

  // Anchor the mobile sheet above the bottom nav AND the 2-row filter
  // strip that sits above the nav on the map page. `--pp-mobile-bottom-rail`
  // is the shared baseline used by `.pp-bottom-controls` so the sheet
  // and the trigger button stay vertically aligned as a unit.
  const navLift = `calc(${MOBILE_NAV_HEIGHT_PX}px + env(safe-area-inset-bottom, 0px))`;
  const mobileSheetBottom = `var(--pp-mobile-bottom-rail, calc(${navLift} + 0.75rem))`;

  const menuChrome = {
    background: "rgba(20, 20, 30, 0.95)",
    backdropFilter: "blur(20px)",
    border: "1px solid rgba(255,255,255,0.12)",
    borderRadius: "12px",
    boxShadow: "0 12px 40px rgba(0,0,0,0.5)",
    padding: "8px 0",
  } as const;

  const mobileSheet =
    mounted && open && isMobile ? (
      createPortal(
        <>
          <div
            role="presentation"
            style={{
              position: "fixed",
              inset: 0,
              zIndex: MOBILE_SCRIM_Z,
              background: "var(--pp-overlay-medium)",
            }}
            onPointerDown={() => setOpen(false)}
          />
          <div
            ref={panelRef}
            data-pulse-network-panel
            role="dialog"
            aria-label="Pulse Network · Live cities"
            style={{
              position: "fixed",
              left: 12,
              right: 12,
              bottom: mobileSheetBottom,
              maxHeight: `min(72dvh, calc(100dvh - env(safe-area-inset-top, 0px) - ${MOBILE_NAV_HEIGHT_PX}px - env(safe-area-inset-bottom, 0px) - 40px))`,
              zIndex: MOBILE_MENU_Z,
              overflow: "hidden",
              display: "flex",
              flexDirection: "column",
              animation: "fadeSlideIn 0.15s ease",
              ...menuChrome,
            }}
          >
            <div
              style={{
                flexShrink: 0,
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "8px 12px 6px 16px",
                borderBottom: "1px solid rgba(255,255,255,0.08)",
              }}
            >
              <span
                style={{
                  fontSize: "11px",
                  fontWeight: 600,
                  textTransform: "uppercase",
                  letterSpacing: "1px",
                  color: "rgba(255,255,255,0.4)",
                }}
              >
                Live Cities
              </span>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close"
                style={{
                  padding: "6px 10px",
                  borderRadius: 8,
                  border: "1px solid rgba(255,255,255,0.12)",
                  background: "rgba(255,255,255,0.06)",
                  color: "rgba(255,255,255,0.75)",
                  fontSize: 12,
                  cursor: "pointer",
                }}
              >
                Close
              </button>
            </div>
            <div style={{ overflowY: "auto", flex: 1, minHeight: 0, paddingBottom: 4 }}>
              {PULSE_CITIES.filter((c) => !c.previewOnly).map((city) => (
                <CityRow
                  key={city.slug}
                  city={city}
                  isCurrent={city.slug === current.slug}
                  onNavigate={navigateToCity}
                  onClose={() => setOpen(false)}
                />
              ))}
            </div>
            <div
              style={{
                flexShrink: 0,
                borderTop: "1px solid rgba(255,255,255,0.08)",
                marginTop: 4,
                padding: "6px 14px 8px",
                fontSize: "11px",
                color: "rgba(255,255,255,0.3)",
                textAlign: "center",
              }}
            >
              Real-time safety • Unverified scanner audio
            </div>
          </div>
        </>,
        document.body
      )
    ) : null;

  // Trigger spacing/padding tightens on mobile via CSS-class media query
  // rather than JS `isMobile` checks — useSyncExternalStore returns the
  // server snapshot (desktop) on the first render, so a JS-driven width
  // would flicker from wide → narrow on hydration. The label text
  // ("Pulse Network") is hidden with the same `.pp-pulse-net-label` rule.
  const triggerBase = {
    display: "flex" as const,
    alignItems: "center" as const,
    border: "1px solid rgba(255,255,255,0.15)",
    borderRadius: "10px",
    background: "rgba(255,255,255,0.06)",
    color: "rgba(255,255,255,0.8)",
    cursor: "pointer",
    fontSize: "14px",
    fontWeight: 500,
    transition: "all 0.2s ease",
    backdropFilter: "blur(8px)",
  };

  // Hide entirely on mobile. The map's right tool-rail was getting
  // crowded (6-8 buttons) and city-switching is a once-a-session action
  // for power users — it's still reachable from the desktop top-right
  // and the landing-page CitySwitcher. Keeping it off the mobile rail
  // is the single biggest declutter we can make without losing real
  // functionality. (Returning null after all hooks have run, per
  // Rules of Hooks; `mounted` prevents an SSR/hydration flip.)
  if (mounted && isMobile) return null;

  return (
    <div ref={ref} style={{ position: "relative", display: "inline-block" }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label="Pulse Network · Switch cities"
        title="Pulse Network · Switch cities"
        className="pp-pulse-net-trigger"
        style={triggerBase}
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
        <span className="pp-pulse-net-label">Pulse Network</span>
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

      {open && !isMobile && (
        <div
          style={{
            position: "absolute",
            top: "calc(100% + 6px)",
            right: 0,
            minWidth: "260px",
            zIndex: 9999,
            animation: "fadeSlideIn 0.15s ease",
            ...menuChrome,
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

      {mobileSheet}

      <style>{`
        @keyframes fadeSlideIn {
          from { opacity: 0; transform: translateY(-4px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        .pp-pulse-net-trigger { gap: 8px; padding: 8px 16px; }
        .pp-pulse-net-label { display: inline; }
        @media (max-width: 767px) {
          .pp-pulse-net-trigger { gap: 4px; padding: 8px 10px; }
          .pp-pulse-net-label { display: none; }
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
