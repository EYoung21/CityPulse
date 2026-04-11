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
    <div className="glass-panel rounded-xl overflow-hidden">
      {/* Top accent bar */}
      <div className="h-1" style={{ background: `linear-gradient(90deg, ${sev.markerColor}, transparent)` }} />

      <div className="p-4 space-y-3">
        {/* Header */}
        <div className="flex items-start justify-between">
          <div className="flex-1">
            <div className="flex items-center gap-2 mb-1.5">
              <span
                className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-md"
                style={{
                  backgroundColor: sev.markerColor + "20",
                  color: sev.markerColor,
                }}
              >
                {sev.label}
              </span>
              <span className="text-[10px] font-mono px-1.5 py-0.5 rounded border border-amber-500/30 text-amber-400 flex items-center gap-1">
                <AlertTriangle className="w-2.5 h-2.5" />
                UNVERIFIED
              </span>
            </div>
            <h3 className="font-semibold text-sm">
              {incident.location_text || "Unknown Location"}
            </h3>
          </div>
          <button
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground transition-colors p-1 -m-1"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Meta row */}
        <div className="flex items-center gap-3 text-[11px] text-muted-foreground font-mono">
          <span className="flex items-center gap-1">
            <Clock className="w-3 h-3" />
            {formatTime(incident.reported_at)}
          </span>
          <span className="text-border">|</span>
          <span className="flex items-center gap-1">
            <MapPin className="w-3 h-3" />
            {incident.lat?.toFixed(4)}, {incident.lng?.toFixed(4)}
          </span>
        </div>

        {/* Divider */}
        <div className="h-px bg-white/5" />

        {/* Transcript */}
        <div className="bg-white/5 rounded-lg p-3">
          <p className="text-[10px] text-blue-400 font-mono font-medium mb-1.5 flex items-center gap-1">
            <Radio className="w-3 h-3" /> SCANNER TRANSCRIPT
          </p>
          <p className="text-xs text-foreground/70 leading-relaxed italic">
            &ldquo;{incident.raw_text}&rdquo;
          </p>
        </div>

        {/* Stats */}
        <div className="flex gap-3">
          <div className="flex-1 bg-white/5 rounded-lg p-2.5 text-center">
            <p className="text-[9px] font-mono text-muted-foreground mb-0.5">CONFIDENCE</p>
            <p className={`text-sm font-bold font-mono ${confidencePct >= 80 ? "text-green-400" : confidencePct >= 50 ? "text-amber-400" : "text-red-400"}`}>
              {confidencePct}%
            </p>
          </div>
          <div className="flex-1 bg-white/5 rounded-lg p-2.5 text-center">
            <p className="text-[9px] font-mono text-muted-foreground mb-0.5">SEVERITY</p>
            <p className="text-sm font-bold font-mono" style={{ color: sev.markerColor }}>
              {incident.s_base.toFixed(1)}
            </p>
          </div>
          <div className="flex-1 bg-white/5 rounded-lg p-2.5 text-center">
            <p className="text-[9px] font-mono text-muted-foreground mb-0.5">WEIGHT</p>
            <p className="text-sm font-bold font-mono text-foreground/70">
              {incident.w_eff.toFixed(2)}
            </p>
          </div>
        </div>

        {/* Inhibitor status */}
        {incident.inhibitor_status !== "passed" && (
          <div className="flex items-center gap-2 text-xs text-amber-400 bg-amber-500/10 rounded-lg px-3 py-2">
            <Shield className="w-3.5 h-3.5" />
            <span className="font-mono text-[10px]">
              INHIBITOR: {incident.inhibitor_status.toUpperCase()}
              {incident.inhibitor_reason && ` -- ${incident.inhibitor_reason}`}
            </span>
          </div>
        )}

        {/* AI guardrail badge */}
        <div className="flex items-center gap-2 text-[10px] text-muted-foreground/60 pt-1">
          <Brain className="w-3 h-3" />
          <span>Processed by AI pipeline with ethical guardrails</span>
          {incident.inhibitor_status === "passed" && (
            <Shield className="w-3 h-3 text-green-400/50" />
          )}
        </div>
      </div>
    </div>
  );
}
