"use client";

/** Settings UI for server-backed Web Push.
 *
 *  Lives inside the AlertsInbox settings drawer so notification
 *  controls cluster in one place: quiet hours, category mutes,
 *  commute prediction, and now closed-tab push.
 *
 *  Behavior choices:
 *    - We don't expose anything until we know the server supports
 *      push (no point hawking a feature that won't deliver). The
 *      first status fetch is on mount; we re-poll on toggle.
 *    - The "Send test" button is the highest-trust signal we can
 *      give the user — if a notification appears on a secondary
 *      device, the round-trip works. We surface success counts
 *      explicitly ("delivered to 1 of 2 devices") rather than a
 *      generic "ok".
 *    - The dev-mode case (no SW registered) is called out
 *      explicitly so the developer flipping into the panel doesn't
 *      think the feature is broken in production builds.
 */

import { useEffect, useState } from "react";
import {
  Bell,
  BellOff,
  Loader2,
  Send,
  AlertTriangle,
  Crosshair,
  MapPin,
  Trash2,
  Smartphone,
  Monitor,
  Moon,
  Briefcase,
  Home as HomeIcon,
  Calendar,
} from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import {
  getPushStatus,
  listPushDevices,
  loadAlertArea,
  revokePushDevice,
  sendTestPush,
  subscribePush,
  unsubscribePush,
  updateAlertArea,
  type AlertArea,
  type PushDevice,
  type PushStatus,
} from "@/lib/push-subscriptions";
import {
  clearPushSnooze,
  formatSnoozeRemaining,
  loadPushSnooze,
  snoozeFor,
  snoozeUntilTomorrowMorning,
  type PushSnoozeState,
} from "@/lib/push-snooze";
import {
  deleteCommuteScheduleById,
  formatScheduleTime,
  listCommuteSchedules,
  type CommuteScheduleSummary,
} from "@/lib/commute-schedule-sync";

const DEFAULT_RADIUS_LABEL = "3";

/** Best-effort UA → friendly device label. We only need to
 *  distinguish "phone in your pocket" from "desktop at home" — the
 *  full UA string is too noisy to render verbatim. */
