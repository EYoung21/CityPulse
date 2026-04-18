"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { Search, MapPin, Loader2, X, Navigation, Mic, Clock, Trash2, Home, Briefcase } from "lucide-react";
import { geocodePhilly } from "@/lib/search";
import { isVoiceSearchSupported, startVoiceSearch } from "@/lib/voice";
import { clearRecent, loadRecent, pushRecent, type RecentSearch } from "@/lib/recent-searches";
import { useSavedDestinations } from "@/hooks/useSavedDestinations";

interface GeoResult {
  display_name: string;
  lat: number;
  lng: number;
}

interface Props {
  onFlyTo: (lat: number, lng: number) => void;
  onDirections: (name: string, coords: { lat: number; lng: number }) => void;
}

export default function SearchInput({ onFlyTo, onDirections }: Props) {
  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState<GeoResult[]>([]);
  const [recents, setRecents] = useState<RecentSearch[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [voiceActive, setVoiceActive] = useState(false);
  const [voiceSupported, setVoiceSupported] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const voiceRef = useRef<{ stop: () => void } | null>(null);

  useEffect(() => {
    setVoiceSupported(isVoiceSearchSupported());
    setRecents(loadRecent());
  }, []);

  const geocode = useCallback((q: string) => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (q.trim().length < 2) {
      setSuggestions([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    debounceRef.current = setTimeout(async () => {
      const results = await geocodePhilly(q);
      setSuggestions(results);
      setLoading(false);
    }, 200);
  }, []);

  const remember = useCallback((s: GeoResult) => {
    setRecents(pushRecent({ display_name: s.display_name, lat: s.lat, lng: s.lng }));
  }, []);

  const handleSelect = (s: GeoResult) => {
    onFlyTo(s.lat, s.lng);
    setQuery(s.display_name.split(",")[0]);
    setSuggestions([]);
    setOpen(false);
    remember(s);
  };

  const stopVoice = useCallback(() => {
    voiceRef.current?.stop();
    voiceRef.current = null;
    setVoiceActive(false);
  }, []);

  const startVoice = useCallback(() => {
    if (voiceActive) {
      stopVoice();
      return;
    }
    if (typeof navigator !== "undefined" && "vibrate" in navigator) {
      try { navigator.vibrate?.(10); } catch { /* ignore */ }
    }
    setVoiceActive(true);
    setOpen(true);
    voiceRef.current = startVoiceSearch({
      onResult: (transcript, isFinal) => {
        setQuery(transcript);
        if (isFinal) {
          geocode(transcript);
          setVoiceActive(false);
          voiceRef.current = null;
        }
      },
      onError: () => {
        setVoiceActive(false);
        voiceRef.current = null;
      },
      onEnd: () => {
        setVoiceActive(false);
        voiceRef.current = null;
      },
    });
    if (!voiceRef.current) setVoiceActive(false);
  }, [voiceActive, geocode, stopVoice]);

  useEffect(() => () => stopVoice(), [stopVoice]);

  // Pinned Home/Work shortcuts: shown as one-tap-route chips when the
  // search input is focused and empty. Drawn from the user's saved
  // destinations, with `category === "home" | "work"` (set by the Save-as
  // picker in PlaceActions).
  const { destinations } = useSavedDestinations();
  const homePlace = destinations.find((d) => d.category === "home") || null;
  const workPlace = destinations.find((d) => d.category === "work") || null;
  const hasShortcuts = open && query.trim().length < 2 && (homePlace || workPlace);

  const showRecents = open && query.trim().length < 2 && recents.length > 0;
  const showSuggestions = open && (suggestions.length > 0 || loading) && query.trim().length >= 2;

  return (
    <div className="p-4 pb-2">
      <div
        className="flex items-center gap-3 rounded-full px-4 py-2.5 transition-colors shadow-lg"
        style={{
          background: "var(--panel-input-bg)",
          border: "1px solid var(--panel-input-border)",
          boxShadow: "0 2px 8px var(--panel-shadow)",
        }}
      >
        <Search className="w-5 h-5 text-blue-500 shrink-0" />
        <input
          type="text"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
            geocode(e.target.value);
          }}
          onFocus={() => setOpen(true)}
          placeholder={voiceActive ? "Listening…" : "Search CityPulse"}
          className="flex-1 bg-transparent text-sm outline-none"
          style={{ color: "var(--panel-text)" }}
        />
        {query && !voiceActive && (
          <button
            onClick={() => {
              setQuery("");
              setSuggestions([]);
              setOpen(true);
            }}
            style={{ color: "var(--panel-text-muted)" }}
            aria-label="Clear search"
          >
            <X className="w-4 h-4" />
          </button>
        )}
        {voiceSupported && (
          <button
            onClick={startVoice}
            title={voiceActive ? "Stop listening" : "Voice search"}
            aria-label={voiceActive ? "Stop voice search" : "Start voice search"}
            aria-pressed={voiceActive}
            className="shrink-0 inline-flex items-center justify-center w-7 h-7 rounded-full transition-colors"
            style={{
              background: voiceActive ? "rgba(239, 68, 68, 0.15)" : "transparent",
              color: voiceActive ? "#ef4444" : "var(--panel-text-muted)",
            }}
          >
            <Mic className={`w-4 h-4 ${voiceActive ? "voice-mic-pulse" : ""}`} />
          </button>
        )}
      </div>

      {hasShortcuts && (
        <div className="mt-2 flex gap-2 overflow-x-auto no-scrollbar -mx-1 px-1 pb-1">
          {homePlace && (
            <button
              type="button"
              onClick={() => onDirections(homePlace.name, { lat: homePlace.lat, lng: homePlace.lng })}
              className="shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition-colors active:scale-95"
              style={{
                background: "rgba(34,197,94,0.12)",
                color: "#22c55e",
                border: "1px solid rgba(34,197,94,0.35)",
              }}
              title={`Directions to ${homePlace.name}`}
              aria-label={`Get directions to home: ${homePlace.name}`}
            >
              <Home className="w-3.5 h-3.5" /> Home
            </button>
          )}
          {workPlace && (
            <button
              type="button"
              onClick={() => onDirections(workPlace.name, { lat: workPlace.lat, lng: workPlace.lng })}
              className="shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition-colors active:scale-95"
              style={{
                background: "rgba(59,130,246,0.12)",
                color: "#3b82f6",
                border: "1px solid rgba(59,130,246,0.35)",
              }}
              title={`Directions to ${workPlace.name}`}
              aria-label={`Get directions to work: ${workPlace.name}`}
            >
              <Briefcase className="w-3.5 h-3.5" /> Work
            </button>
          )}
        </div>
      )}

      {showRecents && (
        <div
          className="mt-2 rounded-xl overflow-hidden shadow-lg"
          style={{
            background: "var(--panel-bg-secondary)",
            border: "1px solid var(--panel-border)",
          }}
        >
          <div
            className="flex items-center justify-between px-4 py-2"
            style={{ borderBottom: "1px solid var(--panel-border)" }}
          >
            <span
              className="text-[10px] font-semibold uppercase tracking-wider flex items-center gap-1.5"
              style={{ color: "var(--panel-text-muted)" }}
            >
              <Clock className="w-3 h-3" /> Recent
            </span>
            <button
              type="button"
              onClick={() => {
                clearRecent();
                setRecents([]);
              }}
              className="text-[10px] flex items-center gap-1"
              style={{ color: "var(--panel-text-muted)" }}
              aria-label="Clear recent searches"
            >
              <Trash2 className="w-3 h-3" /> Clear
            </button>
          </div>
          {recents.map((r, i) => {
            const parts = r.display_name.split(",");
            const primary = parts[0].trim();
            const secondary = parts.slice(1, 3).map((p) => p.trim()).join(", ");
            return (
              <div
                key={`${r.lat},${r.lng},${i}`}
                onClick={() => handleSelect(r)}
                className="w-full text-left px-4 py-2.5 flex items-start gap-3 last:border-0 transition-colors cursor-pointer"
                style={{ borderBottom: "1px solid var(--panel-border)" }}
                onMouseEnter={(e) => (e.currentTarget.style.background = "var(--panel-hover)")}
                onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
              >
                <div
                  className="w-7 h-7 rounded-full flex items-center justify-center shrink-0 mt-0.5"
                  style={{ background: "var(--panel-input-bg)" }}
                >
                  <Clock className="w-3.5 h-3.5" style={{ color: "var(--panel-text-muted)" }} />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm truncate" style={{ color: "var(--panel-text)" }}>{primary}</p>
                  {secondary && (
                    <p className="text-xs truncate mt-0.5" style={{ color: "var(--panel-text-muted)" }}>
                      {secondary}
                    </p>
                  )}
                </div>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onDirections(primary, { lat: r.lat, lng: r.lng });
                    remember({ display_name: r.display_name, lat: r.lat, lng: r.lng });
                  }}
                  className="ml-auto text-blue-500/50 hover:text-blue-500 shrink-0 mt-1"
                  title="Get directions"
                  aria-label={`Get directions to ${primary}`}
                >
                  <Navigation className="w-4 h-4" />
                </button>
              </div>
            );
          })}
        </div>
      )}

      {showSuggestions && (
        <div
          className="mt-2 rounded-xl overflow-hidden shadow-lg"
          style={{
            background: "var(--panel-bg-secondary)",
            border: "1px solid var(--panel-border)",
          }}
        >
          {loading && suggestions.length === 0 && (
            <div className="px-4 py-3 flex items-center gap-3">
              <Loader2 className="w-4 h-4 animate-spin" style={{ color: "var(--panel-text-muted)" }} />
              <span className="text-xs" style={{ color: "var(--panel-text-muted)" }}>
                Searching...
              </span>
            </div>
          )}
          {suggestions.map((s, i) => {
            const parts = s.display_name.split(",");
            const primary = parts[0].trim();
            const secondary = parts.slice(1, 3).map((p) => p.trim()).join(", ");
            return (
              <div
                key={i}
                onClick={() => handleSelect(s)}
                className="w-full text-left px-4 py-3 flex items-start gap-3 last:border-0 transition-colors cursor-pointer"
                style={{ borderBottom: "1px solid var(--panel-border)" }}
                onMouseEnter={(e) => (e.currentTarget.style.background = "var(--panel-hover)")}
                onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
              >
                <div
                  className="w-8 h-8 rounded-full flex items-center justify-center shrink-0 mt-0.5"
                  style={{ background: "var(--panel-input-bg)" }}
                >
                  <MapPin className="w-4 h-4" style={{ color: "var(--panel-text-muted)" }} />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium truncate" style={{ color: "var(--panel-text)" }}>
                    {primary}
                  </p>
                  {secondary && (
                    <p className="text-xs truncate mt-0.5" style={{ color: "var(--panel-text-muted)" }}>
                      {secondary}
                    </p>
                  )}
                </div>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onDirections(primary, s);
                    remember(s);
                  }}
                  className="ml-auto text-blue-500/50 hover:text-blue-500 shrink-0 mt-1"
                  title="Get directions"
                  aria-label={`Get directions to ${primary}`}
                >
                  <Navigation className="w-4 h-4" />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
