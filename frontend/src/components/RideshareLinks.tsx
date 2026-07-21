"use client";

import { Car } from "lucide-react";
import { useSyncExternalStore } from "react";

const MOBILE_RIDESHARE_QUERY = "(max-width: 900px)";

function subscribeMobileRideshare(onStoreChange: () => void) {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
  const query = window.matchMedia(MOBILE_RIDESHARE_QUERY);
  if (typeof query.addEventListener === "function") {
    query.addEventListener("change", onStoreChange);
    return () => query.removeEventListener("change", onStoreChange);
  }
  if (typeof query.addListener === "function") {
    query.addListener(onStoreChange);
    return () => query.removeListener(onStoreChange);
  }
  return () => {};
}

function getMobileRideshareSnapshot() {
  return typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia(MOBILE_RIDESHARE_QUERY).matches;
}

interface Props {
  destLat: number;
  destLng: number;
  destName?: string;
  originLat?: number;
  originLng?: number;
}

/** Tiny row of "Open in Uber / Lyft" deep-link buttons. We use the
 *  universal-link form for both apps so iOS / Android route to the
 *  installed app and fall back to the web flow. No SDK required.
 *
 *  Uber: https://m.uber.com/ul/?action=setPickup&...
 *  Lyft: https://lyft.com/ride?...
 */
export default function RideshareLinks({
  destLat,
  destLng,
  destName,
  originLat,
  originLng,
}: Props) {
  // Only render when at least one ridesharing service is plausibly
  // useful — i.e. on a phone-sized screen. On desktop the deep links
  // mostly bounce to a browser, which is noisier than helpful.
  const shouldRender = useSyncExternalStore(
    subscribeMobileRideshare,
    getMobileRideshareSnapshot,
    () => false
  );
  if (!shouldRender) return null;

  const dropName = destName ? destName.split(",")[0].slice(0, 80) : "Drop-off";
  const uberPickup =
    originLat != null && originLng != null
      ? `&pickup[latitude]=${originLat}&pickup[longitude]=${originLng}`
      : "&pickup=my_location";
  const uberUrl =
    "https://m.uber.com/ul/?action=setPickup" +
    uberPickup +
    `&dropoff[latitude]=${destLat}` +
    `&dropoff[longitude]=${destLng}` +
    `&dropoff[nickname]=${encodeURIComponent(dropName)}`;
  const lyftUrl =
    "https://lyft.com/ride?id=lyft" +
    `&destination[latitude]=${destLat}` +
    `&destination[longitude]=${destLng}` +
    (originLat != null && originLng != null
      ? `&pickup[latitude]=${originLat}&pickup[longitude]=${originLng}`
      : "");

  return (
    <div className="mt-3 flex items-stretch gap-2">
      <p
        className="self-center text-[10px] uppercase tracking-wider font-semibold shrink-0 px-1"
        style={{ color: "var(--panel-text-muted)" }}
      >
        Or call a ride
      </p>
      <a
        href={uberUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-full text-xs font-semibold transition-all active:scale-[0.98]"
        style={{
          background: "#000",
          color: "#fff",
        }}
        aria-label="Open this trip in Uber"
      >
        <Car className="w-3.5 h-3.5" /> Uber
      </a>
      <a
        href={lyftUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-full text-xs font-semibold transition-all active:scale-[0.98]"
        style={{
          background: "#FF00BF",
          color: "#fff",
        }}
        aria-label="Open this trip in Lyft"
      >
        <Car className="w-3.5 h-3.5" /> Lyft
      </a>
    </div>
  );
}
