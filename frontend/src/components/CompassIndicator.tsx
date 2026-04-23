"use client";

/** A small "you are facing this way" compass overlay.
 *
 *  Leaflet doesn't rotate the basemap, so the map is always north-up.
 *  That makes the typical "compass that resets the map heading" tap
 *  affordance pointless — there's no rotation to reset. What _is_
 *  useful on a north-up map is showing which direction the user's
 *  body is currently facing relative to the map: pedestrian
 *  navigation feels much more natural when you can sanity-check
 *  "yes, the road I should turn down is on my right."
 *
 *  The face stays static with N at the top (matching the map) and a
 *  red arrow rotates inside it to indicate the user's heading. We
 *  hide the whole control when no heading is available so we don't
 *  clutter the UI with a non-functional knob — iOS users who never
 *  granted compass permission will simply never see it.
 */

import { useMemo } from "react";

interface Props {
  /** Heading in degrees clockwise from true north, or null when the
   *  device hasn't reported one yet. The page already gates the
   *  underlying `useDeviceHeading` hook on having a userLocation, so
   *  we don't need to re-check that here. */
  heading: number | null;
  /** Optional click handler — used by the parent to recenter the map
   *  on the user when the compass is tapped, mirroring Google Maps'
   *  behavior. Compass without an action still has value as a
   *  status indicator, so we make this optional. */
  onClick?: () => void;
}

export default function CompassIndicator({ heading, onClick }: Props) {
  // Rounding to a degree keeps the inline transform string stable
  // across re-renders — important because Leaflet panes around us
  // re-render frequently and unique transform strings would defeat
  // the browser's compositor cache.
  const arrowRotation = useMemo(
    () => (heading == null ? 0 : Math.round(heading)),
    [heading]
  );

  if (heading == null) return null;

  const cardinal =
    arrowRotation < 22 || arrowRotation >= 338
      ? "N"
      : arrowRotation < 67
        ? "NE"
        : arrowRotation < 113
          ? "E"
          : arrowRotation < 158
            ? "SE"
            : arrowRotation < 202
              ? "S"
              : arrowRotation < 247
                ? "SW"
                : arrowRotation < 293
                  ? "W"
                  : "NW";

  const ariaLabel = `Compass · facing ${cardinal} (${arrowRotation}°)`;

  const Inner = (
    <div
      className="relative w-10 h-10 rounded-full backdrop-blur-md shadow-lg flex items-center justify-center"
      style={{
        background: "var(--pill-bg)",
        border: "1px solid var(--pill-border)",
      }}
      role="img"
      aria-label={ariaLabel}
      title={ariaLabel}
    >
      <span
        className="absolute top-0.5 left-1/2 -translate-x-1/2 text-[8px] font-bold leading-none"
        style={{ color: "#ef4444" }}
        aria-hidden="true"
      >
        N
      </span>
      <svg
        viewBox="0 0 24 24"
        className="w-5 h-5 transition-transform duration-200 ease-out"
        style={{ transform: `rotate(${arrowRotation}deg)` }}
        aria-hidden="true"
      >
        <path
          d="M12 3 L15 14 L12 12 L9 14 Z"
          fill="#ef4444"
          stroke="#7f1d1d"
          strokeWidth="0.6"
          strokeLinejoin="round"
        />
        <circle cx="12" cy="12" r="1.5" fill="var(--panel-text-muted)" />
      </svg>
    </div>
  );

  if (!onClick) return Inner;

  return (
    <button
      type="button"
      onClick={onClick}
      className="active:scale-95 transition-transform"
      aria-label={`${ariaLabel}. Tap to recenter on your location.`}
    >
      {Inner}
    </button>
  );
}
