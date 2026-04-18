"use client";

import { LocateFixed } from "lucide-react";

interface Props {
  onClick: () => void;
}

/** "Re-center" pill shown during an active trip after the user manually
 *  pans the map (turning off follow-me). Tapping it pans back to the
 *  user's current GPS location and re-enables follow-me. */
export default function RecenterPill({ onClick }: Props) {
  return (
    <div
      className="pointer-events-none absolute z-[1001] left-1/2 -translate-x-1/2 flex justify-center"
      style={{
        bottom: "calc(env(safe-area-inset-bottom, 0px) + 7.5rem)",
      }}
    >
      <button
        type="button"
        onClick={onClick}
        className="pointer-events-auto inline-flex items-center gap-2 px-4 py-2 rounded-full text-xs font-semibold shadow-2xl backdrop-blur-xl active:scale-95 transition-transform animate-[recenter-in_0.25s_cubic-bezier(0.2,0.9,0.3,1.2)]"
        style={{
          background: "rgba(34,197,94,0.95)",
          color: "#fff",
          border: "1px solid rgba(255,255,255,0.18)",
          boxShadow: "0 8px 32px rgba(34,197,94,0.35), 0 2px 8px rgba(0,0,0,0.2)",
        }}
        aria-label="Re-center map on my location"
      >
        <LocateFixed className="w-3.5 h-3.5" />
        Re-center
      </button>
      <style jsx>{`
        @keyframes recenter-in {
          0%   { opacity: 0; transform: translateY(8px) scale(0.95); }
          100% { opacity: 1; transform: translateY(0)   scale(1);   }
        }
      `}</style>
    </div>
  );
}
