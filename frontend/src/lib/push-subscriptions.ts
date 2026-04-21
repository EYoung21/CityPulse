"use client";

/** Server-backed Web Push (VAPID) subscription manager.
 *
 *  Coordinates the three moving parts of a real push subscription:
 *
 *    1. Browser permission (Notification API) — same prompt as the
 *       in-tab notifications, but `pushManager.subscribe` requires
 *       it before it'll hand back a subscription.
 *    2. Service worker pushManager subscription — opaque endpoint
 *       URL + a pair of base64url crypto keys the server uses to
 *       sign the actual push.
 *    3. Backend mirror — POSTed to /api/push/subscribe so the
 *       server can fan out alerts when the tab is closed.
 *
 *  Public API:
 *    - getPushStatus(): inspect what's already wired up
 *    - subscribePush(): walk the user through the full flow
 *    - unsubscribePush(): remove from browser AND server in one go
 *    - sendTestPush(): kick off a server-side ping for verification
 *
 *  Deliberately silent on iOS Safari < 16.4 (no Push API) — every
 *  call returns the appropriate "unsupported" status so the UI can
 *  hide the affordance instead of throwing.
 */

import { getAuth } from "firebase/auth";
import { getFirebaseApp, isFirebaseConfigured } from "@/lib/firebase";
import { getCurrentCity } from "@/lib/pulse-cities";

const API_BASE = process.env.NEXT_PUBLIC_API_URL || "";

export interface PushStatus {
  supported: boolean;
  permission: NotificationPermission | "unsupported";
  /** True when there's a live PushSubscription registered with the
   *  service worker. Doesn't guarantee the backend knows about it
   *  — that's `serverConfigured` below. */
  subscribed: boolean;
  /** Whether the *server* has VAPID keys + pywebpush set up. We
   *  fetch this once on demand. Off → the subscribe flow won't
   *  push to the server (nothing to push to). */
  serverConfigured: boolean;
  /** The browser-supplied endpoint URL of the current subscription.
   *  Useful for showing "1 device subscribed" without leaking the
   *  full URL into the UI. */
  endpoint: string | null;
  /** Why the user isn't subscribed yet, when applicable, so the
   *  caller can render a contextual help string. */
  reason?:
    | "permission-denied"
    | "permission-default"
    | "no-server-key"
    | "no-account"
    | "no-service-worker"
    | "unsupported";
}

export type SubscribeResult =
  | { ok: true; status: PushStatus }
  | { ok: false; reason: string; status: PushStatus };

const VAPID_PUBLIC_KEY_CACHE: { key: string | null; configured: boolean | null } = {
  key: null,
  configured: null,
};

function isPushSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

/** Convert the server's base64url VAPID key into the Uint8Array
 *  shape `pushManager.subscribe` insists on. Spec quirk; trivial
 *  conversion. */
function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  const out = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i += 1) out[i] = rawData.charCodeAt(i);
  return out;
}

async function fetchPublicKey(force = false): Promise<{ key: string | null; configured: boolean }> {
  if (!force && VAPID_PUBLIC_KEY_CACHE.key !== null && VAPID_PUBLIC_KEY_CACHE.configured !== null) {
    return { key: VAPID_PUBLIC_KEY_CACHE.key, configured: VAPID_PUBLIC_KEY_CACHE.configured };
  }
  try {
    const res = await fetch(`${API_BASE}/api/push/public-key`, { cache: "no-store" });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const data = (await res.json()) as { publicKey?: string; configured?: boolean };
    VAPID_PUBLIC_KEY_CACHE.key = data.publicKey || null;
    VAPID_PUBLIC_KEY_CACHE.configured = data.configured === true && !!data.publicKey;
    return {
      key: VAPID_PUBLIC_KEY_CACHE.key,
      configured: VAPID_PUBLIC_KEY_CACHE.configured,
    };
  } catch {
    // Treat backend-down as "not configured" rather than throwing —
    // the page's other features still work and we don't want a
    // failed health check to crash the settings panel.
    VAPID_PUBLIC_KEY_CACHE.key = null;
    VAPID_PUBLIC_KEY_CACHE.configured = false;
    return { key: null, configured: false };
  }
}

async function getIdToken(): Promise<string | null> {
  if (!isFirebaseConfigured()) return null;
  try {
    const user = getAuth(getFirebaseApp()).currentUser;
    if (!user || user.isAnonymous) return null;
    return await user.getIdToken();
  } catch {
    return null;
  }
}

