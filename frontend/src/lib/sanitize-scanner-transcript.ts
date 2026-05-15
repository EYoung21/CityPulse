/** Normalize clause/sentence fragments for duplicate detection. */
function normChunk(s: string): string {
  return s
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/^[,;.:!?'"]+/g, "")
    .replace(/[,;.:!?'"]+$/g, "")
    .trim();
}

function collapseDelimitedRuns(
  text: string,
  delimiter: string,
  minRun: number,
  maxChunkLen: number,
): string {
  const parts = text.split(delimiter).map((p) => p.trim());
  if (parts.length < minRun) return text;

  const out: string[] = [];
  let i = 0;
  while (i < parts.length) {
    const chunk = parts[i];
    const base = normChunk(chunk);
    if (!base || base.length > maxChunkLen) {
      out.push(chunk);
      i += 1;
      continue;
    }
    let run = 1;
    while (i + run < parts.length && normChunk(parts[i + run]) === base) {
      run += 1;
    }
    if (run >= minRun) {
      out.push(`${chunk} … (${run}× similar phrase from scanner)`);
      i += run;
    } else {
      out.push(chunk);
      i += 1;
    }
  }
  return out.join(delimiter);
}

function commaDuplicateRunExists(text: string, minRun: number): boolean {
  const parts = text.split(/,\s*/).map((p) => normChunk(p));
  let run = 1;
  for (let i = 1; i < parts.length; i++) {
    if (parts[i] && parts[i] === parts[i - 1] && parts[i].length > 2 && parts[i].length < 130) {
      run += 1;
      if (run >= minRun) return true;
    } else {
      run = 1;
    }
  }
  return false;
}

/**
 * Softens common speech-to-text failure modes (phrase loops, apology spam)
 * for display only. Does not mutate stored incident data.
 */
export function sanitizeScannerTranscriptForDisplay(text: string | null | undefined): string {
  if (text == null) return "";
  let s = text.replace(/\s+/g, " ").trim();
  if (!s) return "";

  s = s.replace(/(?:\bI'm\s+sorry,?\s*){6,}/gi, "I'm sorry … ");

  s = collapseDelimitedRuns(s, ", ", 5, 130);
  s = collapseDelimitedRuns(s, ". ", 4, 150);

  return s.replace(/\s+/g, " ").trim();
}

/** True when the string is likely garbled by repetition rather than natural prose. */
export function hasScannerTranscriptArtifacts(text: string | null | undefined): boolean {
  if (!text || text.length < 72) return false;
  const s = text.replace(/\s+/g, " ").trim();
  if (/(?:\bI'm\s+sorry,?\s*){5,}/i.test(s)) return true;
  if (commaDuplicateRunExists(s, 5)) return true;
  const sanitized = sanitizeScannerTranscriptForDisplay(s);
  return sanitized.length + 48 < s.length;
}
