"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { motion, AnimatePresence } from "framer-motion";
import {
  Activity,
  ChevronUp,
  Radio,
  Info,
  Shield,
  AlertTriangle,
  Eye,
  Flame,
  Crosshair,
  Wifi,
  X,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import IncidentFeed from "@/components/IncidentFeed";
import IncidentDetail from "@/components/IncidentDetail";
import SearchBar from "@/components/SearchBar";
import RoutePanel, { type RouteData } from "@/components/RoutePanel";
import SafetyScoreCard from "@/components/SafetyScoreCard";
import AlertToast from "@/components/AlertToast";
import type { MapHandle } from "@/components/IncidentMap";
import { getSeverity } from "@/lib/severity";
import {
  fetchIncidents,
  fetchSummary,
  fetchStats,
  type Incident,
  type StatsResponse,
} from "@/lib/api";

const TIME_FILTERS = [
  { label: "1h", hours: 1 },
  { label: "6h", hours: 6 },
  { label: "24h", hours: 24 },
  { label: "All", hours: 0 },
] as const;

const CATEGORY_GROUPS = [
  { label: "Violent", cats: ["violent_weapon", "violent_no_weapon", "shots_heard", "robbery", "burglary_in_progress"], color: "#ef4444" },
  { label: "Medical", cats: ["medical_priority", "medical_other"], color: "#f472b6" },
  { label: "Traffic", cats: ["traffic_crash_injury", "traffic_crash_no_injury"], color: "#60a5fa" },
  { label: "Fire", cats: ["fire_hazmat"], color: "#fb923c" },
  { label: "Other", cats: ["disorder", "admin_or_noise"], color: "#a78bfa" },
] as const;

const IncidentMap = dynamic(() => import("@/components/IncidentMap"), {
  ssr: false,
  loading: () => (
    <div className="w-full h-full flex items-center justify-center bg-[#0a0a14]">
      <div className="flex flex-col items-center gap-4">
        <div className="relative">
          <Crosshair className="w-12 h-12 text-blue-400/60 animate-spin" style={{ animationDuration: "3s" }} />
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="w-3 h-3 bg-blue-400 rounded-full animate-pulse" />
          </div>
        </div>
        <p className="text-xs text-blue-400/60 font-mono tracking-widest uppercase">Initializing map</p>
      </div>
    </div>
  ),
});

const POLL_INTERVAL = 12000;

function SeverityMiniBar({ incidents }: { incidents: Incident[] }) {
  const counts: Record<string, number> = {};
  for (const inc of incidents) {
    const sev = getSeverity(inc.severity_category);
    counts[sev.label] = (counts[sev.label] || 0) + 1;
  }
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 4);

  return (
    <div className="flex gap-2">
      {sorted.map(([label, count]) => (
        <div key={label} className="flex items-center gap-1.5 text-xs">
          <span className="text-muted-foreground">{label}</span>
          <span className="font-mono font-bold text-foreground">{count}</span>
        </div>
      ))}
    </div>
  );
}

function LiveTicker({ incidents }: { incidents: Incident[] }) {
  const recent = incidents.slice(0, 10);
  if (recent.length === 0) return null;

  const items = [...recent, ...recent];

  return (
    <div className="overflow-hidden whitespace-nowrap">
      <div className="inline-flex animate-ticker-scroll">
        {items.map((inc, i) => {
          const sev = getSeverity(inc.severity_category);
          return (
            <span key={`${inc.id}-${i}`} className="inline-flex items-center gap-2 mx-4 text-xs">
              <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: sev.markerColor }} />
              <span className="text-muted-foreground">{sev.label}</span>
              <span className="text-foreground/60">{inc.location_text?.split(",")[0] || "Unknown"}</span>
            </span>
          );
        })}
      </div>
    </div>
  );
}

