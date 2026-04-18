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
const TTL_MS = 24 * 60 * 60 * 1000; // 24h sliding window

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
    const cutoff = Date.now() - TTL_MS;
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
