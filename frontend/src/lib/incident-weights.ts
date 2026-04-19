import type { Incident } from "@/lib/api";
import {
  deriveLifecycleStatus,
  type IncidentLifecycleAggregate,
} from "@/lib/incident-status";

const TAU_HOURS = 12;

/** Multiplicative weight applied to `w_eff` based on the community
 *  lifecycle status. Resolved incidents drop hard so they fade out
 *  of the heatmap and stop dragging down area safety scores; "still
 *  active" gets a gentle boost so a confirmed-fresh incident
 *  outweighs an unconfirmed one of equal age. Unverified is the
 *  default and stays at 1.0 so untouched incidents render exactly
 *  the way they do today. */
const LIFECYCLE_MULT: Record<NonNullable<Incident["lifecycle_status"]>, number> = {
  still: 1.2,
  resolved: 0.15,
  unverified: 1.0,
};

function computeWEff(
  sBase: number,
  reportedAtIso: string,
  confidence: number,
  nowMs: number,
  lifecycleStatus?: Incident["lifecycle_status"]
): number {
  let reported: Date;
  try {
    reported = new Date(reportedAtIso);
    if (Number.isNaN(reported.getTime())) {
      return sBase * 0.05;
    }
  } catch {
    return sBase * 0.05;
  }
  const deltaHours = Math.max(
    (nowMs - reported.getTime()) / (1000 * 60 * 60),
    0
  );
  const c = Math.max(0.3, Math.min(confidence, 1));
  const timeDecay = Math.exp(-deltaHours / TAU_HOURS);
  const lifecycleMult = lifecycleStatus
    ? LIFECYCLE_MULT[lifecycleStatus]
    : 1;
  return sBase * timeDecay * c * lifecycleMult;
}

/** Enrich a batch of incidents with their effective weight (`w_eff`)
 *  and, when a community-lifecycle map is supplied, with a derived
 *  `lifecycle_status` and `lifecycle_last_vote_ms`. The lifecycle
 *  argument is optional so callers that haven't subscribed to the
 *  status collection (e.g. the legacy hourly summary path) keep
 *  working unchanged. */
export function enrichIncidents(
  incidents: Incident[],
  lifecycle?: Map<string, IncidentLifecycleAggregate>
): Incident[] {
  const nowMs = Date.now();
  return incidents.map((inc) => {
    const agg = lifecycle?.get(inc.id);
    const status = agg ? deriveLifecycleStatus(agg) : undefined;
    return {
      ...inc,
      lifecycle_status: status,
      lifecycle_last_vote_ms: agg?.lastVoteAtMs ?? 0,
      w_eff: Math.round(
        computeWEff(
          inc.s_base,
          inc.reported_at,
          inc.confidence,
          nowMs,
          status
        ) * 10000
      ) / 10000,
    };
  });
}
