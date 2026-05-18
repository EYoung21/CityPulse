"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Drawer } from "vaul";
import { ArrowLeft } from "lucide-react";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** When the inner view changes (e.g. user opened Directions) we briefly
   *  bump the sheet to a more useful snap. Pass a key string. */
  expandKey?: string;
  /** Route planning / active trip sheets need the full bottom edge for
   *  primary controls, so they sit above the app's mobile tab bar. */
  coverBottomNav?: boolean;
  /** Some child views, like a selected-place card, should open high enough
   *  that their primary action is immediately reachable. */
  preferExpanded?: boolean;
  children: ReactNode;
}

/** A mobile-only bottom sheet built on `vaul`.
 *
 *  Snap points:
 *    - peek:        140px (just the search pill — map mostly visible)
 *    - half:        55%   (default)
 *    - expanded:    92%   (drag-up via the handle)
 *    - fullscreen:  100%  (auto, only when a text input is focused)
 *
 *  The fullscreen snap mirrors Google Maps' "search takeover": tap the
 *  input, the sheet becomes the whole screen — map hidden, bottom nav
 *  hidden, dedicated back arrow replaces the drag handle. Drag-down is
 *  intentionally disabled in this mode so a stray finger doesn't drop
 *  you out mid-typing; the back arrow is the only exit.
 *
 *  `modal={false}` keeps the map below tappable at peek/half snaps,
 *  matching native maps. Closing the sheet (drag-to-dismiss) calls
 *  `onOpenChange(false)` so the parent's "open sidebar" button
 *  reappears. */
const SNAP_POINTS: (string | number)[] = ["140px", 0.55, 0.92, 1];
const HALF = SNAP_POINTS[1];
const EXPANDED = SNAP_POINTS[2];
const FULLSCREEN = SNAP_POINTS[3];

function snapToVisibleHeight(snap: number | string | null): string {
  const active = snap ?? HALF;
  if (typeof active === "string") return active;
  return `${Math.round(active * 100)}dvh`;
}

