/**
 * Newsworthiness scoring for the Newsroom desk.
 *
 * Editors can't monitor raw scanner chatter — they need the 2-3 calls worth a
 * reporter *right now* surfaced out of the 200 routine ones. This module scores
 * each incident on a transparent set of signals and assigns it a tier + the
 * editorial "desks" it belongs to, so the feed can rank and filter like an
 * assignment desk.
 *
 * The model blends:
 *  - the source notes from a working Times Free Press editor (fatal crashes,
 *    shootings, fires at prominent places, big traffic backups, offbeat
 *    "goofy" items; routine medical almost never), and
 *  - standard journalism news values (Harcup & O'Neill: magnitude, unusualness,
 *    prominence, power-elite, timeliness), and
 *  - how scanner desks actually triage: "reading the rhythm" — multiple units
 *    converging / repeated transmissions on one call signals a major incident.
 *    We proxy that with `mention_count` (the dedup pipeline merges repeated
 *    transmissions for the same event).
 *
 * The neighborhood angle is implemented as **statistical anomaly** ("unusual
 * for the area"): a serious incident in a normally-quiet location scores higher
 * than the same incident where it's sadly routine. No neighborhood is ever
 * labeled "good" or "bad" — the boost is driven purely by local incident
 * density, which is defensible if an editor is ever asked how the desk ranks.
 */

import type { Incident } from "@/lib/api";

export type NewsDesk =
  | "top"
  | "fatal"
  | "violence"
  | "unusual"
  | "traffic"
  | "prominent";

export type NewsTier = "breaking" | "notable" | "routine";

export interface NewsScore {
  score: number; // 0–100
  tier: NewsTier;
  desks: NewsDesk[]; // specific desks this fits (excludes "top")
  signals: string[]; // human-readable "why it surfaced", for editor triage
}

/** Editor-facing desks shown as filter chips. `top` is the default "everything
 *  newsworthy, ranked" view; the rest narrow to a beat. */
export const NEWS_DESKS: { id: NewsDesk; label: string; blurb: string }[] = [
  { id: "top", label: "Top", blurb: "Everything worth a look, ranked" },
  { id: "fatal", label: "Fatal", blurb: "Deaths — crashes, fires, etc." },
  { id: "violence", label: "Violence", blurb: "Shootings, weapons, robbery" },
  { id: "unusual", label: "Unusual", blurb: "Offbeat / out-of-the-ordinary" },
  { id: "traffic", label: "Traffic", blurb: "Major backups & interstate" },
  { id: "prominent", label: "Prominent", blurb: "Landmarks & public figures" },
];

const TIER_BREAKING = 68;
const TIER_NOTABLE = 38;

// Base magnitude by category (0–1). Routine categories sit low and only clear
// the bar when a stronger signal (fatality, escalation, prominence) fires.
const SEVERITY_BASE: Record<string, number> = {
  violent_weapon: 0.9,
  shots_heard: 0.85,
  robbery: 0.7,
  violent_no_weapon: 0.6,
  burglary_in_progress: 0.55,
  fire_hazmat: 0.5,
  traffic_crash_injury: 0.45,
  disorder: 0.28,
  medical_priority: 0.25,
  traffic_crash_no_injury: 0.18,
  medical_other: 0.1,
  admin_or_noise: 0.0,
};

const VIOLENCE_CATS = new Set([
  "violent_weapon",
  "shots_heard",
  "robbery",
  "violent_no_weapon",
]);
const TRAFFIC_CATS = new Set(["traffic_crash_injury", "traffic_crash_no_injury"]);
const MEDICAL_CATS = new Set(["medical_priority", "medical_other"]);

// Conservative keyword sets — matched against description + transcript.
const FATALITY_RE =
  /\b(fatal(?:it(?:y|ies))?|deceased|d\.?o\.?a\.?|pronounced (?:dead|deceased)|coroner|medical examiner|fatalit)\b/i;
const PROMINENT_PLACE_RE =
  /\b(downtown|city hall|town hall|courthouse|capitol|police headquarters|hospital|medical center|university|college|high school|elementary|middle school|\bschool\b|campus|mall|stadium|arena|coliseum|airport|convention center|library|aquarium|riverfront|city center|interstate|\bi-\d{1,3}\b|highway|freeway|turnpike)\b/i;
const POWER_ELITE_RE =
  /\b(mayor|council(?:man|woman|member)?|city council|senator|congress|representative|\bjudge\b|police chief|fire chief|commissioner|officer[- ]involved|district attorney|sheriff|superintendent)\b/i;
const TRAFFIC_DISRUPT_RE =
  /\b(shut ?down|all lanes|lanes? (?:closed|blocked)|road closed|closed to traffic|backed up|back ?up|overturn(?:ed)?|roll ?over|jack ?knif|spill(?:ed|age)?|hazmat|pile ?up|multi[- ]vehicle|tractor[- ]trailer|tanker|major delay|traffic stopped)\b/i;
// "Goofy" / offbeat — inherently fuzzy; these flag items for an editor's eye,
// not auto-publish. Better to surface a few odd-but-mundane than miss the
// peanut-butter-sandwich assault.
// Deliberately specific — "stuck in", "covered in", "caught on" were too broad
// ("stuck in traffic"). Better to flag a few odd-but-mundane than auto-publish.
const UNUSUAL_RE =
  /\b(naked|nude|streak(?:er|ing)|peanut butter|clown|in costume|mascot|llama|alligator|emu|goat on|monkey|kangaroo|chainsaw|sword|machete|samurai|wielding|bizarre|porta[- ]?potty|bouncy castle|stuck in a tree|on the roof of|glued)\b/i;

function text(inc: Incident): string {
  return `${inc.description ?? ""} ${inc.raw_text ?? ""}`;
}

