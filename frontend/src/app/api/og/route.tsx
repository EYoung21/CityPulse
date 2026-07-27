import { ImageResponse } from "next/og";
import { NextRequest } from "next/server";
import { trustedRequestOrigin } from "@/lib/request-origin";
import { citySiteName, getCityForRequestHost } from "@/lib/pulse-cities";

export const runtime = "edge";

const SEVERITY_COLOR: Record<string, string> = {
  violent_weapon: "#ef4444",
  violent_no_weapon: "#ef4444",
  shots_heard: "#ef4444",
  robbery: "#ef4444",
  burglary_in_progress: "#ef4444",
  fire_hazmat: "#fb923c",
  medical_priority: "#f472b6",
  medical_other: "#f472b6",
  traffic_crash_injury: "#3b82f6",
  traffic_crash_no_injury: "#3b82f6",
  disorder: "#8b5cf6",
  admin_or_noise: "#8b5cf6",
};

function categoryLabel(c: string): string {
  return c.replace(/_/g, " ").replace(/\b\w/g, (l) => l.toUpperCase());
}

function relTime(iso: string): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "";
  const diffMs = Date.now() - t;
  const m = Math.floor(diffMs / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hr ago`;
  const d = Math.floor(h / 24);
  return `${d} day${d > 1 ? "s" : ""} ago`;
}

/** Renders a 1200×630 OG card for social-link unfurling.
 *
 *  Query params (all optional):
 *    title    — incident headline / location text
 *    category — severity category slug (drives the accent color)
 *    location — secondary line (street, neighborhood)
 *    time     — ISO timestamp; rendered as "X min ago"
 *    score    — 0..100 safety score, when present switches to a place card
 *
 *  Falls back to the brand card when no params are given. */
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const title = searchParams.get("title")?.slice(0, 120) || "Live Safety Map";
  const category = searchParams.get("category")?.slice(0, 64) || "";
  const location = searchParams.get("location")?.slice(0, 80) || "";
  const time = searchParams.get("time")?.slice(0, 64) || "";
  const city = getCityForRequestHost(req.headers.get("host"));
  const cityName = city.name.slice(0, 100);
  const brand = citySiteName(city).slice(0, 100);

  const accent = SEVERITY_COLOR[category] || "#3b82f6";
  const catLabel = category ? categoryLabel(category) : "CityPulse";
  const timeLabel = time ? relTime(time) : "";
  const logoUrl = new URL(
    "/logo.png",
    trustedRequestOrigin(req.headers.get("host")),
  ).toString();

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          background: "linear-gradient(135deg, #0a0a14 0%, #131325 100%)",
          color: "#fff",
          fontFamily: "system-ui, -apple-system, Segoe UI, Helvetica, sans-serif",
          padding: "64px",
          position: "relative",
        }}
      >
        <div
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            height: "8px",
            background: `linear-gradient(90deg, ${accent}, transparent)`,
          }}
        />

        <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={logoUrl}
            alt=""
            width={56}
            height={56}
            style={{ display: "block" }}
          />
          <div style={{ display: "flex", flexDirection: "column" }}>
            <span style={{ fontSize: 22, fontWeight: 700, letterSpacing: 1 }}>
              {brand}
            </span>
            <span style={{ fontSize: 14, color: "#94a3b8", letterSpacing: 2, textTransform: "uppercase" }}>
              {cityName}
            </span>
          </div>
        </div>

        {category && (
          <div
            style={{
              alignSelf: "flex-start",
              marginTop: 56,
              padding: "8px 18px",
              borderRadius: 999,
              background: `${accent}26`,
              border: `1px solid ${accent}66`,
              color: accent,
              fontSize: 18,
              fontWeight: 700,
              letterSpacing: 2,
              textTransform: "uppercase",
              display: "flex",
            }}
          >
            {catLabel}
          </div>
        )}

        <div
          style={{
            display: "flex",
            flexDirection: "column",
            marginTop: category ? 24 : 80,
            flex: 1,
            justifyContent: "center",
          }}
        >
          <div
            style={{
              fontSize: 64,
              fontWeight: 700,
              lineHeight: 1.05,
              letterSpacing: "-0.02em",
            }}
          >
            {title}
          </div>
          {(location || timeLabel) && (
            <div
              style={{
                marginTop: 20,
                fontSize: 26,
                color: "#cbd5e1",
                display: "flex",
                gap: 16,
                alignItems: "center",
              }}
            >
              {location && <span>📍 {location}</span>}
              {location && timeLabel && (
                <span style={{ color: "#475569" }}>·</span>
              )}
              {timeLabel && <span>🕒 {timeLabel}</span>}
            </div>
          )}
        </div>

        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            color: "#64748b",
            fontSize: 18,
            marginTop: 24,
          }}
        >
          <span>Live community safety information</span>
          <span style={{ color: accent, fontWeight: 600 }}>→ Open CityPulse</span>
        </div>
      </div>
    ),
    { width: 1200, height: 630 }
  );
}