async function getRegistration(): Promise<ServiceWorkerRegistration | null> {
  if (!isPushSupported()) return null;
  try {
    // `ready` waits for the SW to reach activated state, which is
    // what we need for `pushManager` access. Returns immediately
    // when the SW is already active.
    return await navigator.serviceWorker.ready;
  } catch {
    return null;
  }
}

async function getCurrentSubscription(): Promise<PushSubscription | null> {
  const reg = await getRegistration();
  if (!reg) return null;
  try {
    return await reg.pushManager.getSubscription();
  } catch {
    return null;
  }
}

export async function getPushStatus(): Promise<PushStatus> {
  if (typeof window === "undefined" || !isPushSupported()) {
    return {
      supported: false,
      permission: "unsupported",
      subscribed: false,
      serverConfigured: false,
      endpoint: null,
      reason: "unsupported",
    };
  }
  const { configured } = await fetchPublicKey();
  const sub = await getCurrentSubscription();
  const permission: NotificationPermission = window.Notification.permission;
  const status: PushStatus = {
    supported: true,
    permission,
    subscribed: !!sub,
    serverConfigured: configured,
    endpoint: sub?.endpoint || null,
  };
  if (!sub) {
    if (permission === "denied") status.reason = "permission-denied";
    else if (permission === "default") status.reason = "permission-default";
    else if (!configured) status.reason = "no-server-key";
  }
  return status;
}

/** Returns the b64url-encoded p256dh / auth keys from a browser
 *  PushSubscription. The browser hands them back as ArrayBuffers
 *  via getKey(); we encode here so the wire format matches what
 *  pywebpush expects on the server. */
function encodeKey(buf: ArrayBuffer | null): string {
  if (!buf) return "";
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i += 1) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Optional alert area persisted alongside the subscription. When
 *  omitted the user only receives direct messages (test pings,
 *  future direct alerts); when present, the backend uses it to
 *  decide whether a new high-severity scanner incident is "nearby"
 *  enough to push. Stored in localStorage so toggling push off+on
 *  doesn't lose the user's previous setting. */
export interface AlertArea {
  lat: number;
  lng: number;
  radiusKm: number;
}

const ALERT_AREA_STORAGE_KEY = "pp:push-alert-area";
const DEFAULT_ALERT_RADIUS_KM = 3;

export function loadAlertArea(): AlertArea | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(ALERT_AREA_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (
      typeof parsed?.lat === "number" &&
      typeof parsed?.lng === "number" &&
      Number.isFinite(parsed.lat) &&
      Number.isFinite(parsed.lng) &&
      typeof parsed?.radiusKm === "number" &&
      parsed.radiusKm > 0
    ) {
      return { lat: parsed.lat, lng: parsed.lng, radiusKm: parsed.radiusKm };
    }
  } catch {
    /* corrupt storage; treat as no area */
  }
  return null;
}

export function saveAlertArea(area: AlertArea | null): void {
  if (typeof window === "undefined") return;
  try {
    if (area === null) window.localStorage.removeItem(ALERT_AREA_STORAGE_KEY);
    else window.localStorage.setItem(ALERT_AREA_STORAGE_KEY, JSON.stringify(area));
  } catch {
    /* storage full / blocked — non-fatal */
  }
}

async function postSubscriptionToServer(
  sub: PushSubscription,
  idToken: string,
  area: AlertArea | null
): Promise<boolean> {
  const body: Record<string, unknown> = {
    endpoint: sub.endpoint,
    p256dh: encodeKey(sub.getKey("p256dh")),
    auth: encodeKey(sub.getKey("auth")),
    userAgent: typeof navigator !== "undefined" ? navigator.userAgent : "",
    city: getCurrentCity().slug,
  };
  if (area) {
    body.notifyLat = area.lat;
    body.notifyLng = area.lng;
    body.notifyRadiusKm = area.radiusKm;
  }
  try {
    const res = await fetch(`${API_BASE}/api/push/subscribe`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${idToken}`,
      },
      body: JSON.stringify(body),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function deleteSubscriptionOnServer(endpoint: string, idToken: string): Promise<void> {
  try {
    await fetch(`${API_BASE}/api/push/unsubscribe`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${idToken}`,
      },
      body: JSON.stringify({ endpoint }),
    });
  } catch {
    // Best-effort. The browser-side unsubscription is the source of
    // truth; a server-side ghost just means it won't deliver
    // anywhere (the push service will return 410 on next attempt
    // and the backend cleans up).
  }
}

