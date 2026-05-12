/** Highlight matching terms in alert/incident text.
 *
 *  Returns an array of React-friendly `{ text, highlight }` segments.
 *  Used by AlertsInbox and IncidentFeed to visually call out matched
 *  keyword-watch phrases and high-severity tokens.
 *
 *  The highlight set is case-insensitive and whole-word bounded so
 *  "fire" matches "fire" but not "fireplace". */

export interface TextSegment {
  text: string;
  highlight: boolean;
}

/** Built-in severity keywords that are always highlighted in alert text.
 *  These match the high-severity categories from the incident pipeline. */
const DEFAULT_HIGHLIGHT_TERMS = [
  "shooting",
  "shots fired",
  "stabbing",
  "homicide",
  "assault",
  "robbery",
  "carjacking",
  "structure fire",
  "explosion",
  "fatal",
  "critical",
  "armed",
  "weapon",
  "barricade",
  "hostage",
  "pursuit",
];

/**
 * Split `text` into segments, marking substrings that match any term in
 * `extraKeywords` (from the user's keyword watches) or the built-in
 * severity set.
 *
 * @param text          The raw body text to annotate.
 * @param extraKeywords Optional user-provided keywords (from keyword watches).
 */
export function highlightTerms(
  text: string,
  extraKeywords: string[] = []
): TextSegment[] {
  if (!text) return [{ text: "", highlight: false }];

  const allTerms = [...DEFAULT_HIGHLIGHT_TERMS, ...extraKeywords]
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length >= 2);

  if (allTerms.length === 0) return [{ text, highlight: false }];

  // Build a combined regex: each term is escaped and word-bounded.
  const escaped = allTerms.map((t) =>
    t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  );
  const pattern = new RegExp(`\\b(${escaped.join("|")})\\b`, "gi");

  const segments: TextSegment[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ text: text.slice(lastIndex, match.index), highlight: false });
    }
    segments.push({ text: match[0], highlight: true });
    lastIndex = pattern.lastIndex;
  }

  if (lastIndex < text.length) {
    segments.push({ text: text.slice(lastIndex), highlight: false });
  }

  return segments.length > 0 ? segments : [{ text, highlight: false }];
}
