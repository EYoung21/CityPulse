export interface SeverityConfig {
  label: string;
  color: string;
  bgClass: string;
  textClass: string;
  markerColor: string;
}

export const SEVERITY_MAP: Record<string, SeverityConfig> = {
  violent_weapon: {
    label: "Violent (Weapon)",
    color: "#ef4444",
    bgClass: "bg-red-500/20",
    textClass: "text-red-400",
    markerColor: "#dc2626",
  },
  violent_no_weapon: {
    label: "Violent",
    color: "#f87171",
    bgClass: "bg-red-400/20",
    textClass: "text-red-300",
    markerColor: "#ef4444",
  },
  shots_heard: {
    label: "Shots Fired",
    color: "#ef4444",
    bgClass: "bg-red-500/20",
    textClass: "text-red-400",
    markerColor: "#dc2626",
  },
  robbery: {
    label: "Robbery",
    color: "#f97316",
    bgClass: "bg-orange-500/20",
    textClass: "text-orange-400",
    markerColor: "#ea580c",
  },
  burglary_in_progress: {
    label: "Burglary",
    color: "#f97316",
    bgClass: "bg-orange-500/20",
    textClass: "text-orange-400",
    markerColor: "#ea580c",
  },
  medical_priority: {
    label: "Medical (Priority)",
    color: "#3b82f6",
    bgClass: "bg-blue-500/20",
    textClass: "text-blue-400",
    markerColor: "#2563eb",
  },
  medical_other: {
    label: "Medical",
    color: "#60a5fa",
    bgClass: "bg-blue-400/20",
    textClass: "text-blue-300",
    markerColor: "#3b82f6",
  },
  fire_hazmat: {
    label: "Fire / Hazmat",
    color: "#f59e0b",
    bgClass: "bg-amber-500/20",
    textClass: "text-amber-400",
    markerColor: "#d97706",
  },
  traffic_crash_injury: {
    label: "Crash (Injuries)",
    color: "#eab308",
    bgClass: "bg-yellow-500/20",
    textClass: "text-yellow-400",
    markerColor: "#ca8a04",
  },
  traffic_crash_no_injury: {
    label: "Crash",
    color: "#a3a3a3",
    bgClass: "bg-neutral-500/20",
    textClass: "text-neutral-400",
    markerColor: "#737373",
  },
  disorder: {
    label: "Disorder",
    color: "#a78bfa",
    bgClass: "bg-violet-400/20",
    textClass: "text-violet-400",
    markerColor: "#7c3aed",
  },
  admin_or_noise: {
    label: "Admin",
    color: "#525252",
    bgClass: "bg-neutral-600/20",
    textClass: "text-neutral-500",
    markerColor: "#525252",
  },
  // ---------- Crowdsourced (user-submitted) reports ----------
  // Slightly desaturated relative to the official scanner-derived
  // categories so the eye can tell them apart at a glance, but still
  // colour-coded by class (hazard/crash → red-orange, police → blue,
  // disorder → violet) so they fit the rest of the legend.
  user_hazard: {
    label: "User: Hazard",
    color: "#fb923c",
    bgClass: "bg-orange-500/15",
    textClass: "text-orange-300",
    markerColor: "#f97316",
  },
  user_crash: {
    label: "User: Crash",
    color: "#facc15",
    bgClass: "bg-yellow-500/15",
    textClass: "text-yellow-300",
    markerColor: "#eab308",
  },
  user_police: {
    label: "User: Police",
    color: "#60a5fa",
    bgClass: "bg-blue-500/15",
    textClass: "text-blue-300",
    markerColor: "#3b82f6",
  },
  user_disorder: {
    label: "User: Disorder",
    color: "#c084fc",
    bgClass: "bg-violet-500/15",
    textClass: "text-violet-300",
    markerColor: "#a855f7",
  },
  user_other: {
    label: "User: Other",
    color: "#94a3b8",
    bgClass: "bg-slate-500/15",
    textClass: "text-slate-300",
    markerColor: "#64748b",
  },
};

