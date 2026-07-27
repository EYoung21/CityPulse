/** Backend-free "share my saved list" token.
 *
 *  Encodes a snapshot of a user's saved-list (name, optional accent
 *  color, sender name, and the list's destinations) into a URL-safe
 *  base64 string. The recipient's browser decodes the token client-side
 *  on `/share/list#t=…` and either previews the markers on a read-only
 *  map or imports them into the recipient's own account.
 *
 *  Trade-offs vs. a Firestore-backed share:
 *    + zero infrastructure & no recipient-side write permissions needed
 *    + privacy: link contents are visible to the sender only — nothing
 *      gets uploaded anywhere we don't already host
 *    - links are publicly decodable by anyone who has them
 *    - list mutations don't propagate; recipients import a snapshot
 *
 *  Token format (after base64url decode):
 *    {
 *      v: 1,                                     // schema version
 *      n?: string,                               // sender display name
 *      ln: string,                               // list name
 *      c?: string,                               // accent color (hex, no #)
 *      i: Array<[lat, lng, name]>                // destinations
 *    }
 *
 *  Each item is a 3-tuple to keep the token tight — most lists are
 *  10-30 places × ~50 bytes each, comfortably under 4KB before
 *  base64 padding inflates by ~33%.
 */

import { buildFragmentShareUrl } from "./share-fragment";

export const LIST_TOKEN_VERSION = 1;
const MAX_LIST_TOKEN_CHARS = 32_000;
const MAX_LIST_ITEMS = 100;

export interface SharedListSnapshot {
  /** Optional sender display name shown on the recipient page. */
  senderName?: string;
  /** List name as it should appear after import. */
  listName: string;
  /** Optional hex accent color (with or without leading #) used in the
   *  preview chrome and re-applied on import. */
  color?: string;
  items: Array<{ name: string; lat: number; lng: number }>;
}

export interface DecodedListToken extends SharedListSnapshot {
  version: number;
}

/* --------- Base64url helpers (URL-safe, no padding) ------------------ */
function base64UrlEncode(s: string): string {
  if (typeof window === "undefined") {
    return Buffer.from(s, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  // btoa needs ASCII — encode via TextEncoder + binary string roundtrip
  // so emoji / non-ASCII names in list items survive the trip.
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(s: string): string {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  if (typeof window === "undefined") return Buffer.from(padded, "base64").toString("utf8");
  const bin = atob(padded);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function normColor(c?: string): string | undefined {
  if (!c) return undefined;
  const v = c.trim().replace(/^#/, "").toLowerCase();
  return /^[0-9a-f]{3,8}$/.test(v) ? v : undefined;
}

/* --------- Public API ------------------------------------------------ */

export function encodeListToken(snap: SharedListSnapshot): string {
  const items = snap.items
    // Drop bogus rows defensively — a malformed item poisoning a token
    // shouldn't make the whole share link fail to parse.
    .filter(
      (it) =>
        Number.isFinite(it.lat) &&
        it.lat >= -90 &&
        it.lat <= 90 &&
        Number.isFinite(it.lng) &&
        it.lng >= -180 &&
        it.lng <= 180 &&
        it.name
    )
    // Cap to 100 to keep the URL well within size limits even with
    // long names. A 100-item list is already an extreme case.
    .slice(0, MAX_LIST_ITEMS)
    .map((it): [number, number, string] => [
      Number(it.lat.toFixed(5)),
      Number(it.lng.toFixed(5)),
      it.name.slice(0, 80),
    ]);
  const payload = {
    v:  LIST_TOKEN_VERSION,
    n:  snap.senderName?.slice(0, 32) || undefined,
    ln: snap.listName.slice(0, 60),
    c:  normColor(snap.color),
    i:  items,
  };
  return base64UrlEncode(JSON.stringify(payload));
}

interface RawListPayload {
  v?: unknown;
  n?: unknown;
  ln?: unknown;
  c?: unknown;
  i?: unknown;
}

export function decodeListToken(token: string): DecodedListToken | null {
  try {
    if (!token || token.length > MAX_LIST_TOKEN_CHARS) return null;
    const json = base64UrlDecode(token);
    const obj = JSON.parse(json) as RawListPayload;
    if (obj.v !== LIST_TOKEN_VERSION) return null;
    if (typeof obj.ln !== "string" || !obj.ln || obj.ln.length > 60) return null;
    if (!Array.isArray(obj.i)) return null;

    const items: Array<{ name: string; lat: number; lng: number }> = [];
    for (const raw of (obj.i as unknown[]).slice(0, MAX_LIST_ITEMS)) {
      if (!Array.isArray(raw) || raw.length < 3) continue;
      const lat = Number(raw[0]);
      const lng = Number(raw[1]);
      const name = String(raw[2] ?? "");
      if (
        !Number.isFinite(lat) || lat < -90 || lat > 90 ||
        !Number.isFinite(lng) || lng < -180 || lng > 180 ||
        !name
      ) continue;
      items.push({ name: name.slice(0, 80), lat, lng });
    }
    const normalizedColor = typeof obj.c === "string" ? normColor(obj.c) : undefined;
    return {
      version: obj.v,
      senderName: typeof obj.n === "string" ? obj.n.slice(0, 32) : undefined,
      listName: obj.ln,
      color: normalizedColor ? `#${normalizedColor}` : undefined,
      items,
    };
  } catch {
    return null;
  }
}

export function buildListShareUrl(snap: SharedListSnapshot, base?: string): string {
  const token = encodeListToken(snap);
  return buildFragmentShareUrl("/share/list", "t", token, base);
}
