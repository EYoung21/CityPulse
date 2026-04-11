"use client";

import { useState } from "react";
import type { Incident, VerificationCheck } from "@/lib/api";
import { verifyIncident } from "@/lib/api";
import { getSeverity } from "@/lib/severity";
import {
  AlertTriangle, MapPin, Clock, Brain, Shield, X, Radio,
  ShieldCheck, ShieldAlert, ShieldQuestion, Loader2,
  CheckCircle2, XCircle, ChevronDown, ChevronUp, Scan,
} from "lucide-react";

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

const VERIFICATION_CONFIG: Record<string, { icon: typeof ShieldCheck; color: string; bg: string; label: string }> = {
  verified: { icon: ShieldCheck, color: "text-green-500", bg: "bg-green-500/10", label: "Verified" },
  likely: { icon: Shield, color: "text-blue-500", bg: "bg-blue-500/10", label: "Likely Valid" },
  unverified: { icon: ShieldQuestion, color: "text-amber-500", bg: "bg-amber-500/10", label: "Unverified" },
  suspicious: { icon: ShieldAlert, color: "text-red-500", bg: "bg-red-500/10", label: "Suspicious" },
  pending: { icon: ShieldQuestion, color: "text-gray-400", bg: "bg-gray-500/10", label: "Not Verified" },
};

interface Props {
  incident: Incident;
  onClose: () => void;
  onIncidentUpdate?: (updated: Incident) => void;
}

