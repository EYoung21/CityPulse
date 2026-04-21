import { isCategoryMuted } from "@/lib/alert-mutes";

/** localStorage-backed log of alert surfaces (off-screen incidents,
 *  incident-ahead, etc.) so the user has a persistent inbox to scroll
 *  through after the ephemeral chips disappear. Capped to keep storage
 *  small — alerts are interesting in the moment but stale after a day.
 *
 *  We deliberately don't persist *every* incident the backend produces;
 *  only the ones that were surfaced to the user as an alert (chip,
 *  notification, etc.). Otherwise the inbox is just a duplicate of the
 *  feed. */

const KEY = "pp:alerts-inbox-v1";
const MAX_ENTRIES = 50;
/** Sliding TTL for free users. Matches the original 24h cap — the
 *  inbox only contains alerts the user was *already shown* in-app, so
 *  there's no info-leak parity argument for tightening this further.
 *  Pro just gets a much longer scrollback. */
const FREE_TTL_MS = 24 * 60 * 60 * 1000;
/** Pro users get the full retention window. We cap at 6 months
 *  matching the map's existing 6mo Pro filter ceiling — beyond that
 *  storage starts to feel unbounded for what is, after all, just an
 *  alerts log. */
const PRO_TTL_MS = 6 * 30 * 24 * 60 * 60 * 1000;

function currentTier(): "free" | "pro" | "enterprise" {
  if (typeof window === "undefined") return "free";
  try {
    const t = window.localStorage.getItem("pp:tier");
    if (t === "pro" || t === "enterprise") return t;
  } catch {
    /* ignore */
  }
  return "free";
}

function ttlForCurrentTier(): number {
  return currentTier() === "free" ? FREE_TTL_MS : PRO_TTL_MS;
}

export interface InboxAlert {
  /** Stable id — usually the incident id, suffixed with the alert kind
   *  so the same incident can fire both an off-screen alert and an
   *  incident-ahead alert without one overwriting the other. */
  id: string;
  incidentId: string;
  kind: "offscreen" | "ahead" | "background";
  title: string;
  body: string;
  /** Severity category from the underlying incident, used to color the
   *  inbox row. Resolved through getSeverity() at render time so the
   *  color-blind palette toggle just works. */
  category: string;
  lat: number;
  lng: number;
  ts: number;
  read: boolean;
}

type Listener = (alerts: InboxAlert[]) => void;
const listeners = new Set<Listener>();

function read(): InboxAlert[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as InboxAlert[];
    if (!Array.isArray(parsed)) return [];
    const cutoff = Date.now() - ttlForCurrentTier();
    return parsed.filter((a) => a && typeof a.ts === "number" && a.ts >= cutoff);
  } catch {
    return [];
  }
}

function write(alerts: InboxAlert[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(alerts.slice(0, MAX_ENTRIES)));
  } catch {
    /* storage full / blocked — non-fatal */
  }
  for (const fn of listeners) {
    try { fn(alerts); } catch { /* ignore single bad subscriber */ }
  }
}

export function getAlerts(): InboxAlert[] {
  return read();
}

export function recordAlert(a: Omit<InboxAlert, "ts" | "read">): void {
  // Per-category mute gate: if the user has explicitly silenced this
  // incident type, drop the entry on the floor — don't even log it
  // to the inbox. The mute is about "stop interrupting me", and a
  // pile of muted-but-still-listed entries would force the user to
  // dismiss noise they already opted out of.
  if (isCategoryMuted(a.category)) return;

  const existing = read();
  // Dedupe — if we already have this exact id within the TTL, just bump
  // its timestamp so it floats to the top instead of stacking duplicates.
  const filtered = existing.filter((x) => x.id !== a.id);
  filtered.unshift({ ...a, ts: Date.now(), read: false });
  write(filtered);
}

export function markRead(id: string): void {
  const next = read().map((a) => (a.id === id ? { ...a, read: true } : a));
  write(next);
}

export function markAllRead(): void {
  const next = read().map((a) => ({ ...a, read: true }));
  write(next);
}

export function clearAlerts(): void {
  write([]);
}

export function unreadCount(): number {
  return read().reduce((n, a) => n + (a.read ? 0 : 1), 0);
}

/** Subscribe to inbox changes — used by the bell button to keep its
 *  unread badge in sync without polling. Returns an unsub. */
export function subscribeAlerts(fn: Listener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

// When the tier changes mid-session (Stripe webhook + Firestore round
// trip), re-broadcast the (now-pruned) alert list so badge counts and
// the inbox view shrink without requiring a refresh.
if (typeof window !== "undefined") {
  window.addEventListener("pp:tier-changed", () => {
    const next = read();
    for (const fn of listeners) {
      try { fn(next); } catch { /* ignore single bad subscriber */ }
    }
  });
}
