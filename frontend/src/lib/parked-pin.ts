/** localStorage-backed "I parked here" pin. Persists across sessions
 *  so a user can drop the pin in the morning and walk back to it
 *  hours later, even after closing the tab.
 *
 *  Auto-expires after 24 hours — anything older is almost certainly
 *  stale (you'd have moved the car by then), and clearing it on
 *  rehydrate keeps the UI honest. */

const KEY = "pp:parked-pin-v1";
const TTL_MS = 24 * 60 * 60 * 1000;

export interface ParkedPin {
  lat: number;
  lng: number;
  /** Optional user note ("4th floor, B level", "near red doors"). */
  note?: string;
  /** Display label shown next to the pin — usually the reverse-geocoded
   *  street name when available, falls back to "Parked here". */
  label?: string;
  ts: number;
}

type Listener = (pin: ParkedPin | null) => void;
const listeners = new Set<Listener>();

function read(): ParkedPin | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ParkedPin;
    if (!parsed || typeof parsed.lat !== "number" || typeof parsed.lng !== "number") return null;
    if (Date.now() - parsed.ts > TTL_MS) {
      // Expired — clear it so subsequent reads stay consistent.
      window.localStorage.removeItem(KEY);
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function write(pin: ParkedPin | null): void {
  if (typeof window === "undefined") return;
  try {
    if (pin) window.localStorage.setItem(KEY, JSON.stringify(pin));
    else     window.localStorage.removeItem(KEY);
  } catch {
    /* storage blocked — best effort */
  }
  for (const fn of listeners) {
    try { fn(pin); } catch { /* ignore single bad subscriber */ }
  }
}

export function getParkedPin(): ParkedPin | null {
  return read();
}

export function setParkedPin(pin: Omit<ParkedPin, "ts"> | null): ParkedPin | null {
  if (!pin) { write(null); return null; }
  const next: ParkedPin = { ...pin, ts: Date.now() };
  write(next);
  return next;
}

export function updateParkedNote(note: string): void {
  const cur = read();
  if (!cur) return;
  write({ ...cur, note });
}

export function clearParkedPin(): void {
  write(null);
}

export function subscribeParkedPin(fn: Listener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** Approximate walking distance in meters from `from` to the parked
 *  pin via the haversine formula. Good enough for a "you're 240m
 *  away" hint — proper routing distance is computed lazily by the
 *  caller via the standard routing pipeline when the user actually
 *  taps "Walk back". */
export function distanceToParkedM(from: { lat: number; lng: number }, pin: ParkedPin): number {
  const R = 6_371_000; // meters
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(pin.lat - from.lat);
  const dLng = toRad(pin.lng - from.lng);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(from.lat)) * Math.cos(toRad(pin.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