export default function Home() {
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [summary, setSummary] = useState<string>("");
  const [stats, setStats] = useState<StatsResponse | null>(null);
  const [feedOpen, setFeedOpen] = useState(false);
  const [showAbout, setShowAbout] = useState(false);
  const [routes, setRoutes] = useState<RouteData | null>(null);
  const [prevCount, setPrevCount] = useState(0);
  const [newIncidentFlash, setNewIncidentFlash] = useState(false);
  const [timeFilter, setTimeFilter] = useState(0);
  const [activeCats, setActiveCats] = useState<Set<string>>(new Set());
  const [mapTap, setMapTap] = useState<{ lat: number; lng: number } | null>(null);
  const mapRef = useRef<MapHandle>(null);

  const loadData = useCallback(async () => {
    try {
      const [inc, sum, st] = await Promise.all([
        fetchIncidents(),
        fetchSummary(),
        fetchStats(),
      ]);
      setIncidents((prev) => {
        if (inc.length > prev.length && prev.length > 0) {
          setNewIncidentFlash(true);
          setTimeout(() => setNewIncidentFlash(false), 2000);
        }
        return inc;
      });
      setSummary(sum.summary);
      setStats(st);
    } catch (e) {
      console.error("Failed to load data:", e);
    }
  }, []);

  useEffect(() => {
    loadData();
    const timer = setInterval(loadData, POLL_INTERVAL);
    return () => clearInterval(timer);
  }, [loadData]);

  useEffect(() => {
    setPrevCount(incidents.length);
  }, [incidents.length]);

  const toggleCat = useCallback((cats: readonly string[]) => {
    setActiveCats((prev) => {
      const next = new Set(prev);
      const allActive = cats.every((c) => next.has(c));
      if (allActive) {
        cats.forEach((c) => next.delete(c));
      } else {
        cats.forEach((c) => next.add(c));
      }
      return next;
    });
  }, []);

  const filteredIncidents = incidents.filter((inc) => {
    if (timeFilter > 0) {
      const cutoff = Date.now() - timeFilter * 60 * 60 * 1000;
      if (new Date(inc.reported_at).getTime() < cutoff) return false;
    }
    if (activeCats.size > 0 && !activeCats.has(inc.severity_category)) return false;
    return true;
  });

  const selected = filteredIncidents.find((i) => i.id === selectedId) || null;

  const highSeverityCount = filteredIncidents.filter((i) => i.s_base >= 0.7).length;

  return (
    <div className="relative w-full h-screen overflow-hidden bg-[#0a0a14]">
      {/* Scan line effect */}
      <div className="absolute inset-0 z-[999] pointer-events-none overflow-hidden opacity-[0.03]">
        <div className="w-full h-px bg-gradient-to-r from-transparent via-cyan-400 to-transparent animate-scan-line" />
      </div>

      {/* New incident flash overlay */}
      <AnimatePresence>
        {newIncidentFlash && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0 z-[998] pointer-events-none border-2 border-red-500/30 rounded-none"
            style={{ boxShadow: "inset 0 0 80px rgba(239, 68, 68, 0.1)" }}
          />
        )}
      </AnimatePresence>

      {/* Alert toast for new incidents */}
      <AlertToast incidents={incidents} />

      {/* Map (full screen) */}
      <IncidentMap
        ref={mapRef}
        incidents={filteredIncidents}
        selectedId={selectedId}
        onSelectIncident={(id) => { setMapTap(null); setSelectedId(id); }}
        routes={routes}
        onMapTap={(lat, lng) => { setSelectedId(null); setMapTap({ lat, lng }); }}
      />

      {/* === TOP HUD === */}
      <div className="absolute top-0 left-0 right-0 z-[1000] pointer-events-none">
        {/* Main top bar */}
        <div className="flex items-center justify-between p-3 pointer-events-auto">
          {/* Logo + status */}
          <div className="glass-panel rounded-xl px-4 py-2.5 flex items-center gap-3">
            <div className="relative">
              <Activity className="w-5 h-5 text-red-400" />
              <div className="absolute -top-0.5 -right-0.5 w-2 h-2 bg-green-400 rounded-full animate-pulse" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="font-bold text-sm tracking-tight text-gradient-brand">PHLPulse</span>
                <div className="flex items-center gap-1 text-[10px] text-green-400 font-mono">
                  <Wifi className="w-3 h-3" />
                  LIVE
                </div>
              </div>
              <div className="flex items-center gap-2 text-[10px] text-muted-foreground font-mono">
                <span>{filteredIncidents.length} incidents</span>
                <span className="text-border">|</span>
                <span className="text-amber-400">{highSeverityCount} high severity</span>
              </div>
            </div>
          </div>

          {/* Right controls */}
          <div className="flex gap-2 items-center">
            <SearchBar
              incidents={incidents}
              onFlyTo={(lat, lng) => mapRef.current?.flyTo(lat, lng)}
            />
            <button
              onClick={() => setShowAbout(!showAbout)}
              className="glass-panel rounded-lg p-2.5 hover:bg-white/10 transition-colors"
            >
              {showAbout ? <X className="w-4 h-4" /> : <Info className="w-4 h-4" />}
            </button>
          </div>
        </div>

        {/* Ticker bar */}
        {filteredIncidents.length > 0 && (
          <div className="mx-3 glass-panel-light rounded-lg px-3 py-1.5 pointer-events-auto">
            <LiveTicker incidents={filteredIncidents} />
          </div>
        )}

        {/* Time filter + Category filter */}
        <div className="flex items-center gap-2 mx-3 mt-2 pointer-events-auto flex-wrap">
          {/* Time filter */}
          <div className="glass-panel-light rounded-lg flex overflow-hidden">
            {TIME_FILTERS.map((tf) => (
              <button
                key={tf.label}
                onClick={() => setTimeFilter(tf.hours)}
                className={`px-2.5 py-1 text-[10px] font-mono transition-colors ${
                  timeFilter === tf.hours
                    ? "bg-blue-500/20 text-blue-400"
                    : "text-muted-foreground hover:text-foreground hover:bg-white/5"
                }`}
              >
                {tf.label}
              </button>
            ))}
          </div>

          {/* Category filter chips */}
          {CATEGORY_GROUPS.map((group) => {
            const isActive = group.cats.some((c) => activeCats.has(c));
            return (
              <button
                key={group.label}
                onClick={() => toggleCat(group.cats)}
                className={`glass-panel-light rounded-full px-2.5 py-1 text-[10px] font-mono flex items-center gap-1.5 transition-all ${
                  isActive ? "ring-1" : "opacity-60 hover:opacity-100"
                }`}
                style={isActive ? { borderColor: group.color + "60", color: group.color } : {}}
              >
                <div
                  className="w-1.5 h-1.5 rounded-full"
                  style={{ backgroundColor: group.color }}
                />
                {group.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* === ABOUT / TRANSPARENCY PANEL === */}
      <AnimatePresence>
        {showAbout && (
          <motion.div
            initial={{ opacity: 0, x: 300, scale: 0.95 }}
            animate={{ opacity: 1, x: 0, scale: 1 }}
            exit={{ opacity: 0, x: 300, scale: 0.95 }}
            transition={{ type: "spring", damping: 25, stiffness: 200 }}
            className="absolute top-20 right-3 z-[1000] w-80 max-h-[calc(100vh-6rem)] overflow-y-auto glass-panel rounded-xl p-4 space-y-3"
          >
            <h3 className="font-semibold flex items-center gap-2 text-sm">
              <Shield className="w-4 h-4 text-blue-400" />
              Transparency & Responsible AI
            </h3>
            <p className="text-xs text-muted-foreground leading-relaxed">
              PHLPulse uses AI at every layer: speech-to-text (Whisper)
              converts police scanner audio, an LLM extracts structured incident
              data, and geocoding places it on this map.
            </p>
            <p className="text-xs text-muted-foreground leading-relaxed">
              Every incident is evaluated by the{" "}
              <strong className="text-blue-400">Applied AI Studio Inhibitor</strong> ethical guardrail.
              Content flagged for PII, potential harm, or hallucination is blocked.
            </p>
            {stats && (
              <div className="text-xs space-y-1.5 bg-white/5 rounded-lg p-3">
                <p className="font-mono">
                  <span className="text-2xl font-bold text-gradient-brand animate-count-up inline-block">{stats.total_incidents}</span>
                  <span className="text-muted-foreground ml-2">incidents processed</span>
                </p>
                <div className="flex flex-wrap gap-1.5 pt-1">
                  {Object.entries(stats.inhibitor_stats).map(([status, count]) => (
                    <Badge key={status} variant="outline" className="text-[10px] font-mono">
                      {status}: {count}
                    </Badge>
                  ))}
                </div>
              </div>
            )}
            {summary && (
              <div className="bg-white/5 rounded-lg p-3">
                <p className="text-[10px] text-blue-400 font-mono font-medium mb-1.5 flex items-center gap-1">
                  <Eye className="w-3 h-3" /> AI SUMMARY
                </p>
                <p className="text-xs text-muted-foreground leading-relaxed">{summary}</p>
              </div>
            )}
            <div className="text-[10px] text-muted-foreground border-t border-white/5 pt-3">
              <p className="font-medium text-amber-400 mb-1 flex items-center gap-1">
                <AlertTriangle className="w-3 h-3" /> DISCLAIMER
              </p>
              <p className="leading-relaxed">
                All data is sourced from public radio scanner audio via AI
                transcription. Every pin is <strong>UNVERIFIED</strong>. Not
                real-time 911 data. Do not rely on this for safety-critical decisions.
              </p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* === ROUTE PANEL === */}
      <RoutePanel incidents={incidents} onRoutesChange={setRoutes} />

      {/* === SAFETY SCORE CARD (map tap) === */}
      <AnimatePresence>
        {mapTap && !selected && (
          <motion.div
            initial={{ opacity: 0, y: 30, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 30, scale: 0.95 }}
            transition={{ type: "spring", damping: 25, stiffness: 200 }}
            className="absolute bottom-20 left-3 right-3 md:left-auto md:right-3 md:bottom-3 md:w-80 z-[1000]"
          >
            <SafetyScoreCard
              lat={mapTap.lat}
              lng={mapTap.lng}
              incidents={filteredIncidents}
              onClose={() => setMapTap(null)}
            />
          </motion.div>
        )}
      </AnimatePresence>

      {/* === INCIDENT DETAIL === */}
      <AnimatePresence>
        {selected && (
          <motion.div
            initial={{ opacity: 0, y: 30, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 30, scale: 0.95 }}
            transition={{ type: "spring", damping: 25, stiffness: 200 }}
            className="absolute bottom-20 left-3 right-3 md:left-auto md:right-3 md:bottom-3 md:w-96 z-[1000]"
          >
            <IncidentDetail
              incident={selected}
              onClose={() => setSelectedId(null)}
            />
          </motion.div>
        )}
      </AnimatePresence>

      {/* === SIDEBAR / BOTTOM SHEET === */}
      <div className="absolute bottom-0 left-0 right-0 md:top-20 md:bottom-0 md:left-0 md:right-auto md:w-80 z-[1000] pointer-events-none">
        {/* Mobile toggle */}
        <div className="md:hidden pointer-events-auto">
          <button
            onClick={() => setFeedOpen(!feedOpen)}
            className="w-full glass-panel border-t border-white/5 px-4 py-2.5 flex items-center justify-center gap-2 text-xs font-medium"
          >
            <ChevronUp
              className={`w-4 h-4 transition-transform ${feedOpen ? "rotate-180" : ""}`}
            />
            {feedOpen ? "Hide" : "Show"} Incident Feed
            <Badge variant="secondary" className="text-[10px] font-mono ml-1">
              {filteredIncidents.length}
            </Badge>
          </button>
          <AnimatePresence>
            {feedOpen && (
              <motion.div
                initial={{ height: 0 }}
                animate={{ height: "55vh" }}
                exit={{ height: 0 }}
                className="glass-panel overflow-hidden"
              >
                <div className="h-full overflow-y-auto p-2">
                  <IncidentFeed
                    incidents={filteredIncidents}
                    selectedId={selectedId}
                    onSelect={setSelectedId}
                  />
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Desktop sidebar */}
        <div className="hidden md:flex md:flex-col h-full glass-panel border-r border-white/5 pointer-events-auto overflow-hidden">
          <div className="p-3 border-b border-white/5 flex items-center justify-between">
            <h2 className="text-xs font-semibold flex items-center gap-2 font-mono tracking-wider uppercase">
              <Radio className="w-3.5 h-3.5 text-red-400" />
              Live Feed
            </h2>
            <div className="flex items-center gap-1">
              <Flame className="w-3 h-3 text-amber-400" />
              <span className="text-[10px] font-mono text-amber-400">{highSeverityCount} critical</span>
            </div>
          </div>
          {filteredIncidents.length > 0 && (
            <div className="px-3 py-2 border-b border-white/5">
              <SeverityMiniBar incidents={filteredIncidents} />
            </div>
          )}
          <div className="flex-1 overflow-y-auto p-2">
            <IncidentFeed
              incidents={filteredIncidents}
              selectedId={selectedId}
              onSelect={setSelectedId}
            />
          </div>
        </div>
      </div>

      {/* === BOTTOM-RIGHT STATS HUD === */}
      {filteredIncidents.length > 0 && (
        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 md:left-auto md:translate-x-0 md:bottom-4 md:right-20 z-[999] pointer-events-none">
          <div className="glass-panel-light rounded-lg px-4 py-2 flex items-center gap-4 text-[10px] font-mono">
            <div className="flex items-center gap-1.5">
              <div className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
              <span className="text-green-400">SYSTEM ONLINE</span>
            </div>
            <span className="text-border">|</span>
            <span className="text-muted-foreground">
              {new Date().toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })} EST
            </span>
            <span className="text-border">|</span>
            <span className="text-muted-foreground">PHILLY METRO</span>
          </div>
        </div>
      )}
    </div>
  );
}
