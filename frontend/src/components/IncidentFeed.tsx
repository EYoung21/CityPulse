"use client";

import type { Incident } from "@/lib/api";
import { getSeverity } from "@/lib/severity";
import {
  AlertTriangle,
  Flame,
  Car,
  Heart,
  ShieldAlert,
  Volume2,
  CircleDot,
  MapPin,
} from "lucide-react";

const CATEGORY_ICONS: Record<string, React.ReactNode> = {
  violent_weapon: <ShieldAlert className="w-3.5 h-3.5" />,
  violent_no_weapon: <ShieldAlert className="w-3.5 h-3.5" />,
  shots_heard: <Volume2 className="w-3.5 h-3.5" />,
  robbery: <AlertTriangle className="w-3.5 h-3.5" />,
  burglary_in_progress: <AlertTriangle className="w-3.5 h-3.5" />,
  medical_priority: <Heart className="w-3.5 h-3.5" />,
  medical_other: <Heart className="w-3.5 h-3.5" />,
  fire_hazmat: <Flame className="w-3.5 h-3.5" />,
  traffic_crash_injury: <Car className="w-3.5 h-3.5" />,
  traffic_crash_no_injury: <Car className="w-3.5 h-3.5" />,
  disorder: <CircleDot className="w-3.5 h-3.5" />,
};

function timeAgo(isoStr: string): string {
  const diff = Date.now() - new Date(isoStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  return `${Math.floor(hrs / 24)}d`;
}

interface Props {
  incidents: Incident[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

export default function IncidentFeed({ incidents, selectedId, onSelect }: Props) {
  return (
    <div className="flex flex-col gap-0.5">
      {incidents.length === 0 && (
        <div className="flex flex-col items-center justify-center py-12 gap-3">
          <div className="w-10 h-10 rounded-full bg-white/5 flex items-center justify-center">
            <Radio className="w-5 h-5 text-muted-foreground/40" />
          </div>
          <p className="text-muted-foreground/60 text-xs font-mono">AWAITING INCIDENTS</p>
        </div>
      )}
      {incidents.map((inc, index) => {
        const sev = getSeverity(inc.severity_category);
        const isSelected = inc.id === selectedId;
        const isHighSev = inc.s_base >= 0.7;

        return (
          <button
            key={inc.id}
            onClick={() => onSelect(inc.id)}
            className={`group relative flex items-start gap-2.5 px-3 py-2.5 rounded-lg text-left transition-all duration-200 animate-fade-up
              ${isSelected
                ? "bg-white/10 ring-1 ring-white/10"
                : "hover:bg-white/5"
              }`}
            style={{ animationDelay: `${Math.min(index * 30, 300)}ms` }}
          >
            {/* Severity indicator line */}
            <div
              className="absolute left-0 top-2 bottom-2 w-[2px] rounded-full transition-opacity"
              style={{
                backgroundColor: sev.markerColor,
                opacity: isSelected ? 1 : 0.4,
              }}
            />

            {/* Icon */}
            <div
              className="mt-0.5 w-7 h-7 rounded-md flex items-center justify-center shrink-0"
              style={{
                backgroundColor: sev.markerColor + "18",
                color: sev.markerColor,
              }}
            >
              {CATEGORY_ICONS[inc.severity_category] || <CircleDot className="w-3.5 h-3.5" />}
            </div>

            {/* Content */}
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5 mb-0.5">
                <span
                  className="text-[10px] font-bold uppercase tracking-wider"
                  style={{ color: sev.markerColor }}
                >
                  {sev.label}
                </span>
                {isHighSev && (
                  <span className="w-1.5 h-1.5 rounded-full bg-red-400 animate-pulse" />
                )}
              </div>
              <div className="flex items-center gap-1 text-xs text-foreground/70 truncate">
                <MapPin className="w-3 h-3 shrink-0 text-muted-foreground/40" />
                <span className="truncate">{inc.location_text || "Unknown"}</span>
              </div>
            </div>

            {/* Time + confidence */}
            <div className="flex flex-col items-end gap-0.5 shrink-0">
              <span className="text-[10px] font-mono text-muted-foreground">
                {timeAgo(inc.reported_at)}
              </span>
              <span className="text-[9px] font-mono text-muted-foreground/50">
                {Math.round(inc.confidence * 100)}%
              </span>
            </div>
          </button>
        );
      })}
    </div>
  );
}

function Radio(props: React.SVGProps<SVGSVGElement> & { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M4.9 19.1C1 15.2 1 8.8 4.9 4.9" /><path d="M7.8 16.2c-2.3-2.3-2.3-6.1 0-8.4" /><path d="M16.2 7.8c2.3 2.3 2.3 6.1 0 8.4" /><path d="M19.1 4.9C23 8.8 23 15.1 19.1 19" /><circle cx="12" cy="12" r="2" />
    </svg>
  );
}