export default function IncidentDetail({ incident, onClose, onIncidentUpdate }: Props) {
  const sev = getSeverity(incident.severity_category);
  const confidencePct = Math.round(incident.confidence * 100);
  const [verifying, setVerifying] = useState(false);
  const [showChecks, setShowChecks] = useState(false);
  const [localIncident, setLocalIncident] = useState(incident);

  const vStatus = localIncident.verification_status || "pending";
  const vConfig = VERIFICATION_CONFIG[vStatus] || VERIFICATION_CONFIG.pending;
  const VIcon = vConfig.icon;
  const vScore = localIncident.verification_score;

  let checks: VerificationCheck[] = [];
  try {
    if (localIncident.verification_checks) {
      checks = JSON.parse(localIncident.verification_checks);
    }
  } catch { /* */ }

  const handleVerify = async () => {
    setVerifying(true);
    try {
      const result = await verifyIncident(localIncident.id);
      setLocalIncident(result.incident);
      onIncidentUpdate?.(result.incident);
      setShowChecks(true);
    } catch (e) {
      console.error("Verification failed:", e);
    } finally {
      setVerifying(false);
    }
  };

  return (
    <div
      className="rounded-xl overflow-hidden backdrop-blur-xl shadow-2xl"
      style={{ background: "var(--panel-bg)", border: "1px solid var(--panel-border)" }}
    >
      <div className="h-1" style={{ background: `linear-gradient(90deg, ${sev.markerColor}, transparent)` }} />

      <div className="p-4 space-y-3">
        {/* Header */}
        <div className="flex items-start justify-between">
          <div className="flex-1">
            <div className="flex items-center gap-2 mb-1.5 flex-wrap">
              <span
                className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-md"
                style={{ backgroundColor: sev.markerColor + "20", color: sev.markerColor }}
              >
                {sev.label}
              </span>
              {/* Verification badge */}
              <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-md flex items-center gap-1 ${vConfig.bg} ${vConfig.color}`}>
                <VIcon className="w-2.5 h-2.5" />
                {vConfig.label}
                {vScore != null && <span className="font-mono">({vScore})</span>}
              </span>
            </div>
            <h3 className="font-semibold text-sm" style={{ color: "var(--panel-text)" }}>
              {localIncident.location_text || "Unknown Location"}
            </h3>
          </div>
          <button onClick={onClose} className="transition-colors p-1 -m-1" style={{ color: "var(--panel-text-muted)" }}>
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Meta */}
        <div className="flex items-center gap-3 text-[11px] font-mono" style={{ color: "var(--panel-text-secondary)" }}>
          <span className="flex items-center gap-1"><Clock className="w-3 h-3" />{formatTime(localIncident.reported_at)}</span>
          <span style={{ color: "var(--panel-border)" }}>|</span>
          <span className="flex items-center gap-1"><MapPin className="w-3 h-3" />{localIncident.lat?.toFixed(4)}, {localIncident.lng?.toFixed(4)}</span>
        </div>

        <div className="h-px" style={{ background: "var(--panel-border)" }} />

        {/* === VERIFICATION SECTION === */}
        <div className="rounded-lg overflow-hidden" style={{ border: "1px solid var(--panel-border)" }}>
          {/* Verify button / status bar */}
          {vStatus === "pending" ? (
            <button
              onClick={handleVerify}
              disabled={verifying}
              className="w-full flex items-center gap-2.5 px-3 py-2.5 text-xs font-medium transition-colors text-blue-500 bg-blue-500/5 hover:bg-blue-500/10"
            >
              {verifying ? (
                <><Loader2 className="w-4 h-4 animate-spin" /> Verifying against public data sources...</>
              ) : (
                <><Scan className="w-4 h-4" /> Verify This Incident</>
              )}
            </button>
          ) : (
            <>
              {/* Score bar */}
              <div className={`flex items-center justify-between px-3 py-2.5 ${vConfig.bg}`}>
                <div className="flex items-center gap-2">
                  <VIcon className={`w-4 h-4 ${vConfig.color}`} />
                  <span className={`text-xs font-semibold ${vConfig.color}`}>{vConfig.label}</span>
                </div>
                <div className="flex items-center gap-2">
                  <div className="w-16 h-1.5 rounded-full overflow-hidden" style={{ background: "var(--panel-input-bg)" }}>
                    <div
                      className="h-full rounded-full transition-all"
                      style={{
                        width: `${vScore ?? 0}%`,
                        background: vScore != null && vScore >= 75 ? "#22c55e" : vScore != null && vScore >= 50 ? "#3b82f6" : vScore != null && vScore >= 25 ? "#f59e0b" : "#ef4444",
                      }}
                    />
                  </div>
                  <span className="text-xs font-bold font-mono" style={{ color: "var(--panel-text)" }}>{vScore ?? 0}/100</span>
                </div>
              </div>

              {/* Summary */}
              <div className="px-3 py-2 text-xs" style={{ color: "var(--panel-text-secondary)" }}>
                {localIncident.verification_summary}
              </div>

              {/* Checks expandable */}
              {checks.length > 0 && (
                <>
                  <button
                    onClick={() => setShowChecks(!showChecks)}
                    className="w-full flex items-center justify-between px-3 py-2 text-[10px] font-medium uppercase tracking-wider transition-colors"
                    style={{ color: "var(--panel-text-muted)", borderTop: "1px solid var(--panel-border)" }}
                    onMouseEnter={(e) => e.currentTarget.style.background = "var(--panel-hover)"}
                    onMouseLeave={(e) => e.currentTarget.style.background = "transparent"}
                  >
                    <span>Verification Details ({checks.length} checks)</span>
                    {showChecks ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                  </button>

                  {showChecks && (
                    <div className="space-y-0" style={{ borderTop: "1px solid var(--panel-border)" }}>
                      {checks.map((check, i) => (
                        <div key={i} className="px-3 py-2.5 flex items-start gap-2.5" style={{ borderBottom: i < checks.length - 1 ? "1px solid var(--panel-border)" : "none" }}>
                          {check.passed
                            ? <CheckCircle2 className="w-3.5 h-3.5 text-green-500 shrink-0 mt-0.5" />
                            : <XCircle className="w-3.5 h-3.5 text-red-400/60 shrink-0 mt-0.5" />
                          }
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <span className="text-[10px] font-semibold" style={{ color: "var(--panel-text)" }}>{check.source}</span>
                              <span className="text-[10px] font-mono" style={{ color: check.passed ? "#22c55e" : "var(--panel-text-muted)" }}>+{check.score}</span>
                            </div>
                            <p className="text-[10px] mt-0.5 leading-relaxed" style={{ color: "var(--panel-text-muted)" }}>{check.detail}</p>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}

              {/* Re-verify button */}
              <button
                onClick={handleVerify}
                disabled={verifying}
                className="w-full flex items-center justify-center gap-1.5 px-3 py-2 text-[10px] font-medium transition-colors"
                style={{ color: "var(--panel-text-muted)", borderTop: "1px solid var(--panel-border)" }}
                onMouseEnter={(e) => e.currentTarget.style.background = "var(--panel-hover)"}
                onMouseLeave={(e) => e.currentTarget.style.background = "transparent"}
              >
                {verifying ? <Loader2 className="w-3 h-3 animate-spin" /> : <Scan className="w-3 h-3" />}
                Re-verify
              </button>
            </>
          )}
        </div>

        {/* Transcript */}
        <div className="rounded-lg p-3" style={{ background: "var(--panel-input-bg)" }}>
          <p className="text-[10px] text-blue-500 font-mono font-medium mb-1.5 flex items-center gap-1">
            <Radio className="w-3 h-3" /> SCANNER TRANSCRIPT
          </p>
          <p className="text-xs leading-relaxed italic" style={{ color: "var(--panel-text-secondary)" }}>
            &ldquo;{localIncident.raw_text}&rdquo;
          </p>
        </div>

        {/* Stats */}
        <div className="flex gap-3">
          {[
            { label: "CONFIDENCE", value: `${confidencePct}%`, color: confidencePct >= 80 ? "#22c55e" : confidencePct >= 50 ? "#f59e0b" : "#ef4444" },
            { label: "SEVERITY", value: localIncident.s_base.toFixed(1), color: sev.markerColor },
            { label: "WEIGHT", value: localIncident.w_eff.toFixed(2), color: "var(--panel-text-secondary)" },
          ].map((stat) => (
            <div key={stat.label} className="flex-1 rounded-lg p-2.5 text-center" style={{ background: "var(--panel-input-bg)" }}>
              <p className="text-[9px] font-mono mb-0.5" style={{ color: "var(--panel-text-muted)" }}>{stat.label}</p>
              <p className="text-sm font-bold font-mono" style={{ color: stat.color }}>{stat.value}</p>
            </div>
          ))}
        </div>

        {/* Inhibitor */}
        {localIncident.inhibitor_status !== "passed" && (
          <div className="flex items-center gap-2 text-xs text-amber-500 bg-amber-500/10 rounded-lg px-3 py-2">
            <Shield className="w-3.5 h-3.5" />
            <span className="font-mono text-[10px]">
              INHIBITOR: {localIncident.inhibitor_status.toUpperCase()}
              {localIncident.inhibitor_reason && ` — ${localIncident.inhibitor_reason}`}
            </span>
          </div>
        )}

        <div className="flex items-center gap-2 text-[10px] pt-1" style={{ color: "var(--panel-text-muted)" }}>
          <Brain className="w-3 h-3" />
          <span>Processed by AI pipeline with ethical guardrails</span>
          {localIncident.inhibitor_status === "passed" && <Shield className="w-3 h-3 text-green-500/50" />}
        </div>
      </div>
    </div>
  );
}
