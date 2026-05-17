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

  /** Track the on-screen keyboard height via VisualViewport. iOS
   *  Safari + Android Chrome both shrink visualViewport.height when
   *  the keyboard opens; window.innerHeight does not. The diff is
   *  the keyboard height (plus any URL-bar collapse, which is fine
   *  to treat as keyboard space — same UX outcome).
   *
   *  Published as --pp-keyboard-h so any descendant can pad its
   *  bottom by this amount. The sheet's scrollable content uses it
   *  below; AlertToast etc. don't need it. */
  useEffect(() => {
    if (typeof window === "undefined" || !window.visualViewport) return;
    const vv = window.visualViewport;
    const apply = () => {
      const diff = Math.max(0, Math.round(window.innerHeight - vv.height));
      document.documentElement.style.setProperty("--pp-keyboard-h", `${diff}px`);
    };
    apply();
    vv.addEventListener("resize", apply);
    vv.addEventListener("scroll", apply);
    return () => {
      vv.removeEventListener("resize", apply);
      vv.removeEventListener("scroll", apply);
      // Reset to 0 on unmount so other surfaces don't inherit a stale
      // keyboard offset (the sheet may be torn down while the keyboard
      // is still rising on input focus).
      document.documentElement.style.setProperty("--pp-keyboard-h", "0px");
    };
  }, []);

  /** When the user focuses an input inside the sheet (search, address
   *  inputs in Directions, etc.), expand to the largest snap so the
   *  result list is visible above the keyboard. The capture-phase
   *  listener catches focuses from any descendant without each one
   *  having to wire up a callback. */
  const handleFocusCapture = (e: React.FocusEvent) => {
    const target = e.target as HTMLElement | null;
    if (!target) return;
    const isText =
      target.tagName === "INPUT" ||
      target.tagName === "TEXTAREA" ||
      target.isContentEditable;
    if (!isText) return;
    // Inputs of type=button/checkbox/etc should not trigger expand.
    if (target.tagName === "INPUT") {
      const t = (target as HTMLInputElement).type;
      if (t && !["text", "search", "email", "tel", "url", "number", ""].includes(t)) {
        return;
      }
    }
    setSnap(SNAP_POINTS[2]);
  };

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
          onFocusCapture={handleFocusCapture}
        >
          <Drawer.Title className="sr-only">Map controls and incident feed</Drawer.Title>
          {/* Drag handle — sized for a comfortable 44px touch target.
              The visible bar is small for design, but the surrounding
              tap zone is fat so users don't have to pixel-hunt to
              swipe the sheet up. vaul's `handleOnly` mode requires
              `[data-vaul-handle]` and respects this element's whole
              bounding box, not just the inner bar. */}
          <div
            data-vaul-handle
            className="flex flex-col items-center justify-center shrink-0 cursor-grab active:cursor-grabbing"
            style={{ minHeight: 28, paddingTop: 10, paddingBottom: 6 }}
          >
            <div className="w-12 h-1.5 rounded-full" style={{ background: "var(--panel-text-muted)", opacity: 0.55 }} />
          </div>
          <div
            className="flex-1 min-h-0 flex flex-col overflow-hidden"
            style={{
              // Pad the inner content so the on-screen keyboard never
              // buries the bottom of the sheet's result list.
              paddingBottom: "var(--pp-keyboard-h, 0px)",
            }}
          >
            {children}
          </div>
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  );
}
