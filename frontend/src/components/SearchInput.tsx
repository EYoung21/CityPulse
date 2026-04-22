"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { Search, MapPin, Loader2, X, Navigation, Mic, Clock, Trash2, Home, Briefcase, Star, Radio, Lock, Bookmark } from "lucide-react";
import { geocodePhilly } from "@/lib/search";
import { isVoiceSearchSupported, startVoiceSearch } from "@/lib/voice";
import { clearRecent, loadRecent, pushRecent, removeRecent, subscribeRecent, type RecentSearch } from "@/lib/recent-searches";
import { useSavedDestinations } from "@/hooks/useSavedDestinations";
import QuickSavePlace from "@/components/QuickSavePlace";
import CommutePredictionPill from "@/components/CommutePredictionPill";
import { predictNextCommute } from "@/lib/commute-patterns";
import { subscribeTripHistory } from "@/lib/trip-history";
import { searchIncidentsApi, type Incident } from "@/lib/api";
import { getCurrentCity } from "@/lib/pulse-cities";
import { useAuth } from "@/contexts/AuthContext";

interface GeoResult {
  display_name: string;
  lat: number;
  lng: number;
}

interface Props {
  onFlyTo: (lat: number, lng: number) => void;
  onDirections: (name: string, coords: { lat: number; lng: number }) => void;
  /** Forwarded to the incident-search section so the user's currently
   *  selected window (Last 1h / 24h / 7d / etc.) drives both the map
   *  and the search results. Falls back to 24h. */
  timeFilterHours?: number;
  /** When the user picks an incident result we surface it on the map
   *  via the same selection pipeline used by `IncidentFeed`. */
  onSelectIncident?: (id: string) => void;
}

type SearchMode = "places" | "incidents";

const FREE_INCIDENT_SEARCH_HOURS = 3;

