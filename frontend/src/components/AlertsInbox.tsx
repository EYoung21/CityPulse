"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, Bell, Check, MapPin, Moon, Trash2, X } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import {
  clearAlerts,
  getAlerts,
  markAllRead,
  markRead,
  subscribeAlerts,
  type InboxAlert,
} from "@/lib/alerts-inbox";
import { getSeverity, SEVERITY_MAP } from "@/lib/severity";
import {
  formatQuietWindow,
  isQuietNow,
  loadQuietHours,
  saveQuietHours,
  subscribeQuietHours,
  type QuietHoursConfig,
} from "@/lib/quiet-hours";
import {
  loadMutedCategories,
  toggleCategoryMute,
  subscribeMutedCategories,
} from "@/lib/alert-mutes";
import PushSettings from "@/components/PushSettings";
import {
  enableCommuteNotifications,
  isCommuteNotificationsEnabled,
  setCommuteNotificationsEnabled,
} from "@/lib/commute-notify";
import { notificationsSupported } from "@/lib/notifications";
import { useAuth } from "@/contexts/AuthContext";
import { requestUpgrade } from "@/lib/upgrade";
import { requestInstallPrompt } from "@/components/InstallPrompt";

interface Props {
  open: boolean;
  onClose: () => void;
  onJump: (incidentId: string, lat: number, lng: number) => void;
  /**
   * Which subview should be visible the first time the drawer opens.
   * Defaults to `"list"` (recent alerts). Set to `"settings"` to
   * deep-link straight into the mute / push / commute panel — used
   * by the mobile bottom nav's Settings tab so users skip the inbox
   * list when they explicitly tapped Settings.
   *
   * Honored on the rising edge of `open` (false→true). After that
   * the drawer's internal toggle takes over so the user can switch
   * panels manually without us re-overriding their choice.
   */
  defaultPanel?: "list" | "settings";
}

