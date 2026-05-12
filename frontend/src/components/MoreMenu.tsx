"use client";

import { useState, useRef, useEffect } from "react";
import { 
  Settings, 
  Moon, 
  Sun, 
  Monitor, 
  Layers, 
  Info, 
  ChevronRight, 
  Clock,
  Code
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";

interface Props {
  mode: "auto" | "light" | "dark";
  setMode: (m: "auto" | "light" | "dark") => void;
  heatmapEnabled: boolean;
  setHeatmapEnabled: (v: boolean) => void;
  districtsEnabled: boolean;
  setDistrictsEnabled: (v: boolean) => void;
  todOverlayEnabled: boolean;
  setTodOverlayEnabled: (v: boolean) => void;
  todHourFocus: number | null;
  vectorTilesEnabled: boolean;
  setVectorTilesEnabled: (v: boolean) => void;
  savedPlacesOverlay: boolean;
  setSavedPlacesOverlay: (v: boolean) => void;
  colorBlindSafe: boolean;
  setColorBlindSafe: (v: boolean) => void;
  isPro: boolean;
  onShowAbout: () => void;
  onShowUpgrade: (feature: string) => void;
}

export default function MoreMenu({
  mode,
  setMode,
  heatmapEnabled,
  setHeatmapEnabled,
  districtsEnabled,
  setDistrictsEnabled,
  todOverlayEnabled,
  setTodOverlayEnabled,
  todHourFocus,
  vectorTilesEnabled,
  setVectorTilesEnabled,
  savedPlacesOverlay,
  setSavedPlacesOverlay,
  colorBlindSafe,
  setColorBlindSafe,
  isPro,
  onShowAbout,
  onShowUpgrade,
}: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  const THEME_OPTIONS = [
    { id: "auto", label: "Auto", icon: Monitor },
    { id: "light", label: "Light", icon: Sun },
    { id: "dark", label: "Dark", icon: Moon },
  ] as const;

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(!open)}
        className="w-12 h-12 flex items-center justify-center rounded-lg backdrop-blur-md shadow-lg transition-colors"
        style={{
          background: open ? "rgba(59,130,246,0.15)" : "var(--pill-bg)",
          border: `1px solid ${open ? "rgba(59,130,246,0.3)" : "var(--pill-border)"}`,
          color: open ? "#3b82f6" : "var(--pill-text)",
        }}
        title="Settings & More"
      >
        <Settings className={`w-5.5 h-5.5 transition-transform duration-300 ${open ? "rotate-90" : ""}`} />
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 8, x: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0, x: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 8, x: 8 }}
            className="absolute bottom-12 right-0 w-64 rounded-xl shadow-2xl backdrop-blur-xl overflow-hidden z-[2000]"
            style={{ 
              background: "var(--panel-bg)", 
              border: "1px solid var(--panel-border)",
              boxShadow: "0 20px 50px rgba(0,0,0,0.5)"
            }}
          >
            {/* Theme Section */}
            <div className="p-2 border-b border-[var(--panel-border)]">
              <p className="text-[11px] font-bold uppercase tracking-wider px-2 py-1 mb-1" style={{ color: "var(--panel-text-muted)" }}>Display</p>
              <div className="flex gap-1 p-1 bg-[var(--panel-input-bg)] rounded-lg mb-2">
                {THEME_OPTIONS.map((opt) => {
                  const Icon = opt.icon;
                  const active = mode === opt.id;
                  return (
                    <button
                      key={opt.id}
                      onClick={() => setMode(opt.id)}
                      className={`flex-1 flex flex-col items-center gap-1.5 py-2 rounded-md transition-all ${
                        active ? "bg-blue-500 shadow-lg text-white" : "text-[var(--panel-text-muted)] hover:text-[var(--panel-text)]"
                      }`}
                    >
                      <Icon className="w-4 h-4" />
                      <span className="text-[10px] font-medium">{opt.label}</span>
                    </button>
                  );
                })}
              </div>
              <button
                onClick={() => setColorBlindSafe(!colorBlindSafe)}
                className="w-full flex items-center justify-between px-2 py-2 rounded-md transition-colors hover:bg-[var(--panel-input-bg)]"
              >
                <span className="text-[11px] font-medium text-[var(--panel-text-secondary)]">Color-blind safe palette</span>
                <div 
                  className={`w-6 h-3 rounded-full transition-colors relative ${colorBlindSafe ? "bg-blue-500" : "bg-[var(--panel-border)]"}`}
                >
                  <div 
                    className={`absolute top-0.5 w-2 h-2 rounded-full bg-white shadow-sm transition-all ${colorBlindSafe ? "left-3.5" : "left-0.5"}`}
                  />
                </div>
              </button>
            </div>

            {/* Layers Section */}
            <div className="p-2 border-b border-[var(--panel-border)]">
              <p className="text-[11px] font-bold uppercase tracking-wider px-2 py-1 mb-1" style={{ color: "var(--panel-text-muted)" }}>Map Layers</p>
              <div className="space-y-0.5">
                {[
                  { label: "Crime Heatmap", active: heatmapEnabled, set: setHeatmapEnabled, icon: Layers },
                  { 
                    label: "This hour's hotspots", 
                    active: todOverlayEnabled, 
                    set: setTodOverlayEnabled, 
                    icon: Clock,
                    hint: todHourFocus != null ? `Peaks near ${todHourFocus}:00` : undefined 
                  },
                  { label: "Police Districts", active: districtsEnabled, set: setDistrictsEnabled, icon: CircleDot },
                  { label: "Saved Places", active: savedPlacesOverlay, set: setSavedPlacesOverlay, icon: MapIcon, pro: true },
                  { label: "Vector Buildings", active: vectorTilesEnabled, set: setVectorTilesEnabled, icon: Database },
                ].map((layer) => {
                  const locked = layer.pro && !isPro;
                  return (
                    <button
                      key={layer.label}
                      onClick={() => {
                        if (locked) { onShowUpgrade(layer.label); return; }
                        layer.set(!layer.active);
                      }}
                      className="w-full flex items-center justify-between px-2 py-2 rounded-md transition-colors hover:bg-[var(--panel-input-bg)] group"
                    >
                      <div className="flex flex-col items-start">
                        <div className="flex items-center gap-2.5">
                          <layer.icon className={`w-4 h-4 ${layer.active ? "text-blue-500" : "text-[var(--panel-text-muted)]"}`} />
                          <span className={`text-sm font-medium ${layer.active ? "text-[var(--panel-text)]" : "text-[var(--panel-text-secondary)]"}`}>
                            {layer.label}
                          </span>
                        </div>
                        {layer.hint && layer.active && (
                          <span className="text-[10px] ml-6.5 text-[var(--panel-text-muted)]">{layer.hint}</span>
                        )}
                      </div>
                      <div className="flex items-center gap-2">
                        {locked && <Lock className="w-3 h-3 text-purple-400" />}
                        <div 
                          className={`w-7 h-4 rounded-full transition-colors relative ${layer.active ? "bg-blue-500" : "bg-[var(--panel-border)]"}`}
                        >
                          <div 
                            className={`absolute top-0.5 w-3 h-3 rounded-full bg-white shadow-sm transition-all ${layer.active ? "left-3.5" : "left-0.5"}`}
                          />
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="p-1 bg-[var(--panel-input-bg)]/50 space-y-0.5">
              <button
                onClick={() => { window.location.href = "/api-docs"; setOpen(false); }}
                className="w-full flex items-center justify-between px-3 py-2.5 rounded-md transition-colors hover:bg-[var(--panel-input-bg)] group"
              >
                <div className="flex items-center gap-2.5 text-[var(--panel-text-secondary)] group-hover:text-[var(--panel-text)]">
                  <Code className="w-4 h-4" />
                  <span className="text-sm font-medium">API Documentation</span>
                </div>
                <ChevronRight className="w-4 h-4 text-[var(--panel-text-muted)] group-hover:translate-x-0.5 transition-transform" />
              </button>
              <button
                onClick={() => { onShowAbout(); setOpen(false); }}
                className="w-full flex items-center justify-between px-3 py-2.5 rounded-md transition-colors hover:bg-[var(--panel-input-bg)] group"
              >
                <div className="flex items-center gap-2.5 text-[var(--panel-text-secondary)] group-hover:text-[var(--panel-text)]">
                  <Info className="w-4 h-4" />
                  <span className="text-sm font-medium">About Pulse</span>
                </div>
                <ChevronRight className="w-4 h-4 text-[var(--panel-text-muted)] group-hover:translate-x-0.5 transition-transform" />
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
