"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { Search, X, MapPin, Shield } from "lucide-react";
import { geocodePhilly, assessSafety, type SafetyResult } from "@/lib/search";
import type { Incident } from "@/lib/api";

interface Props {
  incidents: Incident[];
  onFlyTo: (lat: number, lng: number) => void;
}

export default function SearchBar({ incidents, onFlyTo }: Props) {
  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState<
    { display_name: string; lat: number; lng: number }[]
  >([]);
  const [safetyResult, setSafetyResult] = useState<SafetyResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setSuggestions([]);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const handleInput = useCallback(
    (value: string) => {
      setQuery(value);
      setSafetyResult(null);

      if (debounceRef.current) clearTimeout(debounceRef.current);

      if (value.trim().length < 3) {
        setSuggestions([]);
        return;
      }

      debounceRef.current = setTimeout(async () => {
        const results = await geocodePhilly(value);
        setSuggestions(results);
      }, 400);
    },
    []
  );

  const handleSelect = useCallback(
    (item: { display_name: string; lat: number; lng: number }) => {
      setLoading(true);
      setSuggestions([]);
      setQuery(item.display_name.split(",")[0]);

      const safety = assessSafety(
        { display_name: item.display_name, lat: item.lat, lng: item.lng },
        incidents
      );
      setSafetyResult(safety);
      onFlyTo(item.lat, item.lng);
      setLoading(false);
    },
    [incidents, onFlyTo]
  );

  const clear = () => {
    setQuery("");
    setSuggestions([]);
    setSafetyResult(null);
  };

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="bg-card/90 backdrop-blur-sm border border-border/50 rounded-lg px-3 py-2 flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
      >
        <Search className="w-4 h-4" />
        <span className="hidden sm:inline">Is my area safe?</span>
      </button>
    );
  }

  return (
    <div ref={containerRef} className="relative w-64 sm:w-80">
      <div className="flex items-center bg-card/95 backdrop-blur-sm border border-border/50 rounded-lg px-3 py-1.5 gap-2">
        <Search className="w-4 h-4 text-muted-foreground shrink-0" />
        <input
          autoFocus
          type="text"
          value={query}
          onChange={(e) => handleInput(e.target.value)}
          placeholder="Search neighborhood or address..."
          className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground/60"
        />
        {(query || safetyResult) && (
          <button onClick={clear} className="text-muted-foreground hover:text-foreground">
            <X className="w-4 h-4" />
          </button>
        )}
        {!query && !safetyResult && (
          <button
            onClick={() => setOpen(false)}
            className="text-muted-foreground hover:text-foreground"
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </div>

      {suggestions.length > 0 && (
        <div className="absolute top-full left-0 right-0 mt-1 bg-card/95 backdrop-blur-sm border border-border/50 rounded-lg overflow-hidden z-50 shadow-lg">
          {suggestions.map((s, i) => (
            <button
              key={i}
              onClick={() => handleSelect(s)}
              className="w-full text-left px-3 py-2 text-sm hover:bg-accent/50 flex items-start gap-2 border-b border-border/20 last:border-0"
            >
              <MapPin className="w-3.5 h-3.5 mt-0.5 shrink-0 text-muted-foreground" />
              <span className="line-clamp-2">{s.display_name}</span>
            </button>
          ))}
        </div>
      )}

      {safetyResult && (
        <div className="absolute top-full left-0 right-0 mt-1 bg-card/95 backdrop-blur-sm border border-border/50 rounded-lg p-3 z-50 shadow-lg space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">
              {safetyResult.location.display_name.split(",")[0]}
            </span>
            <span
              className="text-xs font-bold uppercase px-2 py-0.5 rounded-full"
              style={{
                backgroundColor: safetyResult.riskColor + "20",
                color: safetyResult.riskColor,
              }}
            >
              {safetyResult.riskLevel} risk
            </span>
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Shield className="w-3.5 h-3.5" />
            <span>
              {safetyResult.nearbyCount === 0
                ? "No incidents within 1km in recent hours"
                : `${safetyResult.nearbyCount} incident${safetyResult.nearbyCount > 1 ? "s" : ""} within 1km`}
            </span>
          </div>
          {loading && (
            <div className="text-xs text-muted-foreground animate-pulse">
              Analyzing...
            </div>
          )}
        </div>
      )}
    </div>
  );
}
