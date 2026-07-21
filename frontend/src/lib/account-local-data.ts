const CITYPULSE_STORAGE_PREFIXES = ["pp:", "pulse_", "phlpulse-", "cp:"];

function clearMatchingStorage(storage: Storage): number {
  const keys: string[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key && CITYPULSE_STORAGE_PREFIXES.some((prefix) => key.startsWith(prefix))) {
      keys.push(key);
    }
  }
  for (const key of keys) storage.removeItem(key);
  return keys.length;
}

/** Remove device-local CityPulse data without touching unrelated origin
 * storage. Called only after the Firebase account has actually been deleted. */
export function clearAccountLocalData(): number {
  if (typeof window === "undefined") return 0;
  let cleared = 0;
  try { cleared += clearMatchingStorage(window.localStorage); } catch { /* blocked */ }
  try { cleared += clearMatchingStorage(window.sessionStorage); } catch { /* blocked */ }
  return cleared;
}
