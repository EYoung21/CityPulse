"use client";

/**
 * CitySwitcher
 *
 * A pill next to the brand logo that opens a dropdown of all Pulse cities,
 * highlighting the current one and linking out to sister-city domains.
 *
 * If the visitor is authenticated, their Firebase ID token is appended to
 * the destination URL as `__pulse_token` so cross-domain SSO Just Works
 * (same pattern the in-app PulseNetworkNav uses).
 */

import { useEffect, useRef, useState } from "react";
import { getLaunchedCities, type PulseCity } from "@/lib/pulse-cities";
import { navigateToCity } from "@/lib/pulse-navigate";

export function CitySwitcher({ current }: { current: PulseCity }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onClickOutside(e: MouseEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    }
    function onEsc(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    addEventListener("mousedown", onClickOutside);
    addEventListener("keydown", onEsc);
    return () => {
      removeEventListener("mousedown", onClickOutside);
      removeEventListener("keydown", onEsc);
    };
  }, [open]);

  const handleClick = async (
    e: React.MouseEvent<HTMLAnchorElement>,
    city: PulseCity,
  ) => {
    const isCurrent = city.slug === current.slug;
    if (isCurrent) {
      e.preventDefault();
      setOpen(false);
      return;
    }
    e.preventDefault();
    setOpen(false);
    await navigateToCity(city);
  };

  return (
    <div className="lp-switcher" ref={rootRef}>
      <button
        className="lp-switcher-trigger"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="menu"
      >
        <span className="lp-switcher-emoji">{current.emoji}</span>
        <span className="lp-switcher-name">{current.brand}</span>
        <span className={`lp-switcher-caret ${open ? "open" : ""}`} aria-hidden>▾</span>
      </button>
      {open && (() => {
        const launched = getLaunchedCities();
        return (
        <div className="lp-switcher-menu" role="menu">
          <div className="lp-switcher-menu-label">Pulse Network</div>
          {launched.map((c) => {
            const isCurrent = c.slug === current.slug;
            return (
              <a
                key={c.slug}
                href={`https://${c.domain}`}
                className={`lp-switcher-item ${isCurrent ? "current" : ""}`}
                role="menuitem"
                onClick={(e) => handleClick(e, c)}
              >
                <span className="lp-switcher-item-emoji">{c.emoji}</span>
                <span className="lp-switcher-item-text">
                  <span className="lp-switcher-item-name">{c.brand}</span>
                  <span className="lp-switcher-item-domain">{c.domain}</span>
                </span>
                {isCurrent ? (
                  <span className="lp-switcher-item-here">You are here</span>
                ) : (
                  <span className="lp-switcher-item-go" aria-hidden>↗</span>
                )}
              </a>
            );
          })}
        </div>
        );
      })()}
    </div>
  );
}
