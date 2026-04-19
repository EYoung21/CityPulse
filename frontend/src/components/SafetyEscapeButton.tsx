"use client";

import { ShieldAlert } from "lucide-react";

interface Props {
  onClick: () => void;
  active?: boolean;
}

/** Floating "Get to safety" trigger.
 *
 *  Distinct red shield in the bottom-right control column so a user in
 *  distress can find it at a glance without scanning the rest of the
 *  UI. The breathing pulse is subtle (~3.6s loop) — enough to register
 *  as "this is here for you" without becoming a distracting alert.
 *
 *  Tapping opens `<SafetyEscapePanel>`, which is where the actual
 *  decision-making happens; this button is purely a visual anchor.
 */
export default function SafetyEscapeButton({ onClick, active }: Props) {
  return (
    <button
      type="button"
      onClick={onClick}
      title="Get to safety"
      aria-label="Get to safety"
      aria-pressed={active}
      className="relative w-10 h-10 flex items-center justify-center rounded-lg backdrop-blur-md shadow-lg transition-colors active:scale-95"
      style={{
        background: active
          ? "linear-gradient(135deg, rgba(239,68,68,0.95), rgba(249,115,22,0.95))"
          : "var(--pill-bg)",
        border: `1px solid ${active ? "rgba(239,68,68,0.6)" : "rgba(239,68,68,0.45)"}`,
        color: active ? "#fff" : "#ef4444",
      }}
    >
      <ShieldAlert className="w-4 h-4 relative z-10" />
      {!active && (
        <span
          aria-hidden="true"
          className="absolute inset-0 rounded-lg pointer-events-none animate-[se-pulse_3.6s_ease-in-out_infinite]"
          style={{
            boxShadow: "0 0 0 0 rgba(239,68,68,0.45)",
          }}
        />
      )}
      <style jsx>{`
        @keyframes se-pulse {
          0%   { box-shadow: 0 0 0 0 rgba(239,68,68,0.40); }
          70%  { box-shadow: 0 0 0 10px rgba(239,68,68,0); }
          100% { box-shadow: 0 0 0 0 rgba(239,68,68,0); }
        }
      `}</style>
    </button>
  );
}