export async function subscribePush(area?: AlertArea | null): Promise<SubscribeResult> {
  let status = await getPushStatus();
  if (!status.supported) {
    return { ok: false, reason: "Web Push isn't supported on this browser.", status };
  }
  const idToken = await getIdToken();
  if (!idToken) {
    return {
      ok: false,
      reason: "Sign in with a non-anonymous account to enable push.",
      status: { ...status, reason: "no-account" },
    };
  }

  // Permission gate. The browser will only show this prompt once
  // per origin per user — if they previously denied, we surface a
  // friendly error rather than a silent no-op.
  if (status.permission !== "granted") {
    let res: NotificationPermission;
    try { res = await Notification.requestPermission(); }
    catch { res = "denied"; }
    if (res !== "granted") {
      return {
        ok: false,
        reason:
          res === "denied"
            ? "Notifications are blocked for this site. Enable them in your browser settings."
            : "Notifications permission was dismissed.",
        status: { ...status, permission: res, reason: res === "denied" ? "permission-denied" : "permission-default" },
      };
    }
  }

  const reg = await getRegistration();
  if (!reg) {
    return {
      ok: false,
      reason:
        "The PhillyPulse service worker isn't active yet. Try reloading the page after a few seconds.",
      status: { ...status, reason: "no-service-worker" },
    };
  }

  const { key, configured } = await fetchPublicKey(true);
  if (!key || !configured) {
    return {
      ok: false,
      reason: "Server-side push isn't configured for this deployment yet.",
      status: { ...status, serverConfigured: false, reason: "no-server-key" },
    };
  }

  // Subscribe via the browser. `userVisibleOnly` is required by all
  // major browsers — every push must result in a visible
  // notification. Background sync is intentionally off the table.
  let sub: PushSubscription;
  try {
    // The `applicationServerKey` field is typed as
    // `BufferSource | null | undefined`. TS in strict mode
    // distinguishes Uint8Array<ArrayBuffer> vs.
    // Uint8Array<SharedArrayBuffer>; our key bytes are always
    // backed by a fresh ArrayBuffer but the type system can't
    // narrow that, so we cast through BufferSource.
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(key) as BufferSource,
    });
  } catch (e) {
    return {
      ok: false,
      reason: e instanceof Error ? e.message : "Failed to subscribe to push.",
      status,
    };
  }

  // Persist + send the alert area. If the caller didn't pass one
  // explicitly we fall back to whatever's already in localStorage so
  // re-subscribing (after a token expiry, key rotation, etc.) keeps
  // the user's previous choice instead of silently demoting them to
  // direct-only.
  const effectiveArea = area === undefined ? loadAlertArea() : area;
  if (area !== undefined) saveAlertArea(area);
  const ok = await postSubscriptionToServer(sub, idToken, effectiveArea);
  if (!ok) {
    // Roll back the browser subscription so the next attempt
    // re-runs the full handshake. Otherwise we'd be stuck in a
    // half-subscribed state where the browser thinks we're done
    // but the server has no record.
    try { await sub.unsubscribe(); } catch { /* best effort */ }
    return {
      ok: false,
      reason: "Failed to register subscription with the server.",
      status: await getPushStatus(),
    };
  }

  status = await getPushStatus();
  return { ok: true, status };
}

/** Update just the alert area on an existing subscription. Cheaper
 *  than the full re-subscribe round-trip when the user is only
 *  changing the location/radius slider. Persists to localStorage
 *  and re-POSTs the existing browser subscription to the backend
 *  so server state lines up. */
export async function updateAlertArea(area: AlertArea | null): Promise<boolean> {
  saveAlertArea(area);
  const sub = await getCurrentSubscription();
  if (!sub) return true; // nothing to sync yet — saved locally for next subscribe
  const idToken = await getIdToken();
  if (!idToken) return false;
  return postSubscriptionToServer(sub, idToken, area);
}

export async function unsubscribePush(): Promise<PushStatus> {
  const sub = await getCurrentSubscription();
  if (!sub) return getPushStatus();
  const endpoint = sub.endpoint;
  try { await sub.unsubscribe(); } catch { /* fall through, still try server cleanup */ }
  const idToken = await getIdToken();
  if (idToken) await deleteSubscriptionOnServer(endpoint, idToken);
  return getPushStatus();
}

