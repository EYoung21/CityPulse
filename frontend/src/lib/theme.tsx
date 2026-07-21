"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { setColorBlindMode } from "./severity";
import { setPref } from "./prefs-sync";

type ThemeMode = "auto" | "light" | "dark";
type ResolvedTheme = "light" | "dark";

interface ThemeContextValue {
  mode: ThemeMode;
  resolved: ResolvedTheme;
  setMode: (m: ThemeMode) => void;
  /** Color-blind-safe palette opt-in (IBM-derived). Mirrors the regular
   *  severity map so consumers don't need to special case anything. */
  colorBlindSafe: boolean;
  setColorBlindSafe: (on: boolean) => void;
}

const ThemeContext = createContext<ThemeContextValue>({
  mode: "auto",
  resolved: "dark",
  setMode: () => {},
  colorBlindSafe: false,
  setColorBlindSafe: () => {},
});

function resolveAuto(): ResolvedTheme {
  const hour = new Date().getHours();
  return hour >= 6 && hour < 18 ? "light" : "dark";
}

const STORAGE_KEY = "phlpulse-theme";
const CB_STORAGE_KEY = "phlpulse-cb-palette";

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>("auto");
  const [resolved, setResolved] = useState<ResolvedTheme>("dark");
  const [colorBlindSafe, setColorBlindSafeState] = useState<boolean>(false);

  useEffect(() => {
    const hydrateTimer = window.setTimeout(() => {
      const saved = localStorage.getItem(STORAGE_KEY) as ThemeMode | null;
      if (saved && ["auto", "light", "dark"].includes(saved)) {
        setModeState(saved);
      }
      const cb = localStorage.getItem(CB_STORAGE_KEY) === "1";
      if (cb) {
        setColorBlindSafeState(true);
        setColorBlindMode(true);
      }
    }, 0);
    return () => window.clearTimeout(hydrateTimer);
  }, []);

  useEffect(() => {
    const updateResolvedTheme = () => {
      const next = mode === "auto" ? resolveAuto() : mode;
      setResolved(next);
      const html = document.documentElement;
      html.classList.toggle("dark", next === "dark");
      html.classList.toggle("light", next === "light");
    };
    const updateTimer = window.setTimeout(updateResolvedTheme, 0);
    const interval = mode === "auto"
      ? window.setInterval(updateResolvedTheme, 60_000)
      : null;
    return () => {
      window.clearTimeout(updateTimer);
      if (interval != null) window.clearInterval(interval);
    };
  }, [mode]);

  const setMode = useCallback((m: ThemeMode) => {
    setModeState(m);
    // Route through prefs-sync so this preference round-trips to
    // Firestore for signed-in users.
    setPref("phlpulse-theme", m);
  }, []);

  const setColorBlindSafe = useCallback((on: boolean) => {
    setColorBlindSafeState(on);
    setColorBlindMode(on);
    try { setPref("phlpulse-cb-palette", on ? "1" : "0"); }
    catch { /* storage blocked — non-fatal */ }
  }, []);

  return (
    <ThemeContext.Provider value={{ mode, resolved, setMode, colorBlindSafe, setColorBlindSafe }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  return useContext(ThemeContext);
}
