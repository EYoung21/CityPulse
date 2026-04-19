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
import { Bell, BellOff, Loader2, Send, AlertTriangle } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import {
  getPushStatus,
  sendTestPush,
  subscribePush,
  unsubscribePush,
  type PushStatus,
} from "@/lib/push-subscriptions";

export default function PushSettings() {
  const { user } = useAuth();
  const [status, setStatus] = useState<PushStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const refresh = async () => {
    setStatus(await getPushStatus());
  };

  useEffect(() => {
    void refresh();
    // Re-check when the auth state changes — flipping from
    // anonymous → signed in unlocks the subscribe affordance.
  }, [user?.uid, user?.isAnonymous]);

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
      const result = await subscribePush();
      setStatus(result.status);
      if (!result.ok) setError(result.reason);
      else setInfo("Subscribed. We'll buzz this device for high-priority alerts.");
    } finally {
      setBusy(false);
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
        <button
          type="button"
          onClick={onTest}
          disabled={busy}
          className="mt-1.5 inline-flex items-center gap-1 px-2 py-1 rounded-md text-[10px] disabled:opacity-50"
          style={{
            background: "var(--panel-input-bg)",
            color: "var(--panel-text-secondary)",
            border: "1px solid var(--panel-border)",
          }}
        >
          <Send className="w-2.5 h-2.5" />
          Send test push
        </button>
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
