"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Drawer } from "vaul";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** When the inner view changes (e.g. user opened Directions) we briefly
   *  bump the sheet to a more useful snap. Pass a key string. */
  expandKey?: string;
  children: ReactNode;
}

/** A mobile-only bottom sheet built on `vaul` with three snap points:
 *
 *   - peek:    140px (just the search pill — map stays mostly visible)
 *   - half:    55%   (default)
 *   - full:    92%
 *
 *  `modal={false}` keeps the map below tappable when the sheet is in
 *  the peek snap, mirroring Google Maps / Apple Maps behavior.
 *
 *  Closing the sheet (drag-to-dismiss) calls `onOpenChange(false)` so the
 *  parent's "open sidebar" button reappears. */
const SNAP_POINTS: (string | number)[] = ["140px", 0.55, 0.92];

export default function MobileSheet({ open, onOpenChange, expandKey, children }: Props) {
  const [snap, setSnap] = useState<number | string | null>(SNAP_POINTS[1]);

  useEffect(() => {
    if (!expandKey) return;
    setSnap(SNAP_POINTS[1]);
  }, [expandKey]);

  return (
    <Drawer.Root
      open={open}
      onOpenChange={onOpenChange}
      snapPoints={SNAP_POINTS}
      activeSnapPoint={snap}
      setActiveSnapPoint={setSnap}
      modal={false}
      shouldScaleBackground={false}
      handleOnly
    >
      <Drawer.Portal>
        <Drawer.Content
          aria-describedby={undefined}
          className="fixed left-0 right-0 bottom-0 z-[2000] flex flex-col rounded-t-2xl outline-none shadow-2xl"
          style={{
            background: "var(--panel-bg)",
            border: "1px solid var(--panel-border)",
            borderBottom: "none",
            color: "var(--panel-text)",
            paddingBottom: "env(safe-area-inset-bottom, 0px)",
            height: "92vh",
            maxHeight: "92dvh",
          }}
        >
          <Drawer.Title className="sr-only">Map controls and incident feed</Drawer.Title>
          <div data-vaul-handle className="flex justify-center pt-2 pb-1 shrink-0 cursor-grab active:cursor-grabbing">
            <div className="w-10 h-1 rounded-full" style={{ background: "var(--panel-text-muted)", opacity: 0.5 }} />
          </div>
          <div className="flex-1 min-h-0 flex flex-col overflow-hidden">{children}</div>
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  );
}