/* ----------------------------------------------------------------------
 *  Color-blind-safe palette (IBM-derived: blue/orange/yellow/purple/grey
 *  pairs that are distinguishable across protan/deutan/tritanopia). The
 *  shape mirrors SEVERITY_MAP exactly, so consumers don't need to special
 *  case anything — they read whatever `getSeverity()` returns. The toggle
 *  is a runtime flag set from the Theme menu and persisted to localStorage.
 * ---------------------------------------------------------------------- */
const CB_SEVERITY_MAP: Record<string, SeverityConfig> = {
  violent_weapon: {
    label: "Violent (Weapon)",
    color: "#dc267f",
    bgClass: "bg-pink-500/20",
    textClass: "text-pink-300",
    markerColor: "#b8175f",
  },
  violent_no_weapon: {
    label: "Violent",
    color: "#dc267f",
    bgClass: "bg-pink-500/20",
    textClass: "text-pink-300",
    markerColor: "#b8175f",
  },
  shots_heard: {
    label: "Shots Fired",
    color: "#dc267f",
    bgClass: "bg-pink-500/20",
    textClass: "text-pink-300",
    markerColor: "#b8175f",
  },
  robbery: {
    label: "Robbery",
    color: "#fe6100",
    bgClass: "bg-orange-500/20",
    textClass: "text-orange-300",
    markerColor: "#cc4f00",
  },
  burglary_in_progress: {
    label: "Burglary",
    color: "#fe6100",
    bgClass: "bg-orange-500/20",
    textClass: "text-orange-300",
    markerColor: "#cc4f00",
  },
  medical_priority: {
    label: "Medical (Priority)",
    color: "#648fff",
    bgClass: "bg-blue-500/20",
    textClass: "text-blue-300",
    markerColor: "#4571d4",
  },
  medical_other: {
    label: "Medical",
    color: "#85a5ff",
    bgClass: "bg-blue-400/20",
    textClass: "text-blue-300",
    markerColor: "#648fff",
  },
  fire_hazmat: {
    label: "Fire / Hazmat",
    color: "#ffb000",
    bgClass: "bg-amber-500/20",
    textClass: "text-amber-300",
    markerColor: "#cc8a00",
  },
  traffic_crash_injury: {
    label: "Crash (Injuries)",
    color: "#ffb000",
    bgClass: "bg-amber-500/20",
    textClass: "text-amber-300",
    markerColor: "#cc8a00",
  },
  traffic_crash_no_injury: {
    label: "Crash",
    color: "#a3a3a3",
    bgClass: "bg-neutral-500/20",
    textClass: "text-neutral-400",
    markerColor: "#737373",
  },
  disorder: {
    label: "Disorder",
    color: "#785ef0",
    bgClass: "bg-violet-400/20",
    textClass: "text-violet-300",
    markerColor: "#5c44c4",
  },
  admin_or_noise: {
    label: "Admin",
    color: "#525252",
    bgClass: "bg-neutral-600/20",
    textClass: "text-neutral-500",
    markerColor: "#525252",
  },
  // Crowdsourced report colors in the CB palette: keep them
  // distinguishable from each other while staying inside the
  // protan/deutan/tritan-safe axes the rest of CB uses.
  user_hazard: {
    label: "User: Hazard",
    color: "#fe6100",
    bgClass: "bg-orange-500/15",
    textClass: "text-orange-300",
    markerColor: "#cc4f00",
  },
  user_crash: {
    label: "User: Crash",
    color: "#ffb000",
    bgClass: "bg-amber-500/15",
    textClass: "text-amber-300",
    markerColor: "#cc8a00",
  },
  user_police: {
    label: "User: Police",
    color: "#648fff",
    bgClass: "bg-blue-500/15",
    textClass: "text-blue-300",
    markerColor: "#4571d4",
  },
  user_disorder: {
    label: "User: Disorder",
    color: "#785ef0",
    bgClass: "bg-violet-500/15",
    textClass: "text-violet-300",
    markerColor: "#5c44c4",
  },
  user_other: {
    label: "User: Other",
    color: "#a3a3a3",
    bgClass: "bg-neutral-500/15",
    textClass: "text-neutral-400",
    markerColor: "#737373",
  },
};

