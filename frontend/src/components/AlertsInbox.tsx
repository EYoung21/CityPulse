"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, Bell, Check, MapPin, Trash2, X } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import {
  clearAlerts,
  getAlerts,
  markAllRead,
  markRead,
  subscribeAlerts,
  type InboxAlert,
} from "@/lib/alerts-inbox";
import { getSeverity } from "@/lib/severity";

interface Props {
  open: boolean;
  onClose: () => void;
  onJump: (incidentId: string, lat: number, lng: number) => void;
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
export default function AlertsInbox({ open, onClose, onJump }: Props) {
  const [alerts, setAlerts] = useState<InboxAlert[]>([]);

  useEffect(() => {
    setAlerts(getAlerts());
    const unsub = subscribeAlerts(setAlerts);
    return unsub;
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
            <p className="text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--panel-text-muted)" }}>
              Alerts ({alerts.length})
            </p>
            <div className="flex items-center gap-1">
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