export default function SearchInput({ onFlyTo, onDirections, timeFilterHours = 24, onSelectIncident }: Props) {
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<SearchMode>("places");
  const [suggestions, setSuggestions] = useState<GeoResult[]>([]);
  const [incidentResults, setIncidentResults] = useState<Incident[]>([]);
  const [incidentTotal, setIncidentTotal] = useState(0);
  const [recents, setRecents] = useState<RecentSearch[]>([]);
  const [loading, setLoading] = useState(false);
  const [incidentLoading, setIncidentLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [voiceActive, setVoiceActive] = useState(false);
  const [voiceSupported, setVoiceSupported] = useState(false);
  // Key of the result row whose inline QuickSavePlace form is open.
  // `null` = no save form expanded. Shape: "suggest-<idx>" | "recent-<lat>,<lng>"
  // so we can key cleanly across both result buckets without caring
  // about ordering. Clicking the bookmark again on the same row
  // collapses the form; clicking a different row's bookmark swaps.
  const [saveTarget, setSaveTarget] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const incidentDebounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const incidentAbortRef = useRef<AbortController | null>(null);
  const voiceRef = useRef<{ stop: () => void } | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const { isPro } = useAuth();

  useEffect(() => {
    setVoiceSupported(isVoiceSearchSupported());
    setRecents(loadRecent());
    // Subscribe so the dropdown updates live when prefs-sync hydrates
    // recents from another device, or when the user removes/clears
    // entries from this same component.
    return subscribeRecent(setRecents);
  }, []);

  // Global "focus the search box" hook — fired by the keyboard
  // shortcut handler (`/` or `Cmd/Ctrl+K`). Centralised here rather
  // than reaching into the input from page-level state so consumers
  // don't need a ref forwarded through SearchSidebar.
  useEffect(() => {
    const onFocusSearch = () => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      el.select();
      setOpen(true);
    };
    window.addEventListener("pp:focus-search", onFocusSearch);
    return () => window.removeEventListener("pp:focus-search", onFocusSearch);
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

  /** Hits `/api/incidents/search` with the same time-window the user
   *  has set on the map. We cap the window at 3h for free users so the
   *  search result set matches what the rest of the app shows them
   *  (the time-filter chip already enforces this for the map). */
  const incidentSearch = useCallback((q: string) => {
    if (incidentDebounceRef.current) clearTimeout(incidentDebounceRef.current);
    if (incidentAbortRef.current) {
      incidentAbortRef.current.abort();
      incidentAbortRef.current = null;
    }
    if (q.trim().length < 2) {
      setIncidentResults([]);
      setIncidentTotal(0);
      setIncidentLoading(false);
      return;
    }
    setIncidentLoading(true);
    incidentDebounceRef.current = setTimeout(async () => {
      try {
        const hours = isPro ? timeFilterHours : Math.min(timeFilterHours, FREE_INCIDENT_SEARCH_HOURS);
        const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
        const ctrl = new AbortController();
        incidentAbortRef.current = ctrl;
        const res = await searchIncidentsApi({
          q,
          since,
          city: getCurrentCity().slug,
          limit: 50,
          signal: ctrl.signal,
        });
        if (!ctrl.signal.aborted) {
          setIncidentResults(res.results);
          setIncidentTotal(res.total);
        }
      } catch (err) {
        if ((err as { name?: string })?.name !== "AbortError") {
          setIncidentResults([]);
          setIncidentTotal(0);
        }
      } finally {
        setIncidentLoading(false);
      }
    }, 250);
  }, [isPro, timeFilterHours]);

  // Re-run the active search whenever the mode flips or the user
  // changes the time filter mid-search (so toggling to "Last 24h"
  // immediately broadens an in-flight query without requiring a
  // re-type).
  useEffect(() => {
    if (mode === "incidents" && query.trim().length >= 2) {
      incidentSearch(query);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, timeFilterHours, isPro]);

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
          if (mode === "incidents") incidentSearch(transcript);
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
  }, [voiceActive, geocode, stopVoice, mode, incidentSearch]);

  useEffect(() => () => stopVoice(), [stopVoice]);

  // Pinned Home/Work shortcuts: shown as one-tap-route chips when the
  // search input is focused and empty. Drawn from the user's saved
  // destinations, with `category === "home" | "work"` (set by the Save-as
  // picker in PlaceActions).
  const { destinations } = useSavedDestinations();
  const homePlace = destinations.find((d) => d.category === "home") || null;
  const workPlace = destinations.find((d) => d.category === "work") || null;

  /** O(n) duplicate lookup: a coord within ~1m of any existing save
   *  is treated as already-saved, which gets the bookmark a "filled"
   *  look instead of the empty outline. Tolerance matches the one in
   *  QuickSavePlace so the two components agree. */
  const isAlreadySaved = useCallback(
    (lat: number, lng: number) =>
      destinations.some(
        (d) => Math.abs(d.lat - lat) < 1e-5 && Math.abs(d.lng - lng) < 1e-5
      ),
    [destinations]
  );
  // Peek at the commute prediction so we don't render an empty
  // shortcuts strip when neither Home/Work nor a pattern match is
  // available. Recomputes on a 1-min interval and on history change.
  const [hasPrediction, setHasPrediction] = useState(false);
  useEffect(() => {
    const recompute = () => setHasPrediction(predictNextCommute(destinations) !== null);
    recompute();
    const unsub = subscribeTripHistory(recompute);
    const id = window.setInterval(recompute, 60_000);
    return () => { unsub(); window.clearInterval(id); };
  }, [destinations]);

  // We render the shortcuts row whenever the search is focused with
  // an empty query AND there's at least one chip to show.
  const hasShortcuts = open && query.trim().length < 2 && (homePlace || workPlace || hasPrediction);

  // When typing (≥2 chars), surface matching saved places + recents
  // *above* the geocoded suggestions. Saves a network round-trip for
  // the common case ("home", "work", a favorite shop) and feels much
  // faster than waiting on Nominatim for places the user already has.
  const trimmedQuery = query.trim().toLowerCase();
  const localMatches = (() => {
    if (trimmedQuery.length < 2) return { saved: [], recent: [] as RecentSearch[] };
    const seenKey = new Set<string>();
    const matchSaved = destinations
      .filter((d) =>
        d.name.toLowerCase().includes(trimmedQuery) ||
        // Display label often contains street/neighborhood, useful for
        // "13th st" type partial queries.
        (d.category === "custom" && d.name.toLowerCase().split(",").some((p) => p.trim().startsWith(trimmedQuery)))
      )
      .slice(0, 4)
      .map((d) => {
        const key = `${d.lat.toFixed(4)},${d.lng.toFixed(4)}`;
        seenKey.add(key);
        return d;
      });
    const matchRecent = recents
      .filter((r) => r.display_name.toLowerCase().includes(trimmedQuery))
      // Don't list a recent that's identical to a matched saved place.
      .filter((r) => !seenKey.has(`${r.lat.toFixed(4)},${r.lng.toFixed(4)}`))
      .slice(0, 4);
    return { saved: matchSaved, recent: matchRecent };
  })();

  const showRecents = open && query.trim().length < 2 && recents.length > 0 && mode === "places";
  const showSuggestions = open && mode === "places" && (suggestions.length > 0 || loading) && query.trim().length >= 2;
  const showLocalMatches = open && mode === "places" && trimmedQuery.length >= 2 && (localMatches.saved.length > 0 || localMatches.recent.length > 0);
  const showIncidentResults = open && mode === "incidents" && query.trim().length >= 2;
  const showTabs = open && query.trim().length >= 2;
  const proCappedNotice = mode === "incidents" && !isPro && timeFilterHours > FREE_INCIDENT_SEARCH_HOURS;

  const incidentWindowLabel = (() => {
    const h = isPro ? timeFilterHours : Math.min(timeFilterHours, FREE_INCIDENT_SEARCH_HOURS);
    if (h < 1) return `${Math.round(h * 60)}m`;
    if (h < 24) return `${h}h`;
    if (h % 24 === 0) return `${h / 24}d`;
    return `${h}h`;
  })();

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
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => {
            const v = e.target.value;
            setQuery(v);
            setOpen(true);
            geocode(v);
            if (mode === "incidents") incidentSearch(v);
          }}
          onFocus={() => setOpen(true)}
          placeholder={voiceActive ? "Listening…" : mode === "incidents" ? "Search scanner feed" : "Search CityPulse"}
          className="flex-1 bg-transparent text-sm outline-none"
          style={{ color: "var(--panel-text)" }}
        />
        {query && !voiceActive && (
          <button
            onClick={() => {
              setQuery("");
              setSuggestions([]);
              setIncidentResults([]);
              setIncidentTotal(0);
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

      {showTabs && (
        <div
          className="mt-2 inline-flex rounded-full p-0.5 text-xs"
          style={{
            background: "var(--panel-bg-secondary)",
            border: "1px solid var(--panel-border)",
          }}
          role="tablist"
          aria-label="Search mode"
        >
          <button
            type="button"
            role="tab"
            aria-selected={mode === "places"}
            onClick={() => setMode("places")}
            className="px-3 py-1 rounded-full font-medium transition-colors flex items-center gap-1.5"
            style={{
              background: mode === "places" ? "var(--panel-input-bg)" : "transparent",
              color: mode === "places" ? "var(--panel-text)" : "var(--panel-text-muted)",
            }}
          >
            <MapPin className="w-3 h-3" /> Places
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === "incidents"}
            onClick={() => {
              setMode("incidents");
              if (query.trim().length >= 2) incidentSearch(query);
            }}
            className="px-3 py-1 rounded-full font-medium transition-colors flex items-center gap-1.5"
            style={{
              background: mode === "incidents" ? "var(--panel-input-bg)" : "transparent",
              color: mode === "incidents" ? "var(--panel-text)" : "var(--panel-text-muted)",
            }}
          >
            <Radio className="w-3 h-3" /> Incidents
            <span
              className="ml-1 text-[10px] px-1.5 py-0.5 rounded-full"
              style={{ background: "var(--panel-input-bg)", color: "var(--panel-text-muted)" }}
            >
              {incidentWindowLabel}
            </span>
          </button>
        </div>
      )}

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
          <CommutePredictionPill onPlan={(label, dest) => onDirections(label, dest)} />
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
            const key = `recent-${r.lat},${r.lng}`;
            const expanded = saveTarget === key;
            const saved = isAlreadySaved(r.lat, r.lng);
            return (
              <div key={`${r.lat},${r.lng},${i}`} style={{ borderBottom: "1px solid var(--panel-border)" }}>
                <div
                  onClick={() => handleSelect(r)}
                  className="w-full text-left px-4 py-2.5 flex items-start gap-3 transition-colors cursor-pointer"
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
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setSaveTarget(expanded ? null : key);
                    }}
                    className="shrink-0 mt-1 transition-colors"
                    style={{ color: saved ? "#a855f7" : "var(--panel-text-muted)" }}
                    title={saved ? "Already saved" : "Save place"}
                    aria-label={saved ? `Already saved ${primary}` : `Save ${primary}`}
                    aria-pressed={expanded}
                  >
                    <Bookmark
                      className="w-3.5 h-3.5"
                      {...(saved ? { fill: "currentColor" } : {})}
                    />
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onDirections(primary, { lat: r.lat, lng: r.lng });
                      remember({ display_name: r.display_name, lat: r.lat, lng: r.lng });
                    }}
                    className="text-blue-500/50 hover:text-blue-500 shrink-0 mt-1"
                    title="Get directions"
                    aria-label={`Get directions to ${primary}`}
                  >
                    <Navigation className="w-4 h-4" />
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setRecents(removeRecent(r.lat, r.lng));
                    }}
                    className="text-slate-500 hover:text-rose-400 shrink-0 mt-1 opacity-50 hover:opacity-100 transition-opacity"
                    title="Forget this destination"
                    aria-label={`Remove ${primary} from recents`}
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
                {expanded && (
                  <div className="px-4 pb-2.5">
                    <QuickSavePlace
                      lat={r.lat}
                      lng={r.lng}
                      suggestedName={primary}
                      autoFocus
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Local matches (saved places + recent searches that match the
          current query). Surfaces above geocoded suggestions because
          the user has already proven these are interesting to them. */}
      {showLocalMatches && (
        <div
          className="mt-2 rounded-xl overflow-hidden shadow-lg"
          style={{
            background: "var(--panel-bg-secondary)",
            border: "1px solid var(--panel-border)",
          }}
        >
          <div
            className="px-4 py-1.5 text-[10px] font-semibold uppercase tracking-wider"
            style={{ color: "var(--panel-text-muted)", background: "var(--panel-input-bg)" }}
          >
            From your places
          </div>
          {localMatches.saved.map((d) => (
            <div
              key={`saved-${d.id}`}
              onClick={() => handleSelect({ display_name: d.name, lat: d.lat, lng: d.lng })}
              className="w-full text-left px-4 py-2.5 flex items-start gap-3 last:border-0 transition-colors cursor-pointer"
              style={{ borderBottom: "1px solid var(--panel-border)" }}
              onMouseEnter={(e) => (e.currentTarget.style.background = "var(--panel-hover)")}
              onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
            >
              <div
                className="w-7 h-7 rounded-full flex items-center justify-center shrink-0 mt-0.5"
                style={{ background: "var(--panel-input-bg)" }}
              >
                {d.category === "home"     ? <Home      className="w-3.5 h-3.5 text-emerald-500" /> :
                 d.category === "work"     ? <Briefcase className="w-3.5 h-3.5 text-blue-500" /> :
                 d.category === "favorite" ? <Star      className="w-3.5 h-3.5 text-amber-500" /> :
                                             <MapPin    className="w-3.5 h-3.5 text-slate-500" />}
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm truncate" style={{ color: "var(--panel-text)" }}>{d.name}</p>
                <p className="text-[11px] mt-0.5" style={{ color: "var(--panel-text-muted)" }}>
                  Saved · {d.category}
                </p>
              </div>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onDirections(d.name, { lat: d.lat, lng: d.lng });
                }}
                className="ml-auto text-blue-500/60 hover:text-blue-500 shrink-0 mt-1"
                title="Get directions"
                aria-label={`Get directions to ${d.name}`}
              >
                <Navigation className="w-4 h-4" />
              </button>
            </div>
          ))}
          {localMatches.recent.map((r) => {
            const parts = r.display_name.split(",");
            const primary = parts[0].trim();
            const secondary = parts.slice(1, 3).map((p) => p.trim()).join(", ");
            return (
              <div
                key={`r-${r.lat},${r.lng}`}
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
                    <p className="text-[11px] mt-0.5 truncate" style={{ color: "var(--panel-text-muted)" }}>
                      Recent · {secondary}
                    </p>
                  )}
                </div>
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
            const key = `suggest-${i}`;
            const expanded = saveTarget === key;
            const saved = isAlreadySaved(s.lat, s.lng);
            return (
              <div key={i} style={{ borderBottom: "1px solid var(--panel-border)" }}>
                <div
                  onClick={() => handleSelect(s)}
                  className="w-full text-left px-4 py-3 flex items-start gap-3 transition-colors cursor-pointer"
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
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setSaveTarget(expanded ? null : key);
                    }}
                    className="shrink-0 mt-1 transition-colors"
                    style={{ color: saved ? "#a855f7" : "var(--panel-text-muted)" }}
                    title={saved ? "Already saved" : "Save place"}
                    aria-label={saved ? `Already saved ${primary}` : `Save ${primary}`}
                    aria-pressed={expanded}
                  >
                    <Bookmark
                      className="w-4 h-4"
                      {...(saved ? { fill: "currentColor" } : {})}
                    />
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onDirections(primary, s);
                      remember(s);
                    }}
                    className="text-blue-500/50 hover:text-blue-500 shrink-0 mt-1"
                    title="Get directions"
                    aria-label={`Get directions to ${primary}`}
                  >
                    <Navigation className="w-4 h-4" />
                  </button>
                </div>
                {expanded && (
                  <div className="px-4 pb-3">
                    <QuickSavePlace
                      lat={s.lat}
                      lng={s.lng}
                      suggestedName={primary}
                      autoFocus
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {showIncidentResults && (
        <div
          className="mt-2 rounded-xl overflow-hidden shadow-lg"
          style={{
            background: "var(--panel-bg-secondary)",
            border: "1px solid var(--panel-border)",
          }}
        >
          <div
            className="flex items-center justify-between px-4 py-2 text-[10px] font-semibold uppercase tracking-wider"
            style={{ color: "var(--panel-text-muted)", borderBottom: "1px solid var(--panel-border)" }}
          >
            <span className="flex items-center gap-1.5">
              <Radio className="w-3 h-3" /> Scanner — last {incidentWindowLabel}
            </span>
            {!incidentLoading && (
              <span style={{ color: "var(--panel-text-muted)" }}>
                {incidentTotal} match{incidentTotal === 1 ? "" : "es"}
              </span>
            )}
          </div>
          {proCappedNotice && (
            <div
              className="px-4 py-2 text-[11px] flex items-center gap-1.5"
              style={{
                background: "rgba(245,158,11,0.08)",
                color: "#d97706",
                borderBottom: "1px solid var(--panel-border)",
              }}
            >
              <Lock className="w-3 h-3" />
              Free tier searches the last 3h. Pro searches your full {timeFilterHours}h window.
            </div>
          )}
          {incidentLoading && incidentResults.length === 0 && (
            <div className="px-4 py-3 flex items-center gap-3">
              <Loader2 className="w-4 h-4 animate-spin" style={{ color: "var(--panel-text-muted)" }} />
              <span className="text-xs" style={{ color: "var(--panel-text-muted)" }}>
                Searching scanner feed…
              </span>
            </div>
          )}
          {!incidentLoading && incidentResults.length === 0 && (
            <div className="px-4 py-3 text-xs" style={{ color: "var(--panel-text-muted)" }}>
              No incidents matching “{query.trim()}” in the last {incidentWindowLabel}.
            </div>
          )}
          {incidentResults.slice(0, 12).map((inc) => {
            const when = inc.last_mention_at || inc.reported_at;
            const ageMs = when ? Date.now() - new Date(when).getTime() : 0;
            const ageMin = Math.max(0, Math.round(ageMs / 60000));
            const ageLabel =
              ageMin < 1 ? "just now" :
              ageMin < 60 ? `${ageMin}m ago` :
              ageMin < 1440 ? `${Math.round(ageMin / 60)}h ago` :
              `${Math.round(ageMin / 1440)}d ago`;
            const snippet = (inc.description || inc.raw_text || "").slice(0, 120);
            return (
              <div
                key={inc.id}
                onClick={() => {
                  onSelectIncident?.(inc.id);
                  if (inc.lat != null && inc.lng != null) onFlyTo(inc.lat, inc.lng);
                  setOpen(false);
                }}
                className="w-full text-left px-4 py-3 flex items-start gap-3 last:border-0 transition-colors cursor-pointer"
                style={{ borderBottom: "1px solid var(--panel-border)" }}
                onMouseEnter={(e) => (e.currentTarget.style.background = "var(--panel-hover)")}
                onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
              >
                <div
                  className="w-8 h-8 rounded-full flex items-center justify-center shrink-0 mt-0.5"
                  style={{ background: "var(--panel-input-bg)" }}
                >
                  <Radio className="w-4 h-4" style={{ color: "var(--panel-text-muted)" }} />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium truncate" style={{ color: "var(--panel-text)" }}>
                    <span className="capitalize">{inc.severity_category}</span>
                    {inc.location_text ? ` · ${inc.location_text}` : ""}
                  </p>
                  {snippet && (
                    <p className="text-xs mt-0.5 line-clamp-2" style={{ color: "var(--panel-text-muted)" }}>
                      {snippet}
                    </p>
                  )}
                  <p className="text-[10px] mt-0.5" style={{ color: "var(--panel-text-muted)" }}>
                    {ageLabel}
                    {inc.mention_count && inc.mention_count > 1 ? ` · +${inc.mention_count - 1} upd` : ""}
                    {inc.feed_id ? ` · ${inc.feed_id}` : ""}
                  </p>
                </div>
              </div>
            );
          })}
          {incidentTotal > 12 && (
            <div
              className="px-4 py-2 text-[11px]"
              style={{ color: "var(--panel-text-muted)", borderTop: "1px solid var(--panel-border)" }}
            >
              Showing first 12 of {incidentTotal}. Refine your query for more.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
