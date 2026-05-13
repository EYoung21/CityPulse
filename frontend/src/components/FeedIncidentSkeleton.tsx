"use client";

export default function FeedIncidentSkeleton({ count = 6, immersive = false }: { count?: number; immersive?: boolean }) {
  return (
    <div className="flex flex-col gap-2 px-3 py-2" aria-hidden>
      {Array.from({ length: count }).map((_, i) => (
        <div
          key={i}
          className={`rounded-xl animate-pulse ${immersive ? "h-28" : "h-20"}`}
          style={{ background: "var(--panel-input-bg, rgba(255,255,255,0.05))" }}
        />
      ))}
    </div>
  );
}
