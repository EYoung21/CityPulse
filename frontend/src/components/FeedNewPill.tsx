"use client";

interface Props {
  count: number;
  onJump: () => void;
}

export default function FeedNewPill({ count, onJump }: Props) {
  if (count <= 0) return null;
  return (
    <button
      type="button"
      onClick={onJump}
      className="fixed left-1/2 -translate-x-1/2 z-40 px-4 py-2 rounded-full text-xs font-semibold shadow-lg"
      style={{
        top: "calc(env(safe-area-inset-top, 0px) + 72px)",
        background: "#3b82f6",
        color: "#fff",
      }}
    >
      {count} new incident{count === 1 ? "" : "s"}
    </button>
  );
}