let _colorBlindMode = false;

/** Re-export to consumers who want to read the flag without subscribing
 *  (e.g. server-rendered surfaces that always use the default palette). */
export function getColorBlindMode(): boolean {
  return _colorBlindMode;
}

const cbListeners = new Set<() => void>();

/** Flip the global palette and notify all subscribed consumers so they
 *  re-render. Call from the Theme menu / settings UI. */
export function setColorBlindMode(on: boolean): void {
  if (_colorBlindMode === on) return;
  _colorBlindMode = on;
  for (const fn of cbListeners) {
    try { fn(); } catch { /* a single bad subscriber shouldn't kill the rest */ }
  }
}

/** Subscribe to palette changes — used by the React hook below to force
 *  a re-render whenever someone toggles the setting. Returns an unsub. */
export function subscribeColorBlindMode(fn: () => void): () => void {
  cbListeners.add(fn);
  return () => { cbListeners.delete(fn); };
}

export function getSeverity(category: string): SeverityConfig {
  const map = _colorBlindMode ? CB_SEVERITY_MAP : SEVERITY_MAP;
  return (
    map[category] || {
      label: category.replace(/_/g, " "),
      color: "#6b7280",
      bgClass: "bg-neutral-500/20",
      textClass: "text-neutral-400",
      markerColor: "#6b7280",
    }
  );
}

/* ----------------------------------------------------------------------
 *  Bucketed severity classification, used by the heatmap intensity
 *  weighting (so violent incidents dominate the hotspots over chatter)
 *  and any future per-bucket styling. The keys cover all values produced
 *  by the backend's classifier (`philly_pulse/server.py`).
 * ---------------------------------------------------------------------- */

export type SeverityBucket = "violent" | "fire" | "medical" | "property" | "traffic" | "other";

const BUCKETS: Record<string, SeverityBucket> = {
  violent_weapon:        "violent",
  violent_no_weapon:     "violent",
  shots_heard:           "violent",
  robbery:               "violent",
  burglary_in_progress:  "violent",

  fire_hazmat:           "fire",

  medical_priority:      "medical",
  medical_other:         "medical",

  burglary:              "property",
  theft:                 "property",
  vandalism:             "property",
  disorder:              "property",

  traffic_crash_injury:    "traffic",
  traffic_crash_no_injury: "traffic",
  traffic_accident:        "traffic",
  traffic_hazard:          "traffic",

  // User reports — bucketed conservatively so they nudge the heatmap
  // without dominating it. "Other" is the floor weight, which is
  // intentional for the catch-all category.
  user_hazard:   "traffic",
  user_crash:    "traffic",
  user_police:   "other",
  user_disorder: "property",
  user_other:    "other",
};

export function severityBucket(category: string | null | undefined): SeverityBucket {
  if (!category) return "other";
  return BUCKETS[category] ?? "other";
}

/** Multiplier applied to the per-incident heatmap weight so that serious
 *  events dominate the visual hotspots over chatter. Tuned so that a
 *  baseline `w_eff` of ~0.5 stays in the warm-band (yellow/orange) while
 *  a violent incident of the same age pushes into the red band. */
export const SEVERITY_HEAT_MULTIPLIER: Record<SeverityBucket, number> = {
  violent:  1.5,
  fire:     1.25,
  medical:  1.1,
  property: 0.9,
  traffic:  0.75,
  other:    0.65,
};

/** Convenience: pre-clamped per-incident heatmap intensity. */
export function heatmapWeight(category: string | null | undefined, baseWeight: number): number {
  const m = SEVERITY_HEAT_MULTIPLIER[severityBucket(category)];
  return Math.min(1, Math.max(0.18, baseWeight * m));
}