/** Per-area incident density, used for the "unusual for this area" anomaly
 *  signal. Buckets the loaded window into ~2km grid cells (no neighborhood
 *  polygon data needed) and counts how quiet each cell normally is. */
export interface NewsContext {
  cellTotals: Map<string, number>;
}

const CELL = 0.02; // ~2.2km lat; close enough for "is this area usually quiet"

function cellKey(lat: number, lng: number): string {
  return `${Math.round(lat / CELL)}_${Math.round(lng / CELL)}`;
}

export function buildNewsContext(incidents: Incident[]): NewsContext {
  const cellTotals = new Map<string, number>();
  for (const inc of incidents) {
    if (inc.lat == null || inc.lng == null) continue;
    const k = cellKey(inc.lat, inc.lng);
    cellTotals.set(k, (cellTotals.get(k) ?? 0) + 1);
  }
  return { cellTotals };
}

export function scoreIncident(inc: Incident, ctx: NewsContext): NewsScore {
  const cat = inc.severity_category;
  const base = SEVERITY_BASE[cat] ?? 0.2;
  const body = text(inc);
  const signals: string[] = [];
  const desks = new Set<NewsDesk>();

  let score = base * 40; // 0–36 baseline from magnitude

  const isFatal = FATALITY_RE.test(body);
  if (isFatal) {
    score += 35;
    desks.add("fatal");
    signals.push("Possible fatality");
  }

  if (VIOLENCE_CATS.has(cat)) {
    desks.add("violence");
    if (cat === "shots_heard") signals.push("Shots reported");
    else if (cat === "violent_weapon") signals.push("Weapon involved");
  }

  // Escalation — the scanner-desk "rhythm" signal. Repeated transmissions /
  // multiple units converging on one call ≈ a developing major incident.
  const mentions = inc.mention_count ?? 0;
  if (mentions >= 5) {
    score += 22;
    signals.push(`${mentions} transmissions — active scene`);
  } else if (mentions >= 3) {
    score += 14;
    signals.push(`${mentions} transmissions — developing`);
  }

  if (UNUSUAL_RE.test(body)) {
    score += 24;
    desks.add("unusual");
    signals.push("Possibly offbeat");
  }

  const prominentPlace = PROMINENT_PLACE_RE.test(body);
  const powerElite = POWER_ELITE_RE.test(body);
  if (prominentPlace) {
    score += 16;
    desks.add("prominent");
    signals.push("Prominent location");
  }
  if (powerElite) {
    score += 20;
    desks.add("prominent");
    signals.push("Public figure / official");
  }

  if (TRAFFIC_CATS.has(cat) && TRAFFIC_DISRUPT_RE.test(body)) {
    score += 20;
    desks.add("traffic");
    signals.push("Major traffic disruption");
  }

  // Anomaly: a serious incident in a normally-quiet area stands out. Driven by
  // local density only — never a "good/bad neighborhood" label.
  if (base >= 0.6 && inc.lat != null && inc.lng != null) {
    const cellTotal = ctx.cellTotals.get(cellKey(inc.lat, inc.lng)) ?? 0;
    if (cellTotal <= 2) {
      score += 18;
      signals.push("Unusual for this area");
    }
  }

  // Timeliness — the be-first edge. Fresh items float up.
  const ageH = (Date.now() - Date.parse(inc.reported_at)) / 3_600_000;
  if (Number.isFinite(ageH)) {
    if (ageH <= 1) score += 9;
    else if (ageH <= 3) score += 5;
    else if (ageH <= 6) score += 2;
  }

  // Suppression — keep the desk clean of the routine calls editors skip.
  if (MEDICAL_CATS.has(cat) && !isFatal && !prominentPlace && !powerElite) {
    score -= 22; // "medical almost never, unless a famous person"
  }
  if (cat === "admin_or_noise") score -= 30;
  if (cat === "traffic_crash_no_injury" && !desks.has("traffic")) score -= 10;

  score = Math.max(0, Math.min(100, Math.round(score)));

  const tier: NewsTier =
    score >= TIER_BREAKING ? "breaking" : score >= TIER_NOTABLE ? "notable" : "routine";

  return { score, tier, desks: [...desks], signals };
}

export interface ScoredIncident {
  incident: Incident;
  news: NewsScore;
}

/** Score, filter to a desk, and rank. `includeRoutine` shows the long tail of
 *  low-newsworthiness calls (off by default — the desk is a triage view). */
export function rankForDesk(
  incidents: Incident[],
  desk: NewsDesk,
  opts: { includeRoutine?: boolean } = {},
): ScoredIncident[] {
  const ctx = buildNewsContext(incidents);
  const scored = incidents.map((incident) => ({
    incident,
    news: scoreIncident(incident, ctx),
  }));
  const filtered = scored.filter(({ news }) => {
    if (!opts.includeRoutine && news.tier === "routine") return false;
    if (desk === "top") return true;
    return news.desks.includes(desk);
  });
  // Rank by score, then recency as the tie-break (be-first).
  filtered.sort((a, b) => {
    if (b.news.score !== a.news.score) return b.news.score - a.news.score;
    return Date.parse(b.incident.reported_at) - Date.parse(a.incident.reported_at);
  });
  return filtered;
}

export function deskCounts(incidents: Incident[]): Record<NewsDesk, number> {
  const ctx = buildNewsContext(incidents);
  const counts: Record<NewsDesk, number> = {
    top: 0,
    fatal: 0,
    violence: 0,
    unusual: 0,
    traffic: 0,
    prominent: 0,
  };
  for (const inc of incidents) {
    const news = scoreIncident(inc, ctx);
    if (news.tier === "routine") continue;
    counts.top += 1;
    for (const d of news.desks) counts[d] += 1;
  }
  return counts;
}