export default function MobileSheet({
  open,
  onOpenChange,
  expandKey,
  coverBottomNav = false,
  preferExpanded = false,
  children,
}: Props) {
  const [snap, setSnap] = useState<number | string | null>(HALF);
  const isFullscreen = snap === FULLSCREEN;
  const contentRef = useRef<HTMLDivElement | null>(null);
  const visibleHeight = snapToVisibleHeight(snap);
  const sheetChromeHeight = isFullscreen ? "44px" : "28px";

  useEffect(() => {
    if (!expandKey) return;
    const id = window.setTimeout(() => {
      setSnap(coverBottomNav || preferExpanded ? EXPANDED : HALF);
    }, 0);
    return () => window.clearTimeout(id);
  }, [expandKey, coverBottomNav, preferExpanded]);

  /** Track the on-screen keyboard height via VisualViewport so the
   *  sheet's scrollable content can pad above it. Exported as a CSS
   *  var so other descendants can react too. */
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
      document.documentElement.style.setProperty("--pp-keyboard-h", "0px");
    };
  }, []);

  /** Toggle a global CSS hook when in fullscreen-search mode so other
   *  surfaces (notably MobileBottomNav) can hide themselves without
   *  prop-drilling. globals.css owns the actual `display: none`. */
  useEffect(() => {
    const cls = "pp-mobile-search-fullscreen";
    if (isFullscreen) {
      document.documentElement.classList.add(cls);
    } else {
      document.documentElement.classList.remove(cls);
    }
    return () => document.documentElement.classList.remove(cls);
  }, [isFullscreen]);

  useEffect(() => {
    const cls = "pp-mobile-sheet-over-nav";
    if (open && coverBottomNav) {
      document.documentElement.classList.add(cls);
    } else {
      document.documentElement.classList.remove(cls);
    }
    return () => document.documentElement.classList.remove(cls);
  }, [open, coverBottomNav]);

  /** When the user focuses an input inside the sheet, snap to
   *  fullscreen. Capture-phase listener catches any descendant
   *  without each one wiring up a callback. */
  const handleFocusCapture = (e: React.FocusEvent) => {
    const target = e.target as HTMLElement | null;
    if (!target) return;
    const isText =
      target.tagName === "INPUT" ||
      target.tagName === "TEXTAREA" ||
      target.isContentEditable;
    if (!isText) return;
    if (target.tagName === "INPUT") {
      const t = (target as HTMLInputElement).type;
      if (t && !["text", "search", "email", "tel", "url", "number", ""].includes(t)) {
        return;
      }
    }
    setSnap(FULLSCREEN);
  };

  const exitFullscreen = () => {
    // Blur whatever input is focused so the keyboard dismisses,
    // otherwise the keyboard hangs around and re-triggers fullscreen
    // on the next tap that hits the input.
    if (typeof document !== "undefined") {
      const active = document.activeElement as HTMLElement | null;
      if (active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA")) {
        active.blur();
      }
    }
    // Reset snap so the next time the sheet opens, it's at half (not
    // stuck at fullscreen from the last session).
    setSnap(HALF);
    // Google Maps' back arrow returns to the map view, not to a
    // half-open sheet. Fully dismiss; the parent's "open menu" FAB
    // brings the sheet back when the user wants it.
    onOpenChange(false);
  };

  /** When focus leaves an input and nothing else inside the sheet is
   *  focused, drop out of fullscreen. This is what lets "tap a search
   *  result → directions panel opens" feel right: SearchInput blurs
   *  the input on select, we snap back to half here, and the user
   *  sees the route preview on the map instead of a fullscreen sheet
   *  hiding it. */
  const handleBlurCapture = (e: React.FocusEvent) => {
    const target = e.target as HTMLElement | null;
    if (!target) return;
    const wasText =
      target.tagName === "INPUT" || target.tagName === "TEXTAREA";
    if (!wasText) return;
    // Defer so the next focus (e.g. tab between inputs) has time to
    // land. If focus moved to another text input inside the sheet,
    // we leave the snap alone.
    window.setTimeout(() => {
      const active = document.activeElement as HTMLElement | null;
      const sheetEl = contentRef.current;
      const stillTextInside =
        active &&
        sheetEl?.contains(active) &&
        (active.tagName === "INPUT" || active.tagName === "TEXTAREA");
      if (!stillTextInside) {
        setSnap((s) =>
          s === FULLSCREEN ? (coverBottomNav || preferExpanded ? EXPANDED : HALF) : s
        );
      }
    }, 0);
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
      handleOnly={isFullscreen}
    >
      <Drawer.Portal>
        <Drawer.Content
          ref={contentRef}
          aria-describedby={undefined}
          className="fixed left-0 right-0 bottom-0 z-[2000] flex flex-col outline-none shadow-2xl"
          style={{
            zIndex: coverBottomNav ? "var(--pp-z-mobile-menu)" : 2000,
            background: "var(--panel-bg)",
            border: "1px solid var(--panel-border)",
            borderBottom: "none",
            color: "var(--panel-text)",
            // Fullscreen takes the whole viewport (incl. safe areas);
            // otherwise we stop at 92dvh to leave the map peeking and
            // keep the iOS Safari URL bar happy.
            paddingBottom: "env(safe-area-inset-bottom, 0px)",
            paddingTop: isFullscreen ? "env(safe-area-inset-top, 0px)" : 0,
            borderTopLeftRadius: isFullscreen ? 0 : "1rem",
            borderTopRightRadius: isFullscreen ? 0 : "1rem",
            height: isFullscreen ? "100dvh" : "92dvh",
            maxHeight: isFullscreen ? "100dvh" : "92dvh",
            // Tiny opacity-style transition so the corner rounding /
            // top padding change feels intentional, not a snap.
            transition: "border-radius 180ms ease, padding-top 180ms ease",
          }}
          onFocusCapture={handleFocusCapture}
          onBlurCapture={handleBlurCapture}
        >
          <Drawer.Title className="sr-only">Map controls and incident feed</Drawer.Title>

          {isFullscreen ? (
            // Fullscreen "search takeover" header: back arrow on the
            // left, no drag handle. Sheet is non-draggable here; user
            // exits via the arrow (which also blurs the input).
            <div className="flex items-center shrink-0 px-1.5 py-1.5">
              <button
                type="button"
                onClick={exitFullscreen}
                aria-label="Close search"
                className="p-2 rounded-full"
                style={{ color: "var(--panel-text)" }}
              >
                <ArrowLeft className="w-5 h-5" />
              </button>
            </div>
          ) : (
            // Standard drag handle. The sheet itself remains draggable;
            // avoiding data-vaul-handle here prevents Vaul's default
            // handle bar from stacking with our custom hit area.
            <div
              className="flex flex-col items-center justify-center shrink-0 cursor-grab active:cursor-grabbing"
              aria-hidden="true"
              style={{ minHeight: 30, paddingTop: 12, paddingBottom: 7 }}
            >
              <div
                className="w-11 h-1.5 rounded-full"
                style={{ background: "var(--panel-text-muted)", opacity: 0.42 }}
              />
            </div>
          )}

          <div
            className="flex-1 min-h-0 flex flex-col overflow-hidden"
            style={{
              height: `calc(${visibleHeight} - ${sheetChromeHeight})`,
              maxHeight: `calc(${visibleHeight} - ${sheetChromeHeight})`,
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