function describeUserAgent(ua: string): { label: string; isMobile: boolean } {
  if (!ua) return { label: "Unknown device", isMobile: false };
  const isMobile = /Mobile|Android|iPhone|iPad|iPod/i.test(ua);
  // Order matters: Edge contains "Chrome" in its UA, etc.
  let browser = "Browser";
  if (/Edg\//i.test(ua)) browser = "Edge";
  else if (/OPR\/|Opera/i.test(ua)) browser = "Opera";
  else if (/Firefox/i.test(ua)) browser = "Firefox";
  else if (/Chrome/i.test(ua)) browser = "Chrome";
  else if (/Safari/i.test(ua)) browser = "Safari";
  let os = "";
  if (/iPhone|iPad|iPod/i.test(ua)) os = "iOS";
  else if (/Android/i.test(ua)) os = "Android";
  else if (/Mac OS X/i.test(ua)) os = "macOS";
  else if (/Windows/i.test(ua)) os = "Windows";
  else if (/Linux/i.test(ua)) os = "Linux";
  return { label: os ? `${browser} on ${os}` : browser, isMobile };
}

function formatRelative(ms: number): string {
  if (!ms) return "never";
  const diff = Date.now() - ms;
  if (diff < 60_000) return "just now";
  const m = Math.floor(diff / 60_000);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hr ago`;
  const d = Math.floor(h / 24);
  return `${d} d ago`;
}

function geoErrorMessage(e: GeolocationPositionError): string {
  if (e.code === 1) return "Location permission denied. Enable it in your browser settings.";
  if (e.code === 2) return "Couldn't determine your location.";
  if (e.code === 3) return "Location request timed out. Try again.";
  return "Couldn't read your location.";
}

export default function PushSettings() {
  const { user } = useAuth();
  const [status, setStatus] = useState<PushStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [area, setArea] = useState<AlertArea | null>(null);
  const [areaBusy, setAreaBusy] = useState(false);
  const [devices, setDevices] = useState<PushDevice[] | null>(null);
  const [showDevices, setShowDevices] = useState(false);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [snooze, setSnooze] = useState<PushSnoozeState>({ active: false, untilMs: 0 });
  const [schedules, setSchedules] = useState<CommuteScheduleSummary[] | null>(null);
  const [showSchedules, setShowSchedules] = useState(false);
  const [revokingSchedule, setRevokingSchedule] = useState<string | null>(null);

  const refresh = async () => {
    setStatus(await getPushStatus());
  };

  const refreshDevices = async () => {
    setDevices(await listPushDevices());
  };

  const refreshSchedules = async () => {
    if (!user || user.isAnonymous) {
      setSchedules([]);
      return;
    }
    try {
      setSchedules(await listCommuteSchedules(user.uid));
    } catch {
      setSchedules([]);
    }
  };

  useEffect(() => {
    void refresh();
    setArea(loadAlertArea());
    setSnooze(loadPushSnooze());
    // Re-check when the auth state changes — flipping from
    // anonymous → signed in unlocks the subscribe affordance.
  }, [user?.uid, user?.isAnonymous]);

  useEffect(() => {
    if (showDevices) void refreshDevices();
  }, [showDevices, status?.subscribed]);

  useEffect(() => {
    if (showSchedules) void refreshSchedules();
  }, [showSchedules, user?.uid]);

  // Recompute the snooze countdown every minute so the "47 min left"
  // pill stays honest without forcing the user to refresh.
  useEffect(() => {
    if (!snooze.active) return;
    const id = window.setInterval(() => {
      const next = loadPushSnooze();
      setSnooze(next);
    }, 60_000);
    return () => window.clearInterval(id);
  }, [snooze.active, snooze.untilMs]);

  // Listen for the SW telling us a subscription was invalidated
  // (browser key rotation, site-data clear). Just refresh; the user
  // can re-subscribe with one tap.
  useEffect(() => {
    if (typeof navigator === "undefined" || !navigator.serviceWorker) return;
    const handler = (ev: MessageEvent) => {
      if (ev.data?.type === "PUSH_SUBSCRIPTION_CHANGED") {
        void refresh();
      }
    };
    navigator.serviceWorker.addEventListener("message", handler);
    return () => navigator.serviceWorker.removeEventListener("message", handler);
  }, []);

  if (!status) {
    return (
      <div className="flex items-center gap-2 text-[10px]" style={{ color: "var(--panel-text-muted)" }}>
        <Loader2 className="w-3 h-3 animate-spin" />
        Checking push status…
      </div>
    );
  }

  if (!status.supported) {
    return (
      <div>
        <p className="text-xs font-semibold" style={{ color: "var(--panel-text)" }}>
          Closed-tab alerts
        </p>
        <p className="text-[10px] leading-snug mt-0.5" style={{ color: "#f59e0b" }}>
          Your browser doesn&rsquo;t support Web Push. iOS users:
          install PhillyPulse to your home screen first (iOS 16.4+).
        </p>
      </div>
    );
  }

  const onSubscribe = async () => {
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      // Pass `undefined` so the lib falls back to the persisted area.
      // First-time subscribers will have nothing in storage, which is
      // fine — they can pin an area afterwards via the controls
      // below, and the next push test still works regardless.
      const result = await subscribePush(undefined);
      setStatus(result.status);
      if (!result.ok) setError(result.reason);
      else setInfo("Subscribed. We'll buzz this device for high-priority alerts.");
    } finally {
      setBusy(false);
    }
  };

  const onUseCurrentLocation = async () => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      setError("Your browser doesn't support geolocation.");
      return;
    }
    setAreaBusy(true);
    setError(null);
    setInfo(null);
    try {
      // Single-shot, low-accuracy is fine — we only need the user's
      // rough neighborhood for proximity matching, not a turn-by-turn
      // GPS lock. enableHighAccuracy=false saves battery and is
      // typically faster.
      const pos = await new Promise<GeolocationPosition>((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(resolve, reject, {
          enableHighAccuracy: false,
          maximumAge: 5 * 60 * 1000,
          timeout: 8000,
        });
      });
      const next: AlertArea = {
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
        radiusKm: area?.radiusKm ?? 3,
      };
      setArea(next);
      const ok = await updateAlertArea(next);
      if (ok) setInfo(`Alert area pinned to your current location (${next.radiusKm} km).`);
      else setError("Saved locally, but couldn't sync to the server. Try again later.");
    } catch (e) {
      const msg = e instanceof GeolocationPositionError ? geoErrorMessage(e) : "Couldn't read your location.";
      setError(msg);
    } finally {
      setAreaBusy(false);
    }
  };

  const onChangeRadius = async (radiusKm: number) => {
    if (!area) return;
    const next = { ...area, radiusKm };
    setArea(next);
    setAreaBusy(true);
    try {
      const ok = await updateAlertArea(next);
      if (!ok) setError("Couldn't sync radius to the server.");
    } finally {
      setAreaBusy(false);
    }
  };

  const onClearArea = async () => {
    setAreaBusy(true);
    setError(null);
    setInfo(null);
    try {
      setArea(null);
      const ok = await updateAlertArea(null);
      if (ok) setInfo("Cleared alert area. You'll only receive direct messages now.");
    } finally {
      setAreaBusy(false);
    }
  };

  const onUnsubscribe = async () => {
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      const next = await unsubscribePush();
      setStatus(next);
      setInfo("Unsubscribed. You'll still see in-app alerts when the tab is open.");
    } finally {
      setBusy(false);
    }
  };

  const onTest = async () => {
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      const r = await sendTestPush();
      if (r.status === "no_devices") {
        setError("No devices subscribed yet. Tap 'Enable' first.");
      } else if (r.ok) {
        const detail =
          r.failed || r.gone
            ? `Delivered to ${r.sent} of ${r.sent + r.failed + r.gone} device${r.sent + r.failed + r.gone === 1 ? "" : "s"}.`
            : `Delivered to ${r.sent} device${r.sent === 1 ? "" : "s"}.`;
        setInfo(detail);
      } else {
        setError(r.reason || "Push test failed.");
      }
    } finally {
      setBusy(false);
    }
  };

  const subscribed = status.subscribed;
  const canSubscribe =
    !!user && !user.isAnonymous && status.serverConfigured && status.permission !== "denied";

  return (
    <div>
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0 pr-2">
          <p className="text-xs font-semibold flex items-center gap-1.5" style={{ color: "var(--panel-text)" }}>
            {subscribed ? <Bell className="w-3.5 h-3.5" /> : <BellOff className="w-3.5 h-3.5" />}
            Closed-tab alerts
          </p>
          <p className="text-[10px] leading-snug mt-0.5" style={{ color: "var(--panel-text-muted)" }}>
            Server-sent push that fires even when PhillyPulse isn&rsquo;t open.
            Quiet hours and category mutes still apply.
          </p>
          {!status.serverConfigured && (
            <p className="text-[10px] mt-1" style={{ color: "#f59e0b" }}>
              The server isn&rsquo;t configured for push yet. Subscribe anyway to be ready
              when it&rsquo;s rolled out.
            </p>
          )}
          {!user && (
            <p className="text-[10px] mt-1" style={{ color: "#f59e0b" }}>
              Sign in with a non-anonymous account to enable push.
            </p>
          )}
          {user?.isAnonymous && (
            <p className="text-[10px] mt-1" style={{ color: "#f59e0b" }}>
              Anonymous accounts can&rsquo;t subscribe. Link an email or social
              provider to enable push.
            </p>
          )}
          {status.permission === "denied" && (
            <p className="text-[10px] mt-1" style={{ color: "#ef4444" }}>
              Notifications are blocked for this site. Enable them in your
              browser settings, then reload.
            </p>
          )}
          {process.env.NODE_ENV !== "production" && (
            <p className="text-[10px] mt-1" style={{ color: "var(--panel-text-muted)" }}>
              Note: the service worker only registers in production builds.
              Run <code>npm run build &amp;&amp; npm start</code> to test push locally.
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={subscribed ? onUnsubscribe : onSubscribe}
          disabled={busy || (!subscribed && !canSubscribe)}
          className="shrink-0 px-2.5 py-1 rounded-md text-[11px] font-medium disabled:opacity-50 transition-colors"
          style={{
            background: subscribed ? "var(--panel-input-bg)" : "rgba(99,102,241,0.15)",
            color: subscribed ? "var(--panel-text-secondary)" : "#818cf8",
            border: `1px solid ${subscribed ? "var(--panel-border)" : "rgba(129,140,248,0.40)"}`,
          }}
        >
          {busy ? (
            <Loader2 className="w-3 h-3 animate-spin" />
          ) : subscribed ? (
            "Disable"
          ) : (
            "Enable"
          )}
        </button>
      </div>
      {subscribed && (
        <>
          {/* Alert-area picker. Optional: a subscription with no
              area still receives test pushes + future direct
              messages, but won't get neighborhood incident pings.
              We let the user pin once via Geolocation rather than
              picking on the map (the map UI is busy enough). */}
          <div
            className="mt-2 p-2 rounded-md"
            style={{
              background: "var(--panel-input-bg)",
              border: "1px solid var(--panel-border)",
            }}
          >
            <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider"
              style={{ color: "var(--panel-text-muted)" }}>
              <MapPin className="w-3 h-3" />
              Nearby-incident area
            </div>
            {area ? (
              <>
                <p className="mt-1 text-[10px] font-mono" style={{ color: "var(--panel-text-secondary)" }}>
                  {area.lat.toFixed(4)}, {area.lng.toFixed(4)} · {area.radiusKm} km radius
                </p>
                <div className="mt-1.5 flex items-center gap-2">
                  <input
                    type="range"
                    min={0.5}
                    max={10}
                    step={0.5}
                    value={area.radiusKm}
                    onChange={(e) => void onChangeRadius(Number(e.target.value))}
                    disabled={areaBusy}
                    className="flex-1"
                    aria-label="Alert radius in kilometers"
                  />
                  <span
                    className="text-[10px] font-mono w-10 text-right"
                    style={{ color: "var(--panel-text-secondary)" }}
                  >
                    {area.radiusKm} km
                  </span>
                </div>
                <div className="mt-1.5 flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={onUseCurrentLocation}
                    disabled={areaBusy}
                    className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[10px] disabled:opacity-50"
                    style={{
                      background: "var(--panel-bg)",
                      color: "var(--panel-text-secondary)",
                      border: "1px solid var(--panel-border)",
                    }}
                  >
                    <Crosshair className="w-2.5 h-2.5" />
                    Re-pin to current location
                  </button>
                  <button
                    type="button"
                    onClick={onClearArea}
                    disabled={areaBusy}
                    className="inline-flex items-center px-2 py-1 rounded-md text-[10px] disabled:opacity-50"
                    style={{
                      background: "var(--panel-bg)",
                      color: "var(--panel-text-muted)",
                      border: "1px solid var(--panel-border)",
                    }}
                  >
                    Clear
                  </button>
                </div>
              </>
            ) : (
              <>
                <p className="mt-1 text-[10px] leading-snug" style={{ color: "var(--panel-text-muted)" }}>
                  Pin a location to receive a buzz when high-severity incidents
                  are reported within {DEFAULT_RADIUS_LABEL} km. Without it, you&rsquo;ll
                  only get direct messages and test pings.
                </p>
                <button
                  type="button"
                  onClick={onUseCurrentLocation}
                  disabled={areaBusy}
                  className="mt-1.5 inline-flex items-center gap-1 px-2 py-1 rounded-md text-[10px] disabled:opacity-50"
                  style={{
                    background: "var(--panel-bg)",
                    color: "var(--panel-text-secondary)",
                    border: "1px solid var(--panel-border)",
                  }}
                >
                  <Crosshair className="w-2.5 h-2.5" />
                  Use my current location
                </button>
              </>
            )}
          </div>

          <div className="mt-1.5 flex items-center gap-1.5 flex-wrap">
            <button
              type="button"
              onClick={onTest}
              disabled={busy}
              className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[10px] disabled:opacity-50"
              style={{
                background: "var(--panel-input-bg)",
                color: "var(--panel-text-secondary)",
                border: "1px solid var(--panel-border)",
              }}
            >
              <Send className="w-2.5 h-2.5" />
              Send test push
            </button>
            <button
              type="button"
              onClick={() => setShowDevices((v) => !v)}
              className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[10px]"
              style={{
                background: "var(--panel-input-bg)",
                color: "var(--panel-text-secondary)",
                border: "1px solid var(--panel-border)",
              }}
              aria-expanded={showDevices}
            >
              {showDevices ? "Hide my devices" : "Show my devices"}
            </button>
            <button
              type="button"
              onClick={() => setShowSchedules((v) => !v)}
              className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[10px]"
              style={{
                background: "var(--panel-input-bg)",
                color: "var(--panel-text-secondary)",
                border: "1px solid var(--panel-border)",
              }}
              aria-expanded={showSchedules}
            >
              <Calendar className="w-2.5 h-2.5" />
              {showSchedules ? "Hide commute schedules" : "My commute schedules"}
            </button>
          </div>

          {/* Push snooze. Surfaced inline (no toggle) because the
              cost of an "extra" pill is much smaller than the cost
              of someone asking "why didn't I get pushes this
              afternoon?" — visibility is the whole point. */}
          <div
            className="mt-1.5 p-2 rounded-md"
            style={{
              background: snooze.active ? "rgba(251,191,36,0.10)" : "var(--panel-input-bg)",
              border: `1px solid ${snooze.active ? "rgba(251,191,36,0.40)" : "var(--panel-border)"}`,
            }}
          >
            <div className="flex items-center gap-1.5 mb-1">
              <Moon className="w-3 h-3" style={{ color: snooze.active ? "#fbbf24" : "var(--panel-text-muted)" }} />
              <span className="text-[11px] font-medium" style={{ color: "var(--panel-text)" }}>
                Push snooze
              </span>
              {snooze.active && (
                <span
                  className="px-1 py-px rounded text-[9px]"
                  style={{
                    background: "rgba(251,191,36,0.15)",
                    color: "#fbbf24",
                    border: "1px solid rgba(251,191,36,0.40)",
                  }}
                >
                  {formatSnoozeRemaining(snooze.untilMs)}
                </span>
              )}
            </div>
            <p className="text-[10px] mb-1.5" style={{ color: "var(--panel-text-muted)" }}>
              Pause closed-tab pushes (nearby + commute). The Alerts
              Inbox keeps recording everything in the background.
            </p>
            <div className="flex items-center gap-1.5 flex-wrap">
              {!snooze.active ? (
                <>
                  <button
                    type="button"
                    onClick={() => setSnooze(snoozeFor(60 * 60_000))}
                    className="px-2 py-1 rounded-md text-[10px]"
                    style={{
                      background: "var(--panel-bg)",
                      color: "var(--panel-text-secondary)",
                      border: "1px solid var(--panel-border)",
                    }}
                  >
                    1 hour
                  </button>
                  <button
                    type="button"
                    onClick={() => setSnooze(snoozeFor(8 * 60 * 60_000))}
                    className="px-2 py-1 rounded-md text-[10px]"
                    style={{
                      background: "var(--panel-bg)",
                      color: "var(--panel-text-secondary)",
                      border: "1px solid var(--panel-border)",
                    }}
                  >
                    8 hours
                  </button>
                  <button
                    type="button"
                    onClick={() => setSnooze(snoozeUntilTomorrowMorning())}
                    className="px-2 py-1 rounded-md text-[10px]"
                    style={{
                      background: "var(--panel-bg)",
                      color: "var(--panel-text-secondary)",
                      border: "1px solid var(--panel-border)",
                    }}
                  >
                    Until tomorrow 7am
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    clearPushSnooze();
                    setSnooze({ active: false, untilMs: 0 });
                  }}
                  className="px-2 py-1 rounded-md text-[10px]"
                  style={{
                    background: "rgba(251,191,36,0.20)",
                    color: "#fbbf24",
                    border: "1px solid rgba(251,191,36,0.40)",
                  }}
                >
                  End snooze now
                </button>
              )}
            </div>
          </div>

          {showDevices && (
            <div
              className="mt-1.5 p-2 rounded-md space-y-1.5"
              style={{
                background: "var(--panel-input-bg)",
                border: "1px solid var(--panel-border)",
              }}
            >
              {devices === null ? (
                <div className="flex items-center gap-1.5 text-[10px]" style={{ color: "var(--panel-text-muted)" }}>
                  <Loader2 className="w-3 h-3 animate-spin" />
                  Loading subscribed devices…
                </div>
              ) : devices.length === 0 ? (
                <p className="text-[10px]" style={{ color: "var(--panel-text-muted)" }}>
                  No devices subscribed yet.
                </p>
              ) : (
                devices.map((d) => {
                  const meta = describeUserAgent(d.userAgent);
                  const Icon = meta.isMobile ? Smartphone : Monitor;
                  const lastSeen = d.lastUsedMs || d.createdAtMs;
                  return (
                    <div
                      key={d.id}
                      className="flex items-start gap-2 p-1.5 rounded"
                      style={{
                        background: "var(--panel-bg)",
                        border: `1px solid ${d.isThisDevice ? "rgba(129,140,248,0.40)" : "var(--panel-border)"}`,
                      }}
                    >
                      <Icon className="w-3.5 h-3.5 mt-0.5 shrink-0" style={{ color: "var(--panel-text-muted)" }} />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span className="text-[11px] font-medium truncate" style={{ color: "var(--panel-text)" }}>
                            {meta.label}
                          </span>
                          {d.isThisDevice && (
                            <span
                              className="px-1 py-px rounded text-[9px]"
                              style={{
                                background: "rgba(129,140,248,0.15)",
                                color: "#818cf8",
                                border: "1px solid rgba(129,140,248,0.40)",
                              }}
                            >
                              this device
                            </span>
                          )}
                        </div>
                        <p className="text-[10px] mt-0.5" style={{ color: "var(--panel-text-muted)" }}>
                          Subscribed {formatRelative(d.createdAtMs)}
                          {d.lastUsedMs ? ` · last push ${formatRelative(lastSeen)}` : ""}
                          {d.notifyLat !== null && d.notifyLng !== null && d.notifyRadiusKm
                            ? ` · ${d.notifyRadiusKm} km area`
                            : " · no alert area"}
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={async () => {
                          setRevoking(d.id);
                          const ok = await revokePushDevice(d.id);
                          setRevoking(null);
                          if (ok) {
                            await refreshDevices();
                            // If we just revoked the current device,
                            // refresh the top-level status so the
                            // Enable button comes back.
                            if (d.isThisDevice) await refresh();
                            setInfo(`Revoked ${meta.label}.`);
                          } else {
                            setError("Couldn't revoke that device.");
                          }
                        }}
                        disabled={revoking === d.id}
                        aria-label={`Revoke ${meta.label}`}
                        className="shrink-0 p-1 rounded transition-colors disabled:opacity-50 hover:bg-white/5"
                        style={{ color: "#ef4444" }}
                      >
                        {revoking === d.id ? (
                          <Loader2 className="w-3 h-3 animate-spin" />
                        ) : (
                          <Trash2 className="w-3 h-3" />
                        )}
                      </button>
                    </div>
                  );
                })
              )}
            </div>
          )}

          {showSchedules && (
            <div
              className="mt-1.5 p-2 rounded-md space-y-1.5"
              style={{
                background: "var(--panel-input-bg)",
                border: "1px solid var(--panel-border)",
              }}
            >
              <p className="text-[10px]" style={{ color: "var(--panel-text-muted)" }}>
                Schedules sync from your trip history when you opt in
                to commute alerts. Removing one stops closed-tab pushes
                for that pattern; the in-app pill keeps showing live
                predictions.
              </p>
              {schedules === null ? (
                <div className="flex items-center gap-1.5 text-[10px]" style={{ color: "var(--panel-text-muted)" }}>
                  <Loader2 className="w-3 h-3 animate-spin" />
                  Loading commute schedules…
                </div>
              ) : schedules.length === 0 ? (
                <p className="text-[10px]" style={{ color: "var(--panel-text-muted)" }}>
                  No synced schedules yet. Enable commute alerts and
                  travel a recurring route a few times to build one.
                </p>
              ) : (
                schedules.map((s) => {
                  const Icon = s.matchedCategory === "home"
                    ? HomeIcon
                    : s.matchedCategory === "work"
                    ? Briefcase
                    : Calendar;
                  const dayLabel = s.isWeekend ? "Weekends" : "Weekdays";
                  const firedToday = s.lastFiredYmd
                    ? new Date().toISOString().slice(0, 10) === s.lastFiredYmd
                    : false;
                  return (
                    <div
                      key={s.id}
                      className="flex items-start gap-2 p-1.5 rounded"
                      style={{
                        background: "var(--panel-bg)",
                        border: "1px solid var(--panel-border)",
                      }}
                    >
                      <Icon className="w-3.5 h-3.5 mt-0.5 shrink-0" style={{ color: "var(--panel-text-muted)" }} />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span className="text-[11px] font-medium truncate" style={{ color: "var(--panel-text)" }}>
                            {s.matchedCategory === "home"
                              ? "Heading home"
                              : s.matchedCategory === "work"
                              ? "Heading to work"
                              : `Heading to ${s.destLabel}`}
                          </span>
                          {firedToday && (
                            <span
                              className="px-1 py-px rounded text-[9px]"
                              style={{
                                background: "rgba(34,197,94,0.15)",
                                color: "#22c55e",
                                border: "1px solid rgba(34,197,94,0.40)",
                              }}
                            >
                              fired today
                            </span>
                          )}
                        </div>
                        <p className="text-[10px] mt-0.5" style={{ color: "var(--panel-text-muted)" }}>
                          {dayLabel} · usually around {formatScheduleTime(s.typicalDepartureMinute)}
                          {s.typicalDurationMin > 0 ? ` · ~${Math.round(s.typicalDurationMin)}m` : ""}
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={async () => {
                          setRevokingSchedule(s.id);
                          try {
                            await deleteCommuteScheduleById(s.id);
                            await refreshSchedules();
                            setInfo("Removed commute schedule.");
                          } catch {
                            setError("Couldn't remove that schedule.");
                          } finally {
                            setRevokingSchedule(null);
                          }
                        }}
                        disabled={revokingSchedule === s.id}
                        aria-label="Remove schedule"
                        className="shrink-0 p-1 rounded transition-colors disabled:opacity-50 hover:bg-white/5"
                        style={{ color: "#ef4444" }}
                      >
                        {revokingSchedule === s.id ? (
                          <Loader2 className="w-3 h-3 animate-spin" />
                        ) : (
                          <Trash2 className="w-3 h-3" />
                        )}
                      </button>
                    </div>
                  );
                })
              )}
            </div>
          )}
        </>
      )}
      {error && (
        <div className="mt-1.5 flex items-start gap-1 text-[10px]" style={{ color: "#ef4444" }}>
          <AlertTriangle className="w-3 h-3 shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}
      {info && !error && (
        <p className="mt-1.5 text-[10px]" style={{ color: "#22c55e" }}>
          {info}
        </p>
      )}
    </div>
  );
}
