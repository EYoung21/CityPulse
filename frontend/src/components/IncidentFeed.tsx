"use client";

import { Badge } from "@/components/ui/badge";
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
} from "lucide-react";

const CATEGORY_ICONS: Record<string, React.ReactNode> = {
  violent_weapon: <ShieldAlert className="w-4 h-4" />,
  violent_no_weapon: <ShieldAlert className="w-4 h-4" />,
  shots_heard: <Volume2 className="w-4 h-4" />,
  robbery: <AlertTriangle className="w-4 h-4" />,
  burglary_in_progress: <AlertTriangle className="w-4 h-4" />,
  medical_priority: <Heart className="w-4 h-4" />,
  medical_other: <Heart className="w-4 h-4" />,
  fire_hazmat: <Flame className="w-4 h-4" />,
  traffic_crash_injury: <Car className="w-4 h-4" />,
  traffic_crash_no_injury: <Car className="w-4 h-4" />,
  disorder: <CircleDot className="w-4 h-4" />,
};

function timeAgo(isoStr: string): string {
  const diff = Date.now() - new Date(isoStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

interface Props {
  incidents: Incident[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

export default function IncidentFeed({ incidents, selectedId, onSelect }: Props) {
  return (
    <div className="flex flex-col gap-1 overflow-y-auto">
      {incidents.length === 0 && (
        <p className="text-muted-foreground text-sm p-4 text-center">
          No incidents to display
        </p>
      )}
      {incidents.map((inc) => {
        const sev = getSeverity(inc.severity_category);
        const isSelected = inc.id === selectedId;
        return (
          <button
            key={inc.id}
            onClick={() => onSelect(inc.id)}
            className={`flex items-start gap-3 p-3 rounded-lg text-left transition-colors
              ${isSelected ? "bg-accent" : "hover:bg-accent/50"}`}
          >
            <span className={`mt-0.5 ${sev.textClass}`}>
              {CATEGORY_ICONS[inc.severity_category] || (
                <CircleDot className="w-4 h-4" />
              )}
            </span>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-0.5">
                <Badge
                  variant="secondary"
                  className={`text-xs ${sev.bgClass} ${sev.textClass} border-0`}
                >
                  {sev.label}
                </Badge>
                <span className="text-xs text-muted-foreground">
                  {timeAgo(inc.reported_at)}
                </span>
              </div>
              <p className="text-sm truncate text-foreground/80">
                {inc.location_text || "Unknown location"}
              </p>
            </div>
            <span className="text-xs text-muted-foreground whitespace-nowrap mt-1">
              {Math.round(inc.confidence * 100)}%
            </span>
          </button>
        );
      })}
    </div>
  );
}
