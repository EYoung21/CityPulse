"use client";

import { Search } from "lucide-react";

interface Props {
  onClick: () => void;
}

/** Floating "Score this area" pill modeled after Google Maps' "Search this
 *  area". Appears at the top of the map when the user pans/zooms beyond a
 *  threshold from the last action anchor. Tapping it drops a SafetyScoreCard
 *  centered on the current view. */
export default function SearchAreaPill({ onClick }: Props) {
  return (
    <div
      className="pointer-events-none absolute z-[1001] left-1/2 -translate-x-1/2 flex justify-center"
      style={{
        top: "calc(env(safe-area-inset-top, 0px) + 4rem)",
      }}
    >
      <button
        type="button"
        onClick={onClick}
        className="pointer-events-auto inline-flex items-center gap-2 px-4 py-2 rounded-full text-xs font-semibold shadow-2xl backdrop-blur-xl active:scale-95 transition-transform animate-[score-area-in_0.25s_cubic-bezier(0.2,0.9,0.3,1.2)]"
        style={{
          background: "rgba(59, 130, 246, 0.95)",
          color: "#fff",
          border: "1px solid rgba(255,255,255,0.18)",
          boxShadow: "0 8px 32px rgba(59,130,246,0.35), 0 2px 8px rgba(0,0,0,0.2)",
        }}
      >
        <Search className="w-3.5 h-3.5" />
        Score this area
      </button>
      <style jsx>{`
        @keyframes score-area-in {
          0% { opacity: 0; transform: translateY(-8px) scale(0.95); }
          100% { opacity: 1; transform: translateY(0) scale(1); }
        }
      `}</style>
    </div>
  );
}
