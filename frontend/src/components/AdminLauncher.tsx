"use client";

import { Map, Settings, ChevronRight, Users } from "lucide-react";

const siteName = process.env.NEXT_PUBLIC_SITE_NAME || "PHLPulse";

interface Props {
  onChoose: (mode: "dashboard" | "admin" | "moderation") => void;
}

export default function AdminLauncher({ onChoose }: Props) {
  return (
    <div
      className="min-h-screen flex flex-col items-center justify-center p-6 relative overflow-hidden"
      style={{ background: "linear-gradient(to bottom right, #060611, #0a0a16, #060a16)" }}
    >
      <div className="flex items-center gap-3 mb-2 z-10">
        <img src="/logo.png" alt="CityPulse" className="w-10 h-10" />
        <h1
          className="text-2xl font-bold tracking-tight"
          style={{ color: "var(--panel-text, #e5e7eb)" }}
        >
          CityPulse
          <span className="font-normal" style={{ color: "var(--panel-text-muted, #6b7280)" }}> — </span>
          <span className="text-xl">{siteName}</span>
        </h1>
      </div>
      <p
        className="text-sm mb-10 z-10"
        style={{ color: "var(--panel-text-muted, #6b7280)" }}
      >
        Choose your view
      </p>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 w-full max-w-3xl z-10">
        <button
          onClick={() => onChoose("dashboard")}
          className="group flex flex-col items-start gap-4 p-6 rounded-2xl transition-all hover:scale-[1.02] active:scale-[0.98] relative overflow-hidden"
          style={{
            background: "rgba(255,255,255,0.02)",
            border: "1px solid rgba(255,255,255,0.06)",
            backdropFilter: "blur(12px)",
            boxShadow: "0 8px 32px rgba(0,0,0,0.5)",
          }}
        >
          <div className="absolute inset-0 bg-gradient-radial from-blue-500/10 to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
          <div className="w-12 h-12 rounded-xl bg-blue-500/15 flex items-center justify-center relative z-10">
            <Map className="w-6 h-6 text-blue-500" />
          </div>
          <div className="text-left relative z-10">
            <h2
              className="text-base font-semibold text-white"
            >
              Dashboard
            </h2>
            <p
              className="text-xs mt-1 text-gray-400"
            >
              Live safety map, incidents, routing
            </p>
          </div>
          <ChevronRight
            className="w-4 h-4 self-end opacity-30 group-hover:opacity-70 transition-opacity text-gray-400 relative z-10"
          />
        </button>

        <button
          onClick={() => onChoose("admin")}
          className="group flex flex-col items-start gap-4 p-6 rounded-2xl transition-all hover:scale-[1.02] active:scale-[0.98] relative overflow-hidden"
          style={{
            background: "rgba(255,255,255,0.02)",
            border: "1px solid rgba(168,85,247,0.2)",
            backdropFilter: "blur(12px)",
            boxShadow: "0 8px 32px rgba(0,0,0,0.5)",
          }}
        >
          <div className="absolute inset-0 bg-gradient-radial from-purple-500/10 to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
          <div className="w-12 h-12 rounded-xl bg-purple-500/15 flex items-center justify-center relative z-10">
            <Settings className="w-6 h-6 text-purple-400" />
          </div>
          <div className="text-left relative z-10">
            <h2
              className="text-base font-semibold text-white"
            >
              Admin Panel
            </h2>
            <p
              className="text-xs mt-1 text-gray-400"
            >
              Live audio, transcripts, LLM pipeline
            </p>
          </div>
          <ChevronRight
            className="w-4 h-4 self-end opacity-30 group-hover:opacity-70 transition-opacity text-gray-400 relative z-10"
          />
        </button>

        <button
          onClick={() => onChoose("moderation")}
          className="group flex flex-col items-start gap-4 p-6 rounded-2xl transition-all hover:scale-[1.02] active:scale-[0.98] relative overflow-hidden"
          style={{
            background: "rgba(255,255,255,0.02)",
            border: "1px solid rgba(168,85,247,0.2)",
            backdropFilter: "blur(12px)",
            boxShadow: "0 8px 32px rgba(0,0,0,0.5)",
          }}
        >
          <div className="absolute inset-0 bg-gradient-radial from-purple-500/10 to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
          <div className="w-12 h-12 rounded-xl bg-purple-500/15 flex items-center justify-center relative z-10">
            <Users className="w-6 h-6 text-purple-400" />
          </div>
          <div className="text-left relative z-10">
            <h2
              className="text-base font-semibold text-white"
            >
              Moderation
            </h2>
            <p
              className="text-xs mt-1 text-gray-400"
            >
              User reports + in-app feedback triage
            </p>
          </div>
          <ChevronRight
            className="w-4 h-4 self-end opacity-30 group-hover:opacity-70 transition-opacity text-gray-400 relative z-10"
          />
        </button>
      </div>
    </div>
  );
}
