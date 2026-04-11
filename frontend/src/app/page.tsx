"use client";

import { useCallback, useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { motion, AnimatePresence } from "framer-motion";
import {
  Activity,
  ChevronUp,
  Radio,
  Info,
  Shield,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import IncidentFeed from "@/components/IncidentFeed";
import IncidentDetail from "@/components/IncidentDetail";
import {
  fetchIncidents,
  fetchSummary,
  fetchStats,
  type Incident,
  type StatsResponse,
} from "@/lib/api";

const IncidentMap = dynamic(() => import("@/components/IncidentMap"), {
  ssr: false,
  loading: () => (
    <div className="w-full h-full flex items-center justify-center bg-background">
      <Radio className="w-8 h-8 animate-pulse text-muted-foreground" />
    </div>
  ),
});

const POLL_INTERVAL = 15000;

export default function Home() {
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [summary, setSummary] = useState<string>("");
  const [stats, setStats] = useState<StatsResponse | null>(null);
  const [feedOpen, setFeedOpen] = useState(false);
  const [showAbout, setShowAbout] = useState(false);

  const loadData = useCallback(async () => {
    try {
      const [inc, sum, st] = await Promise.all([
        fetchIncidents(),
        fetchSummary(),
        fetchStats(),
      ]);
      setIncidents(inc);
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

  const selected = incidents.find((i) => i.id === selectedId) || null;

  return (
    <div className="relative w-full h-screen overflow-hidden">
      {/* Map (full screen) */}
      <IncidentMap
        incidents={incidents}
        selectedId={selectedId}
        onSelectIncident={setSelectedId}
      />

      {/* Top bar */}
      <div className="absolute top-0 left-0 right-0 z-[1000] pointer-events-none">
        <div className="flex items-center justify-between p-3 pointer-events-auto">
          <div className="flex items-center gap-2 bg-card/90 backdrop-blur-sm rounded-lg px-3 py-2 border border-border/50">
            <Activity className="w-5 h-5 text-red-400" />
            <span className="font-semibold text-sm">PhillyPulse</span>
            <Badge variant="secondary" className="text-xs">
              {incidents.length} active
            </Badge>
          </div>

          <div className="flex gap-2">
            <Button
              size="sm"
              variant="secondary"
              className="bg-card/90 backdrop-blur-sm border border-border/50"
              onClick={() => setShowAbout(!showAbout)}
            >
              <Info className="w-4 h-4" />
            </Button>
          </div>
        </div>
      </div>

      {/* About / Transparency panel */}
      <AnimatePresence>
        {showAbout && (
          <motion.div
            initial={{ opacity: 0, x: 300 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 300 }}
            className="absolute top-16 right-3 z-[1000] w-80 max-h-[calc(100vh-5rem)] overflow-y-auto bg-card/95 backdrop-blur-sm rounded-lg border border-border/50 p-4 space-y-3"
          >
            <h3 className="font-semibold flex items-center gap-2">
              <Shield className="w-4 h-4" /> Transparency & Responsible AI
            </h3>
            <p className="text-sm text-muted-foreground">
              PhillyPulse uses AI at every layer: speech-to-text (Whisper)
              converts police scanner audio, an LLM extracts structured incident
              data, and geocoding places it on this map.
            </p>
            <p className="text-sm text-muted-foreground">
              Every incident is evaluated by the{" "}
              <strong>Applied AI Studio Inhibitor</strong> ethical guardrail
              before display. Content flagged for PII, potential harm, or
              hallucination is blocked.
            </p>
            {stats && (
              <div className="text-sm space-y-1 bg-muted/30 rounded-md p-2">
                <p>
                  <strong>{stats.total_incidents}</strong> total incidents
                  evaluated
                </p>
                {Object.entries(stats.inhibitor_stats).map(([status, count]) => (
                  <p key={status}>
                    <Badge variant="outline" className="text-xs mr-1">
                      {status}
                    </Badge>
                    {count}
                  </p>
                ))}
              </div>
            )}
            {summary && (
              <div>
                <p className="text-xs text-muted-foreground font-medium mb-1">
                  AI Summary
                </p>
                <p className="text-sm">{summary}</p>
              </div>
            )}
            <div className="text-xs text-muted-foreground border-t border-border/50 pt-2">
              <p className="font-medium text-amber-400 mb-1">Disclaimer</p>
              <p>
                All data is sourced from public radio scanner audio via AI
                transcription. Every pin is <strong>UNVERIFIED</strong>. This is
                not real-time 911 data and not official police information. Do
                not rely on this for safety-critical decisions. Broadcastify{" "}
                <a
                  href="https://www.broadcastify.com/terms/"
                  className="underline"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  terms
                </a>{" "}
                apply.
              </p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Incident detail (when a pin is selected) */}
      <AnimatePresence>
        {selected && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 20 }}
            className="absolute bottom-20 left-3 right-3 md:left-auto md:right-3 md:bottom-3 md:w-96 z-[1000]"
          >
            <IncidentDetail
              incident={selected}
              onClose={() => setSelectedId(null)}
            />
          </motion.div>
        )}
      </AnimatePresence>

      {/* Bottom sheet toggle (mobile) / Sidebar (desktop) */}
      <div className="absolute bottom-0 left-0 right-0 md:top-16 md:bottom-0 md:left-0 md:right-auto md:w-80 z-[1000] pointer-events-none">
        {/* Mobile toggle */}
        <div className="md:hidden pointer-events-auto">
          <button
            onClick={() => setFeedOpen(!feedOpen)}
            className="w-full bg-card/95 backdrop-blur-sm border-t border-border/50 px-4 py-2 flex items-center justify-center gap-2 text-sm"
          >
            <ChevronUp
              className={`w-4 h-4 transition-transform ${feedOpen ? "rotate-180" : ""}`}
            />
            {feedOpen ? "Hide" : "Show"} Incident Feed ({incidents.length})
          </button>
          <AnimatePresence>
            {feedOpen && (
              <motion.div
                initial={{ height: 0 }}
                animate={{ height: "50vh" }}
                exit={{ height: 0 }}
                className="bg-card/95 backdrop-blur-sm overflow-hidden"
              >
                <div className="h-full overflow-y-auto p-2">
                  <IncidentFeed
                    incidents={incidents}
                    selectedId={selectedId}
                    onSelect={setSelectedId}
                  />
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Desktop sidebar */}
        <div className="hidden md:block h-full bg-card/95 backdrop-blur-sm border-r border-border/50 pointer-events-auto overflow-y-auto">
          <div className="p-3 border-b border-border/50">
            <h2 className="text-sm font-semibold flex items-center gap-2">
              <Radio className="w-4 h-4 text-red-400" />
              Live Incident Feed
            </h2>
          </div>
          <div className="p-2">
            <IncidentFeed
              incidents={incidents}
              selectedId={selectedId}
              onSelect={setSelectedId}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
