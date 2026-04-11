"use client";

import type { Incident } from "@/lib/api";
import { getSeverity } from "@/lib/severity";
import { AlertTriangle, MapPin, Clock, Brain, Shield, X, Radio } from "lucide-react";

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

interface Props {
  incident: Incident;
  onClose: () => void;
}

export default function IncidentDetail({ incident, onClose }: Props) {
  const sev = getSeverity(incident.severity_category);
  const confidencePct = Math.round(incident.confidence * 100);

  return (
    <div
      className="rounded-xl overflow-hidden backdrop-blur-xl shadow-2xl"
      style={{ background: "var(--panel-bg)", border: "1px solid var(--panel-border)" }}
    >
      <div className="h-1" style={{ background: `linear-gradient(90deg, ${sev.markerColor}, transparent)` }} />

      <div className="p-4 space-y-3">
        <div className="flex items-start justify-between">
          <div className="flex-1">
            <div className="flex items-center gap-2 mb-1.5">
              <span
                className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-md"
                style={{ backgroundColor: sev.markerColor + "20", color: sev.markerColor }}
              >
                {sev.label}
              </span>
              <span className="text-[10px] font-mono px-1.5 py-0.5 rounded border border-amber-500/30 text-amber-500 flex items-center gap-1">
                <AlertTriangle className="w-2.5 h-2.5" />
                UNVERIFIED
              </span>
            </div>
            <h3 className="font-semibold text-sm" style={{ color: "var(--panel-text)" }}>
              {incident.location_text || "Unknown Location"}
            </h3>
          </div>
          <button onClick={onClose} className="transition-colors p-1 -m-1" style={{ color: "var(--panel-text-muted)" }}>
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex items-center gap-3 text-[11px] font-mono" style={{ color: "var(--panel-text-secondary)" }}>
          <span className="flex items-center gap-1"><Clock className="w-3 h-3" />{formatTime(incident.reported_at)}</span>
          <span style={{ color: "var(--panel-border)" }}>|</span>
          <span className="flex items-center gap-1"><MapPin className="w-3 h-3" />{incident.lat?.toFixed(4)}, {incident.lng?.toFixed(4)}</span>
        </div>

        <div className="h-px" style={{ background: "var(--panel-border)" }} />

        <div className="rounded-lg p-3" style={{ background: "var(--panel-input-bg)" }}>
          <p className="text-[10px] text-blue-500 font-mono font-medium mb-1.5 flex items-center gap-1">
            <Radio className="w-3 h-3" /> SCANNER TRANSCRIPT
          </p>
          <p className="text-xs leading-relaxed italic" style={{ color: "var(--panel-text-secondary)" }}>
            &ldquo;{incident.raw_text}&rdquo;
          </p>
        </div>

        <div className="flex gap-3">
          {[
            { label: "CONFIDENCE", value: `${confidencePct}%`, color: confidencePct >= 80 ? "#22c55e" : confidencePct >= 50 ? "#f59e0b" : "#ef4444" },
            { label: "SEVERITY", value: incident.s_base.toFixed(1), color: sev.markerColor },
            { label: "WEIGHT", value: incident.w_eff.toFixed(2), color: "var(--panel-text-secondary)" },
          ].map((stat) => (
            <div key={stat.label} className="flex-1 rounded-lg p-2.5 text-center" style={{ background: "var(--panel-input-bg)" }}>
              <p className="text-[9px] font-mono mb-0.5" style={{ color: "var(--panel-text-muted)" }}>{stat.label}</p>
              <p className="text-sm font-bold font-mono" style={{ color: stat.color }}>{stat.value}</p>
            </div>
          ))}
        </div>

        {incident.inhibitor_status !== "passed" && (
          <div className="flex items-center gap-2 text-xs text-amber-500 bg-amber-500/10 rounded-lg px-3 py-2">
            <Shield className="w-3.5 h-3.5" />
            <span className="font-mono text-[10px]">
              INHIBITOR: {incident.inhibitor_status.toUpperCase()}
              {incident.inhibitor_reason && ` -- ${incident.inhibitor_reason}`}
            </span>
          </div>
        )}

        <div className="flex items-center gap-2 text-[10px] pt-1" style={{ color: "var(--panel-text-muted)" }}>
          <Brain className="w-3 h-3" />
          <span>Processed by AI pipeline with ethical guardrails</span>
          {incident.inhibitor_status === "passed" && <Shield className="w-3 h-3 text-green-500/50" />}
        </div>
      </div>
    </div>
  );
}
