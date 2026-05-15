/** Coarse incident-type groups shared by map filters, analytics, and feed. */

export interface IncidentCategoryGroup {
  label: string;
  cats: readonly string[];
  color: string;
}

export const INCIDENT_CATEGORY_GROUPS: IncidentCategoryGroup[] = [
  {
    label: "Violent",
    cats: ["violent_weapon", "violent_no_weapon", "shots_heard", "robbery", "burglary_in_progress"],
    color: "#ef4444",
  },
  { label: "Medical", cats: ["medical_priority", "medical_other"], color: "#f472b6" },
  { label: "Traffic", cats: ["traffic_crash_injury", "traffic_crash_no_injury"], color: "#3b82f6" },
  { label: "Fire", cats: ["fire_hazmat"], color: "#fb923c" },
  { label: "Disorder", cats: ["disorder", "admin_or_noise"], color: "#8b5cf6" },
];

/** Same toggle semantics as the map category chips: tap adds all leaf
 *  categories in the group; tap again clears them. */
export function toggleCategoryGroupSelection(
  pillCats: readonly string[],
  prev: Set<string>
): Set<string> {
  const next = new Set(prev);
  const allActive = pillCats.length > 0 && pillCats.every((c) => next.has(c));
  if (allActive) pillCats.forEach((c) => next.delete(c));
  else pillCats.forEach((c) => next.add(c));
  return next;
}

export function incidentMatchesCategoryFilter(
  inc: { severity_category: string },
  activeCats: ReadonlySet<string>
): boolean {
  if (activeCats.size === 0) return true;
  return activeCats.has(inc.severity_category);
}
