"use client";

import { Map, Settings, ChevronRight, Users } from "lucide-react";
import { getCurrentCity } from "@/lib/pulse-cities";
import "./login.css";

const siteName = process.env.NEXT_PUBLIC_SITE_NAME || "PHLPulse";
const cityName = process.env.NEXT_PUBLIC_CITY_NAME || "Philadelphia";

interface Props {
  onChoose: (mode: "dashboard" | "admin" | "moderation") => void;
}

export default function AdminLauncher({ onChoose }: Props) {
  const city = getCurrentCity();
  const accentRgb = city.accentRgb ?? "171, 255, 2";
  const accentRgb2 = city.accentRgb2 ?? "224, 255, 160";

  const options = [
    {
      mode: "dashboard" as const,
      title: "Dashboard",
      description: "Live safety map, incidents, routing",
      Icon: Map,
      color: `rgb(${accentRgb})`,
      bg: `rgba(${accentRgb}, 0.12)`,
      border: `rgba(${accentRgb}, 0.26)`,
    },
    {
      mode: "admin" as const,
      title: "Admin Panel",
      description: "Live audio, transcripts, LLM pipeline",
      Icon: Settings,
      color: "#c084fc",
      bg: "rgba(192,132,252,0.12)",
      border: "rgba(192,132,252,0.24)",
    },
    {
      mode: "moderation" as const,
      title: "Moderation",
      description: "User-submitted reports inbox only",
      Icon: Users,
      color: "#38bdf8",
      bg: "rgba(56,189,248,0.12)",
      border: "rgba(56,189,248,0.24)",
    },
  ];

  return (
    <div
      className="lp-login-page"
      style={
        {
          "--accent-rgb": accentRgb,
          "--accent2-rgb": accentRgb2,
        } as React.CSSProperties
      }
    >
      <div className="lp-login-bg" />
      <div className="lp-admin-shell">
        <div className="lp-login-card relative">
          <div className="lp-login-card-inner">
            <div className="lp-login-brand">
              <img src="/logo.png" alt="CityPulse" className="w-12 h-12" />
              <span className="lp-login-wordmark">CityPulse</span>
            </div>
            <div className="lp-login-subhead">
              {siteName} &middot; {cityName} &middot; Admin
            </div>

            <div className="lp-login-divider">
              <div />
              <span>choose view</span>
              <div />
            </div>

            <div className="lp-admin-grid">
              {options.map(({ mode, title, description, Icon, color, bg, border }) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => onChoose(mode)}
                  className="lp-admin-option group"
                  style={{
                    "--option-color": color,
                    "--option-bg": bg,
                    "--option-border": border,
                  } as React.CSSProperties}
                >
                  <div className="lp-admin-optionIcon">
                    <Icon className="w-5 h-5" />
                  </div>
                  <div className="min-w-0 flex-1 text-left">
                    <h2>{title}</h2>
                    <p>{description}</p>
                  </div>
                  <ChevronRight className="w-4 h-4 lp-admin-chevron" />
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