function fmtAgo(ts: number): string {
  const m = Math.max(0, Math.round((Date.now() - ts) / 60000));
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hr ago`;
  const d = Math.floor(h / 24);
  return `${d} d ago`;
}

const KIND_LABEL: Record<InboxAlert["kind"], string> = {
  offscreen: "Off-screen",
  ahead: "On your route",
  background: "Background alert",
};

/** Dropdown panel anchored to the bell button. Mirrors the visual
 *  language of the existing Theme/Layers menus so the control stack
 *  feels cohesive. Lists the most-recent N alerts with read state,
 *  with single-tap "fly to" + an unread bulk-clear. */
export default function AlertsInbox({ open, onClose, onJump, defaultPanel = "list" }: Props) {
  const { isPro } = useAuth();
  const [alerts, setAlerts] = useState<InboxAlert[]>([]);
  const [quiet, setQuiet] = useState<QuietHoursConfig>(() => loadQuietHours());
  const [showSettings, setShowSettings] = useState(defaultPanel === "settings");

  // Re-apply `defaultPanel` on each open so deep-linking into Settings
  // from the bottom nav works repeatedly (not just on initial mount).
  // We diff against `open` so an in-drawer panel toggle isn't immediately
  // clobbered by this effect on the next render.
  useEffect(() => {
    if (open) {
      setShowSettings(defaultPanel === "settings");
    }
    // Intentionally exclude `defaultPanel` so changing it while open
    // doesn't fight a user who tapped the in-drawer toggle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const [quietActive, setQuietActive] = useState<boolean>(() => isQuietNow());
  const [muted, setMuted] = useState<Set<string>>(() => loadMutedCategories());
  // Mirror the localStorage flag so the toggle reflects the live
  // state (and updates if the user enabled it from a different
  // surface like the prediction pill or another tab).
  const [commuteNotify, setCommuteNotify] = useState<boolean>(
    () => isCommuteNotificationsEnabled()
  );
  const [commuteNotifyError, setCommuteNotifyError] = useState<string | null>(null);

  useEffect(() => {
    setMuted(loadMutedCategories());
    return subscribeMutedCategories(setMuted);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const handler = (e: Event) => {
      const det = (e as CustomEvent<{ on: boolean }>).detail;
      setCommuteNotify(!!det?.on);
    };
    window.addEventListener("pp:commute-notify-changed", handler);
    return () => window.removeEventListener("pp:commute-notify-changed", handler);
  }, []);

  useEffect(() => {
    setAlerts(getAlerts());
    const unsub = subscribeAlerts(setAlerts);
    return unsub;
  }, []);

  useEffect(() => {
    setQuiet(loadQuietHours());
    return subscribeQuietHours((next) => {
      setQuiet(next);
      setQuietActive(isQuietNow(new Date(), next));
    });
  }, []);

  // Recompute "is quiet right now?" once a minute so the indicator
  // flips automatically when the user passes the start/end boundary
  // without anyone needing to refresh the panel.
  useEffect(() => {
    const tick = () => setQuietActive(isQuietNow());
    tick();
    const id = window.setInterval(tick, 60_000);
    return () => window.clearInterval(id);
  }, []);

  // Mark everything as read when the panel opens — the user has seen
  // them. Persisted, so a refresh doesn't re-flash the unread badge.
  useEffect(() => {
    if (open) markAllRead();
  }, [open]);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0, scale: 0.9, y: 8 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.9, y: 8 }}
          className="absolute bottom-12 right-0 w-80 max-w-[calc(100vw-1.5rem)] rounded-xl shadow-2xl backdrop-blur-md flex flex-col overflow-hidden"
          style={{
            background: "var(--panel-bg)",
            border: "1px solid var(--panel-border)",
            maxHeight: "min(60vh, 32rem)",
          }}
          role="dialog"
          aria-label="Alerts inbox"
        >
          <div
            className="flex items-center justify-between px-3 py-2.5 shrink-0"
            style={{ borderBottom: "1px solid var(--panel-border)" }}
          >
            <div className="flex items-center gap-2 min-w-0">
              <p className="text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--panel-text-muted)" }}>
                Alerts ({alerts.length})
              </p>
              {/* Status pill — only renders when quiet hours are
                  actively suppressing notifications, so users see at a
                  glance why their phone has been silent. */}
              {quiet.enabled && quietActive && (
                <span
                  className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[9px] font-medium"
                  style={{
                    background: "rgba(99,102,241,0.15)",
                    color: "#818cf8",
                    border: "1px solid rgba(99,102,241,0.30)",
                  }}
                  title={`Quiet hours active: ${formatQuietWindow(quiet)}`}
                >
                  <Moon className="w-2.5 h-2.5" />
                  Quiet
                </span>
              )}
            </div>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => setShowSettings((v) => !v)}
                className="p-1.5 rounded-md transition-colors"
                style={{
                  color: showSettings ? "#818cf8" : "var(--panel-text-muted)",
                  background: showSettings ? "rgba(99,102,241,0.12)" : "transparent",
                }}
                onMouseEnter={(e) => { if (!showSettings) (e.currentTarget.style.background = "var(--panel-hover)"); }}
                onMouseLeave={(e) => { if (!showSettings) (e.currentTarget.style.background = "transparent"); }}
                aria-pressed={showSettings}
                aria-label="Quiet-hours settings"
                title="Quiet-hours settings"
              >
                <Moon className="w-3.5 h-3.5" />
              </button>
              {alerts.length > 0 && (
                <button
                  type="button"
                  onClick={() => clearAlerts()}
                  className="p-1.5 rounded-md transition-colors"
                  style={{ color: "var(--panel-text-muted)" }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = "var(--panel-hover)")}
                  onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                  title="Clear all"
                  aria-label="Clear all alerts"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              )}
              <button
                type="button"
                onClick={onClose}
                className="p-1.5 rounded-md transition-colors"
                style={{ color: "var(--panel-text-muted)" }}
                onMouseEnter={(e) => (e.currentTarget.style.background = "var(--panel-hover)")}
                onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                aria-label="Close inbox"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          {showSettings && (
            <div
              className="px-3 py-3 space-y-2 shrink-0"
              style={{ borderBottom: "1px solid var(--panel-border)", background: "var(--panel-input-bg)" }}
            >
              <div className="flex items-center justify-between">
                <div className="min-w-0 pr-2">
                  <p className="text-xs font-semibold" style={{ color: "var(--panel-text)" }}>
                    Quiet hours
                  </p>
                  <p className="text-[10px] leading-snug mt-0.5" style={{ color: "var(--panel-text-muted)" }}>
                    Mute push + ambient voice cues. Turn-by-turn directions still speak.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => saveQuietHours({ enabled: !quiet.enabled })}
                  className="shrink-0"
                  aria-pressed={quiet.enabled}
                  aria-label={quiet.enabled ? "Disable quiet hours" : "Enable quiet hours"}
                >
                  <span
                    className="block w-10 h-5 rounded-full relative transition-colors"
                    style={{
                      background: quiet.enabled ? "#818cf8" : "var(--panel-border)",
                    }}
                  >
                    <span
                      className="absolute top-0.5 w-4 h-4 rounded-full bg-white shadow-md transition-transform"
                      style={{ left: quiet.enabled ? "1.375rem" : "0.125rem" }}
                    />
                  </span>
                </button>
              </div>
              <div className="flex items-center gap-2">
                <label className="flex-1">
                  <span
                    className="block text-[10px] uppercase tracking-wider"
                    style={{ color: "var(--panel-text-muted)" }}
                  >
                    From
                  </span>
                  <input
                    type="time"
                    step={900}
                    disabled={!quiet.enabled}
                    value={`${String(quiet.startHour).padStart(2, "0")}:${String(quiet.startMinute).padStart(2, "0")}`}
                    onChange={(e) => {
                      const [h, m] = e.target.value.split(":").map((n) => parseInt(n, 10));
                      saveQuietHours({ startHour: h, startMinute: m });
                    }}
                    className="w-full mt-1 px-2 py-1 rounded-md text-xs disabled:opacity-50"
                    style={{
                      background: "var(--panel-bg)",
                      color: "var(--panel-text)",
                      border: "1px solid var(--panel-border)",
                    }}
                  />
                </label>
                <label className="flex-1">
                  <span
                    className="block text-[10px] uppercase tracking-wider"
                    style={{ color: "var(--panel-text-muted)" }}
                  >
                    Until
                  </span>
                  <input
                    type="time"
                    step={900}
                    disabled={!quiet.enabled}
                    value={`${String(quiet.endHour).padStart(2, "0")}:${String(quiet.endMinute).padStart(2, "0")}`}
                    onChange={(e) => {
                      const [h, m] = e.target.value.split(":").map((n) => parseInt(n, 10));
                      saveQuietHours({ endHour: h, endMinute: m });
                    }}
                    className="w-full mt-1 px-2 py-1 rounded-md text-xs disabled:opacity-50"
                    style={{
                      background: "var(--panel-bg)",
                      color: "var(--panel-text)",
                      border: "1px solid var(--panel-border)",
                    }}
                  />
                </label>
              </div>
              {quiet.enabled && (
                <p className="text-[10px]" style={{ color: "var(--panel-text-muted)" }}>
                  Active window: {formatQuietWindow(quiet)}{quietActive ? " · suppressing now" : ""}
                </p>
              )}

              <div className="h-px" style={{ background: "var(--panel-border)" }} />

              <div>
                <p className="text-xs font-semibold" style={{ color: "var(--panel-text)" }}>
                  Mute by category
                </p>
                <p className="text-[10px] leading-snug mt-0.5" style={{ color: "var(--panel-text-muted)" }}>
                  Tap to silence push + chip alerts for that incident type. Markers stay visible on the map.
                </p>
                <div className="flex flex-wrap gap-1 mt-1.5">
                  {Object.entries(SEVERITY_MAP).map(([slug, cfg]) => {
                    const on = muted.has(slug);
                    return (
                      <button
                        key={slug}
                        type="button"
                        onClick={() => toggleCategoryMute(slug)}
                        aria-pressed={on}
                        className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-[10px] transition-colors"
                        style={{
                          background: on
                            ? "var(--panel-bg)"
                            : `${cfg.color}22`,
                          color: on
                            ? "var(--panel-text-muted)"
                            : cfg.color,
                          border: `1px solid ${on ? "var(--panel-border)" : `${cfg.color}55`}`,
                          textDecoration: on ? "line-through" : "none",
                        }}
                        title={on ? `Unmute ${cfg.label}` : `Mute ${cfg.label}`}
                      >
                        {cfg.label}
                      </button>
                    );
                  })}
                </div>
                {muted.size > 0 && (
                  <p className="text-[10px] mt-1.5" style={{ color: "var(--panel-text-muted)" }}>
                    Muted: {muted.size} {muted.size === 1 ? "category" : "categories"}.
                  </p>
                )}
              </div>

              <div className="h-px" style={{ background: "var(--panel-border)" }} />

              <PushSettings />

              <div className="h-px" style={{ background: "var(--panel-border)" }} />

              <div className="flex items-center justify-between">
                <div className="min-w-0 pr-2">
                  <p className="text-xs font-semibold flex items-center gap-1.5" style={{ color: "var(--panel-text)" }}>
                    Predict my commute
                    {!isPro && (
                      <span
                        className="px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider"
                        style={{ background: "rgba(168,85,247,0.18)", color: "#a855f7" }}
                      >
                        Pro
                      </span>
                    )}
                  </p>
                  <p className="text-[10px] leading-snug mt-0.5" style={{ color: "var(--panel-text-muted)" }}>
                    Send a heads-up notification ~10 min before you usually leave for a recurring trip.
                  </p>
                  {!notificationsSupported() && (() => {
                    const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
                    const isIos = /iPhone|iPad|iPod/i.test(ua) ||
                      (typeof navigator !== "undefined" && navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
                    return isIos ? (
                      <button
                        type="button"
                        onClick={() => requestInstallPrompt()}
                        className="text-[10px] mt-1 underline"
                        style={{ color: "#f59e0b" }}
                      >
                        Install CityPulse to your home screen to enable alerts.
                      </button>
                    ) : (
                      <p className="text-[10px] mt-1" style={{ color: "#f59e0b" }}>
                        Your browser doesn&rsquo;t support push notifications.
                      </p>
                    );
                  })()}
                  {commuteNotifyError && (
                    <p className="text-[10px] mt-1" style={{ color: "#ef4444" }}>
                      {commuteNotifyError}
                    </p>
                  )}
                </div>
                <button
                  type="button"
                  onClick={async () => {
                    if (!isPro) {
                      // Free users get the upgrade prompt instead of the
                      // toggle action. Even if they enable in localStorage
                      // the server-side cron (notify_due_commutes) refuses
                      // to fire for non-Pro uids, so this is just UX.
                      requestUpgrade("Commute predictions");
                      return;
                    }
                    setCommuteNotifyError(null);
                    if (commuteNotify) {
                      setCommuteNotificationsEnabled(false);
                      setCommuteNotify(false);
                      return;
                    }
                    const ok = await enableCommuteNotifications();
                    if (!ok) {
                      setCommuteNotifyError(
                        notificationsSupported()
                          ? "Notification permission was denied. Enable it in your browser settings."
                          : "Notifications not supported on this device."
                      );
                      setCommuteNotify(false);
                    } else {
                      setCommuteNotify(true);
                    }
                  }}
                  disabled={!notificationsSupported()}
                  className="shrink-0 disabled:opacity-50"
                  aria-pressed={commuteNotify && isPro}
                  aria-label={commuteNotify ? "Disable commute predictions" : "Enable commute predictions"}
                >
                  <span
                    className="block w-10 h-5 rounded-full relative transition-colors"
                    style={{
                      background: commuteNotify && isPro ? "#a855f7" : "var(--panel-border)",
                    }}
                  >
                    <span
                      className="absolute top-0.5 w-4 h-4 rounded-full bg-white shadow-md transition-transform"
                      style={{ left: commuteNotify && isPro ? "1.375rem" : "0.125rem" }}
                    />
                  </span>
                </button>
              </div>
            </div>
          )}

          <div className="flex-1 overflow-y-auto">
            {alerts.length === 0 ? (
              <div
                className="px-4 py-10 text-center text-xs flex flex-col items-center gap-2"
                style={{ color: "var(--panel-text-muted)" }}
              >
                <Bell className="w-6 h-6 opacity-40" />
                <p>No alerts yet.</p>
                <p className="opacity-70">Off-screen and on-route incidents will appear here.</p>
              </div>
            ) : (
              <ul>
                {alerts.map((a) => {
                  const sev = getSeverity(a.category);
                  return (
                    <li
                      key={a.id}
                      className="border-t first:border-t-0"
                      style={{ borderColor: "var(--panel-border)" }}
                    >
                      <button
                        type="button"
                        onClick={() => {
                          markRead(a.id);
                          onJump(a.incidentId, a.lat, a.lng);
                          onClose();
                        }}
                        className="w-full flex items-start gap-3 px-3 py-2.5 text-left transition-colors"
                        onMouseEnter={(e) => (e.currentTarget.style.background = "var(--panel-hover)")}
                        onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                      >
                        <div
                          className="w-7 h-7 shrink-0 rounded-full flex items-center justify-center mt-0.5"
                          style={{ background: `${sev.color}22`, color: sev.color }}
                        >
                          {a.kind === "ahead" ? (
                            <MapPin className="w-3.5 h-3.5" />
                          ) : (
                            <AlertTriangle className="w-3.5 h-3.5" />
                          )}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center justify-between gap-2">
                            <p
                              className="text-xs font-semibold truncate"
                              style={{ color: a.read ? "var(--panel-text-secondary)" : "var(--panel-text)" }}
                            >
                              {a.title}
                            </p>
                            {!a.read && (
                              <span
                                className="w-1.5 h-1.5 rounded-full shrink-0"
                                style={{ background: sev.color }}
                                aria-hidden="true"
                              />
                            )}
                          </div>
                          <p
                            className="text-[11px] leading-snug truncate mt-0.5"
                            style={{ color: "var(--panel-text-muted)" }}
                          >
                            {a.body}
                          </p>
                          <div className="flex items-center justify-between gap-2 mt-1">
                            <span
                              className="text-[10px] uppercase tracking-wider"
                              style={{ color: "var(--panel-text-muted)" }}
                            >
                              {KIND_LABEL[a.kind]}
                            </span>
                            <span
                              className="text-[10px] tabular-nums"
                              style={{ color: "var(--panel-text-muted)" }}
                            >
                              {fmtAgo(a.ts)}
                            </span>
                          </div>
                        </div>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          {alerts.length > 0 && alerts.some((a) => !a.read) && (
            <button
              type="button"
              onClick={() => markAllRead()}
              className="shrink-0 flex items-center justify-center gap-1.5 px-3 py-2 text-[11px] font-medium transition-colors"
              style={{
                color: "var(--panel-text-secondary)",
                borderTop: "1px solid var(--panel-border)",
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = "var(--panel-hover)")}
              onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
            >
              <Check className="w-3 h-3" /> Mark all read
            </button>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
