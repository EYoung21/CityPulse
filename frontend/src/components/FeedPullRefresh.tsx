"use client";

import { useCallback, useRef, useState, type ReactNode } from "react";
import { Loader2 } from "lucide-react";

interface Props {
  onRefresh: () => Promise<void> | void;
  children: ReactNode;
  className?: string;
  onScroll?: (nearTop: boolean) => void;
}

const PULL_THRESHOLD = 72;

export default function FeedPullRefresh({ onRefresh, children, className = "", onScroll }: Props) {
  const [pullPx, setPullPx] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const startYRef = useRef<number | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    onScroll?.(el.scrollTop < 48);
  }, [onScroll]);

  const finishRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await onRefresh();
    } finally {
      setRefreshing(false);
      setPullPx(0);
    }
  }, [onRefresh]);

  return (
    <div className={`flex flex-col min-h-0 ${className}`}>
      <div
        className="pointer-events-none flex items-end justify-center overflow-hidden transition-[height] duration-150"
        style={{ height: refreshing ? 40 : Math.max(0, pullPx * 0.45) }}
      >
        {(pullPx > 12 || refreshing) && (
          <Loader2
            className={`w-4 h-4 ${refreshing || pullPx > PULL_THRESHOLD ? "animate-spin" : ""}`}
            style={{ color: "var(--panel-text-muted)" }}
          />
        )}
      </div>
      <div
        ref={scrollRef}
        className="h-full overflow-y-auto"
        onScroll={handleScroll}
        onTouchStart={(e) => {
          if (scrollRef.current && scrollRef.current.scrollTop <= 0) {
            startYRef.current = e.touches[0]?.clientY ?? null;
          }
        }}
        onTouchMove={(e) => {
          if (startYRef.current == null || refreshing) return;
          const y = e.touches[0]?.clientY ?? startYRef.current;
          const delta = y - startYRef.current;
          if (delta > 0 && scrollRef.current && scrollRef.current.scrollTop <= 0) {
            setPullPx(Math.min(delta, 120));
          }
        }}
        onTouchEnd={() => {
          if (pullPx >= PULL_THRESHOLD && !refreshing) void finishRefresh();
          else setPullPx(0);
          startYRef.current = null;
        }}
      >
        {children}
      </div>
    </div>
  );
}