/** Subscription metadata for a single device, as returned by
 *  /api/push/devices. The endpoint URL itself is intentionally not
 *  included — only an `endpointHint` (the trailing 12 chars) so the
 *  UI can disambiguate identical-UA browsers without leaking the
 *  full push-service credential. */
export interface PushDevice {
  id: string;
  userAgent: string;
  city: string;
  createdAtMs: number;
  lastUsedMs: number;
  lastNearbyPushMs: number;
  notifyLat: number | null;
  notifyLng: number | null;
  notifyRadiusKm: number | null;
  endpointHint: string;
  /** True when this device matches the current browser's
   *  subscription. Computed client-side after fetching the device
   *  list — the server doesn't know which device made the call. */
  isThisDevice?: boolean;
}

export async function listPushDevices(): Promise<PushDevice[]> {
  const idToken = await getIdToken();
  if (!idToken) return [];
  try {
    const res = await fetch(`${API_BASE}/api/push/devices`, {
      headers: { Authorization: `Bearer ${idToken}` },
      cache: "no-store",
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { devices?: PushDevice[] };
    const devices = data.devices ?? [];
    // Mark the current device so the UI can render a "this device"
    // badge. We re-derive the doc id from the current subscription
    // endpoint via the same SHA-256 hash the backend uses.
    const sub = await getCurrentSubscription();
    if (sub) {
      const currentId = await sha256Hex(sub.endpoint);
      for (const d of devices) {
        if (d.id === currentId) d.isThisDevice = true;
      }
    }
    return devices;
  } catch {
    return [];
  }
}

export async function revokePushDevice(deviceId: string): Promise<boolean> {
  const idToken = await getIdToken();
  if (!idToken) return false;
  try {
    const res = await fetch(`${API_BASE}/api/push/revoke-device`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${idToken}`,
      },
      body: JSON.stringify({ deviceId }),
    });
    if (!res.ok) return false;
    // If we just revoked the current device, also tear down the
    // browser-side PushSubscription so the user isn't left in a
    // half-subscribed state (browser thinks subscribed; server has
    // no record).
    const sub = await getCurrentSubscription();
    if (sub) {
      const currentId = await sha256Hex(sub.endpoint);
      if (currentId === deviceId) {
        try { await sub.unsubscribe(); } catch { /* best effort */ }
      }
    }
    return true;
  } catch {
    return false;
  }
}

async function sha256Hex(s: string): Promise<string> {
  const data = new TextEncoder().encode(s);
  const buf = await crypto.subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(buf);
  let out = "";
  for (let i = 0; i < bytes.length; i += 1) {
    out += bytes[i].toString(16).padStart(2, "0");
  }
  return out;
}

export interface PushTestResult {
  ok: boolean;
  /** "no_devices" when the user is signed in but hasn't subscribed
   *  any device — the UI should re-prompt to subscribe. */
  status: "ok" | "no_devices" | "error";
  sent: number;
  failed: number;
  gone: number;
  reason?: string;
}

export async function sendTestPush(): Promise<PushTestResult> {
  const idToken = await getIdToken();
  if (!idToken) {
    return { ok: false, status: "error", sent: 0, failed: 0, gone: 0, reason: "Sign in first." };
  }
  try {
    const res = await fetch(`${API_BASE}/api/push/test`, {
      method: "POST",
      headers: { Authorization: `Bearer ${idToken}` },
    });
    const data = (await res.json().catch(() => ({}))) as Partial<PushTestResult>;
    if (!res.ok) {
      return {
        ok: false,
        status: "error",
        sent: 0,
        failed: 0,
        gone: 0,
        reason:
          (data as { detail?: string }).detail ||
          (data as PushTestResult).reason ||
          `Server returned ${res.status}.`,
      };
    }
    return {
      ok: data.status === "ok",
      status: (data.status as PushTestResult["status"]) || "error",
      sent: data.sent ?? 0,
      failed: data.failed ?? 0,
      gone: data.gone ?? 0,
    };
  } catch (e) {
    return {
      ok: false,
      status: "error",
      sent: 0,
      failed: 0,
      gone: 0,
      reason: e instanceof Error ? e.message : "Network error.",
    };
  }
}
