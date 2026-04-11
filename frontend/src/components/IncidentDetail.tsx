"use client";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import type { Incident } from "@/lib/api";
import { getSeverity } from "@/lib/severity";
import { AlertTriangle, MapPin, Clock, Brain, Shield, X } from "lucide-react";

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

  return (
    <Card className="border-border/50 bg-card/95 backdrop-blur-sm">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-2">
            <Badge className={`${sev.bgClass} ${sev.textClass} border-0`}>
              {sev.label}
            </Badge>
            <Badge
              variant="outline"
              className="border-amber-500/50 text-amber-400 text-xs"
            >
              <AlertTriangle className="w-3 h-3 mr-1" />
              UNVERIFIED
            </Badge>
          </div>
          <button
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <CardTitle className="text-base mt-2">
          {incident.location_text || "Unknown Location"}
        </CardTitle>
      </CardHeader>

      <CardContent className="space-y-3">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Clock className="w-3.5 h-3.5" />
          <span>{formatTime(incident.reported_at)}</span>
          <span className="mx-1">·</span>
          <MapPin className="w-3.5 h-3.5" />
          <span>
            {incident.lat?.toFixed(4)}, {incident.lng?.toFixed(4)}
          </span>
        </div>

        <Separator />

        <div>
          <p className="text-xs text-muted-foreground mb-1 flex items-center gap-1">
            <Brain className="w-3 h-3" /> AI Transcript Extraction
          </p>
          <p className="text-sm italic text-foreground/80">
            &ldquo;{incident.raw_text}&rdquo;
          </p>
        </div>

        <div className="flex items-center gap-4 text-sm">
          <div>
            <span className="text-muted-foreground">Confidence:</span>{" "}
            <span className="font-medium">
              {Math.round(incident.confidence * 100)}%
            </span>
          </div>
          <div>
            <span className="text-muted-foreground">Weight:</span>{" "}
            <span className="font-medium">{incident.w_eff.toFixed(2)}</span>
          </div>
        </div>

        {incident.inhibitor_status !== "passed" && (
          <div className="flex items-center gap-2 text-xs text-amber-400">
            <Shield className="w-3 h-3" />
            Inhibitor: {incident.inhibitor_status}
            {incident.inhibitor_reason && ` — ${incident.inhibitor_reason}`}
          </div>
        )}

        <div className="text-xs text-muted-foreground border border-border/50 rounded-md p-2 bg-muted/30">
          <Shield className="w-3 h-3 inline mr-1" />
          This data is sourced from public radio scanner audio via AI
          transcription. It is <strong>unverified</strong> and should not be
          treated as official information. Not a replacement for 911.
        </div>
      </CardContent>
    </Card>
  );
}
