"use client";

/** Centralised TTS queue for navigation announcements.
 *
 *  ManeuverChip already speaks individual turn instructions inline,
 *  but as we add more voice surface area (departure summary, arrival
 *  confirmation, incident-ahead alerts, off-route hints…) we need a
 *  single place that:
 *
 *    - Respects the global mute pref (`pp:voice-nav-enabled`)
 *    - Coalesces overlapping speak() calls so we don't talk over
 *      ourselves (a turn announcement at the same time as an incident
 *      alert should not sound like two voices arguing)
 *    - De-dupes phrases for a configurable window so a polled
 *      "incident ahead" check doesn't repeat the same warning every
 *      second
 *    - Categorizes utterances by priority so a turn instruction can
 *      pre-empt a low-priority chime
 *
 *  Usage:
 *      speakNav("Now, turn left onto Market", { priority: "turn" });
 *      speakNav("Caution, incident reported ahead", {
 *        priority: "alert", dedupeKey: `incident-${id}`, dedupeMs: 30_000,
 *      });
 *
 *  The actual SpeechSynthesis call is best-effort — we swallow errors
 *  silently because nothing in the navigation flow should break if the
 *  user denied speech permission or is on an obscure browser.
 */

export type VoiceNavPriority =
  /** Turn-by-turn maneuver — highest priority, cancels everything else. */
  | "turn"
  /** Incident / safety alerts — medium priority. */
  | "alert"
  /** Trip-level events (departure, arrival, ETA changes). */
  | "info";

const PREF_KEY = "pp:voice-nav-enabled";
const recentlySpoken = new Map<string, number>();

export function isVoiceNavEnabled(): boolean {
  if (typeof window === "undefined") return false;
  // Default ON — the mute toggle in ManeuverChip writes "off" when
  // disabled. Anything else is treated as enabled.
  try { return window.localStorage.getItem(PREF_KEY) !== "off"; }
  catch { return true; }
}

export function isVoiceNavSupported(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window;
}

interface SpeakOptions {
  priority?: VoiceNavPriority;
  /** Suppress this exact key for `dedupeMs` after speaking. */
  dedupeKey?: string;
  dedupeMs?: number;
  /** Speech rate multiplier. Default 1. Alerts use 1.05 so they cut
   *  through the ambient car noise more cleanly. */
  rate?: number;
}

/** Speak `text` if voice nav is enabled. Safe to call from anywhere
 *  in the client; no-op on the server. */
export function speakNav(text: string, opts: SpeakOptions = {}): void {
  if (!isVoiceNavSupported() || !isVoiceNavEnabled()) return;
  const priority: VoiceNavPriority = opts.priority ?? "info";

  // De-dupe by key+window. Falling outside the window or providing a
  // distinct key forces a fresh utterance.
  if (opts.dedupeKey) {
    const last = recentlySpoken.get(opts.dedupeKey);
    const now = Date.now();
    if (last && now - last < (opts.dedupeMs ?? 30_000)) return;
    recentlySpoken.set(opts.dedupeKey, now);
    // Trim the dedupe map periodically so it doesn't grow without bound.
    if (recentlySpoken.size > 50) {
      for (const [k, t] of recentlySpoken) {
        if (now - t > 5 * 60_000) recentlySpoken.delete(k);
      }
    }
  }

  try {
    const synth = window.speechSynthesis;
    // Turn instructions and alerts pre-empt anything currently
    // queued. Info-level utterances queue normally so a departure
    // summary doesn't get cut off by a passive ETA update half a
    // second later.
    if (priority === "turn" || priority === "alert") {
      synth.cancel();
    }
    const u = new SpeechSynthesisUtterance(text);
    u.rate = opts.rate ?? (priority === "alert" ? 1.05 : 1);
    u.pitch = 1;
    u.volume = 1;
    u.lang = "en-US";
    synth.speak(u);
  } catch {
    /* synth disabled; ignore */
  }
}

/** Stop everything immediately — useful when a trip ends so a queued
 *  "in 200 meters" doesn't speak after the user has already arrived. */
export function cancelVoiceNav(): void {
  if (!isVoiceNavSupported()) return;
  try { window.speechSynthesis.cancel(); } catch { /* ignore */ }
  recentlySpoken.clear();
}

/** Format a distance (meters) into a human-spoken phrase that respects
 *  the user's `pp:units` preference. Round to a coarse value so we
 *  don't speak distractingly precise numbers like "473 meters". */
export function speakableDistance(meters: number): string {
  if (typeof window === "undefined") return `${Math.round(meters)} meters`;
  const useImperial = (() => {
    try { return window.localStorage.getItem("pp:units") === "imperial"; }
    catch { return false; }
  })();
  if (useImperial) {
    const feet = meters * 3.28084;
    if (feet < 528) {
      const rounded = Math.round(feet / 50) * 50;
      return `${rounded} feet`;
    }
    const miles = meters / 1609.34;
    if (miles < 0.2) return "a tenth of a mile";
    if (miles < 0.6) return "a quarter mile";
    if (miles < 1.1) return `${miles.toFixed(1)} miles`;
    return `${miles.toFixed(miles < 10 ? 1 : 0)} miles`;
  }
  if (meters < 80) {
    const rounded = Math.round(meters / 10) * 10;
    return `${rounded} meters`;
  }
  if (meters < 1000) {
    const rounded = Math.round(meters / 50) * 50;
    return `${rounded} meters`;
  }
  const km = meters / 1000;
  return `${km.toFixed(km < 10 ? 1 : 0)} kilometers`;
}
