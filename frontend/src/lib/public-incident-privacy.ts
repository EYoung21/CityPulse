function finiteNumber(value: unknown): number | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/** Quantize public pins to a roughly 110 m latitude grid. */
export function publicCoordinates(
  latValue: unknown,
  lngValue: unknown,
): [number | null, number | null] {
  const lat = finiteNumber(latValue);
  const lng = finiteNumber(lngValue);
  if (
    lat === null ||
    lng === null ||
    lat < -90 ||
    lat > 90 ||
    lng < -180 ||
    lng > 180
  ) {
    return [null, null];
  }
  return [Math.round(lat * 1_000) / 1_000, Math.round(lng * 1_000) / 1_000];
}

/** Remove unit identifiers and convert exact street numbers to block level. */
export function publicLocation(value: unknown): string | null {
  if (typeof value !== "string") return null;
  let text = value
    .replace(/\\/g, " & ")
    .replace(/\//g, " & ")
    .replace(/\s+/g, " ")
    .trim();
  text = text.replace(
    /\s+(?:APT|APARTMENT|UNIT|SUITE|RM|ROOM|#)\s*[A-Z0-9-]+\b.*$/i,
    "",
  );
  if (!text || /^not available$/i.test(text)) return null;
  if (!/^\d+\s+BLOCK\b/i.test(text)) {
    const match = /^(\d{1,6})\s+(.+)$/.exec(text);
    if (match) {
      const number = Number(match[1]);
      const block =
        number < 100 ? "unit block" : `${Math.floor(number / 100) * 100} block`;
      text = `${block} ${match[2]}`;
    }
  }
  return text.slice(0, 180);
}
