import { createHash } from "node:crypto";
import {
  FieldValue,
  Timestamp,
  getFirestore,
} from "firebase-admin/firestore";
import { ensureAdmin } from "@/lib/server-incidents";

type PublicIncident = {
  sourceId: string;
  sourceKey: string;
  city: string;
  reportedAt: string;
  eventType: string;
  locationText: string | null;
  lat: number | null;
  lng: number | null;
  status: string | null;
  category: string;
};

type SourceDefinition = {
  city: string;
  intervalMs: number;
  fetch: () => Promise<PublicIncident[]>;
};

const MAX_AGE_MS = 72 * 60 * 60 * 1_000;
const MAX_SEEN_IDS = 1_500;
const USER_AGENT = "CityPulse/2.0 (+https://phlpulse.com)";

const SENSITIVE_RE =
  /\b(?:amber alert|silver alert|missing (?:child|minor|juvenile|person|vulnerable|student)|child abduction|juvenile|minor|sexual|rape|domestic|suicid(?:e|al)|mental health|emotionally disturbed|well[- ]?being check|welfare check|overdose|5150)\b/i;
const ADMIN_RE =
  /\b(?:supplemental reports?|property check|administrative|test call|planned flyover|drill|exercise|alarm system - unnecessary)\b/i;
const MEDICAL_RE =
  /\b(?:ems|medical|medic|patient|cardiac|unconscious|respiratory|seizure|syncopal|injur(?:y|ies|ed)|fall victim|lift assist)\b/i;

function htmlText(value: string): string {
  return value
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#32;/gi, " ")
    .replace(/&#47;/gi, "/")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function finiteNumber(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

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
      const block = number < 100 ? "unit block" : `${Math.floor(number / 100) * 100} block`;
      text = `${block} ${match[2]}`;
    }
  }
  return text.slice(0, 180);
}

export function classifyPublicEvent(value: string): string | null {
  const text = value.replace(/\s+/g, " ").trim().toLowerCase();
  if (!text || SENSITIVE_RE.test(text) || ADMIN_RE.test(text)) return null;
  if (text.includes("no weapon") && /assault|fight/.test(text)) {
    return "violent_no_weapon";
  }
  if (/shoot|shots|firearm|weapon|stab|homicide/.test(text)) {
    return "violent_weapon";
  }
  if (text.includes("robbery")) return "robbery";
  if (/burglary|breaking and entering/.test(text)) return "burglary_in_progress";
  if (/assault|fight/.test(text)) return "violent_no_weapon";
  if (/fire|hazmat|gas leak|explosion|smoke/.test(text)) return "fire_hazmat";
  if (/vehicle accident|collision|traffic crash|mva/.test(text)) {
    return text.includes("injur")
      ? "traffic_crash_injury"
      : "traffic_crash_no_injury";
  }
  if (MEDICAL_RE.test(text)) {
    return /cardiac|unconscious|respiratory|priority 1/.test(text)
      ? "medical_priority"
      : "medical_other";
  }
  if (/police activity|disorder|theft|vandal|trespass|disturbance|suspicious/.test(text)) {
    return "disorder";
  }
  if (/structural incident|building collapse/.test(text)) return "fire_hazmat";
  return null;
}

function publicDescription(eventType: string, category: string): string {
  return category === "medical_priority" || category === "medical_other"
    ? "Medical response"
    : eventType.replace(/\s+/g, " ").trim().slice(0, 180);
}

function zonedLocalIso(value: string, timeZone: string): string | null {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?$/.exec(
      value.trim(),
    );
  if (!match) return null;
  const numbers = match.slice(1).map(Number);
  const wallClockUtc = Date.UTC(
    numbers[0],
    numbers[1] - 1,
    numbers[2],
    numbers[3],
    numbers[4],
    numbers[5],
  );
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const displayed = Object.fromEntries(
    formatter
      .formatToParts(new Date(wallClockUtc))
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)]),
  );
  const displayedUtc = Date.UTC(
    displayed.year,
    displayed.month - 1,
    displayed.day,
    displayed.hour,
    displayed.minute,
    displayed.second,
  );
  const actualUtc = wallClockUtc - (displayedUtc - wallClockUtc);
  return new Date(actualUtc).toISOString().replace(/Z$/, "+00:00");
}

function absoluteIso(value: string): string | null {
  const millis = Date.parse(value);
  return Number.isFinite(millis)
    ? new Date(millis).toISOString().replace(/Z$/, "+00:00")
    : null;
}

function incident(values: {
  sourceId: string;
  sourceKey: unknown;
  city: string;
  reportedAt: string | null;
  eventType: string;
  classificationText?: string;
  locationText: unknown;
  lat?: unknown;
  lng?: unknown;
  status?: unknown;
}): PublicIncident | null {
  const sourceKey =
    values.sourceKey === null || values.sourceKey === undefined
      ? ""
      : String(values.sourceKey).trim();
  if (!sourceKey || !values.reportedAt) return null;
  const category = classifyPublicEvent(
    values.classificationText || `${values.eventType} ${values.status || ""}`,
  );
  if (!category) return null;
  const [lat, lng] = publicCoordinates(values.lat, values.lng);
  return {
    sourceId: values.sourceId,
    sourceKey,
    city: values.city,
    reportedAt: values.reportedAt,
    eventType: publicDescription(values.eventType, category),
    locationText: publicLocation(values.locationText),
    lat,
    lng,
    status: values.status ? String(values.status).trim().slice(0, 80) : null,
    category,
  };
}

function objects(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter(
        (row): row is Record<string, unknown> =>
          !!row && typeof row === "object" && !Array.isArray(row),
      )
    : [];
}

async function fetchJson(
  url: string,
  init?: RequestInit,
): Promise<unknown> {
  const response = await fetch(url, {
    ...init,
    headers: {
      "User-Agent": USER_AGENT,
      ...(init?.headers || {}),
    },
    signal: AbortSignal.timeout(20_000),
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  return response.json();
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: { "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(20_000),
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  return response.text();
}

async function chattanooga(): Promise<PublicIncident[]> {
  const rows = objects(
    await fetchJson("https://hc911server.com/api/calls", {
      headers: { "X-Frontend-Auth": "my-secure-token" },
    }),
  );
  return rows.flatMap((row) => {
    const rawTime = String(row.creation || "").replace(/Z$/, "");
    const eventType = `${row.agency_type === "EMS" ? "Medical response " : ""}${
      row.type_description || row.type || ""
    }`;
    const parsed = incident({
      sourceId: "hc911",
      sourceKey: row.master_incident_id || row.sequencenumber || row.id,
      city: "chattanooga",
      reportedAt: zonedLocalIso(rawTime, "America/New_York"),
      eventType,
      locationText: row.location,
      lat: row.latitude,
      lng: row.longitude,
      status: row.status,
    });
    return parsed ? [parsed] : [];
  });
}

async function dataSfPolice(): Promise<PublicIncident[]> {
  const url = new URL("https://data.sfgov.org/resource/gnap-fj3t.json");
  url.searchParams.set("$limit", "500");
  url.searchParams.set("$order", "received_datetime DESC");
  return objects(await fetchJson(url.toString())).flatMap((row) => {
    if (row.sensitive_call === true || String(row.sensitive_call).toLowerCase() === "true") {
      return [];
    }
    const point =
      row.intersection_point && typeof row.intersection_point === "object"
        ? (row.intersection_point as Record<string, unknown>)
        : {};
    const coordinates = Array.isArray(point.coordinates) ? point.coordinates : [];
    const parsed = incident({
      sourceId: "datasf-police",
      sourceKey: row.id || row.cad_number,
      city: "sf",
      reportedAt: zonedLocalIso(
        String(row.received_datetime || ""),
        "America/Los_Angeles",
      ),
      eventType: String(
        row.call_type_final_desc || row.call_type_original_desc || "",
      ),
      locationText: row.intersection_name,
      lat: coordinates[1],
      lng: coordinates[0],
      status: row.disposition,
    });
    return parsed ? [parsed] : [];
  });
}

async function dataSfFire(): Promise<PublicIncident[]> {
  const url = new URL("https://data.sfgov.org/resource/nuek-vuh3.json");
  url.searchParams.set("$limit", "500");
  url.searchParams.set("$order", "received_dttm DESC");
  const seen = new Set<string>();
  return objects(await fetchJson(url.toString())).flatMap((row) => {
    const sourceKey = String(row.incident_number || row.call_number || "");
    if (!sourceKey || seen.has(sourceKey)) return [];
    seen.add(sourceKey);
    const point =
      row.case_location && typeof row.case_location === "object"
        ? (row.case_location as Record<string, unknown>)
        : {};
    const coordinates = Array.isArray(point.coordinates) ? point.coordinates : [];
    const parsed = incident({
      sourceId: "datasf-fire",
      sourceKey,
      city: "sf",
      reportedAt: zonedLocalIso(
        String(row.received_dttm || ""),
        "America/Los_Angeles",
      ),
      eventType: String(row.call_type || ""),
      locationText: row.address,
      lat: coordinates[1],
      lng: coordinates[0],
      status: row.call_final_disposition,
    });
    return parsed ? [parsed] : [];
  });
}

async function phillyPolice(): Promise<PublicIncident[]> {
  const query =
    "select dc_key, objectid, dispatch_date_time, location_block, " +
    "text_general_code, point_x, point_y from incidents_part1_part2 " +
    "where dispatch_date_time is not null and point_x is not null and " +
    "point_y is not null order by dispatch_date_time desc limit 500";
  const url = new URL("https://phl.carto.com/api/v2/sql");
  url.searchParams.set("q", query);
  const payload = await fetchJson(url.toString());
  const rows =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? objects((payload as Record<string, unknown>).rows)
      : [];
  return rows.flatMap((row) => {
    const parsed = incident({
      sourceId: "phl-police",
      sourceKey: row.dc_key || row.objectid,
      city: "philly",
      reportedAt: absoluteIso(String(row.dispatch_date_time || "")),
      eventType: String(row.text_general_code || ""),
      locationText: row.location_block,
      lat: row.point_y,
      lng: row.point_x,
    });
    return parsed ? [parsed] : [];
  });
}

function rssItems(xml: string): string[] {
  return [...xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)].map(
    (match) => match[1],
  );
}

function xmlField(item: string, name: string): string {
  const match = new RegExp(
    `<${name}\\b[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${name}>`,
    "i",
  ).exec(item);
  return match ? htmlText(match[1]) : "";
}

async function montcoCad(): Promise<PublicIncident[]> {
  return rssItems(
    await fetchText("https://webapp07.montcopa.org/eoc/cadinfo/livecadrss.asp"),
  ).flatMap((item) => {
    const title = xmlField(item, "title");
    const description = xmlField(item, "description");
    const parts = description.split(";").map((part) => part.trim()).filter(Boolean);
    const time = /\d{4}-\d{2}-\d{2}\s+@\s+\d{2}:\d{2}:\d{2}/.exec(description)?.[0];
    if (parts.length < 3 || !time) return [];
    const eventType = title.replace(/^EMS:/i, "Medical response:");
    const parsed = incident({
      sourceId: "montco-cad",
      sourceKey: `${title}|${parts[0]}|${time}`,
      city: "philly",
      reportedAt: zonedLocalIso(
        time.replace(/\s+@\s+/, "T"),
        "America/New_York",
      ),
      eventType,
      locationText: `${parts[0]}, ${parts[1]}`,
    });
    return parsed ? [parsed] : [];
  });
}

async function chescoCad(): Promise<PublicIncident[]> {
  const html = await fetchText("https://webcad.chesco.org/WebCad/");
  return [...html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].flatMap((rowMatch) => {
    const cells = [...rowMatch[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(
      (cell) => htmlText(cell[1]),
    );
    if (cells.length !== 6 || /^incident/i.test(cells[0])) return [];
    const [sourceKey, eventType, location, municipality, dispatchTime] = cells;
    const dateMatch =
      /^(\d{2})-(\d{2})-(\d{4})\s+(\d{2}:\d{2}:\d{2})$/.exec(dispatchTime);
    if (!dateMatch) return [];
    const local = `${dateMatch[3]}-${dateMatch[1]}-${dateMatch[2]}T${dateMatch[4]}`;
    const parsed = incident({
      sourceId: "chesco-cad",
      sourceKey,
      city: "philly",
      reportedAt: zonedLocalIso(local, "America/New_York"),
      eventType,
      locationText: `${location}, ${municipality}`,
    });
    return parsed ? [parsed] : [];
  });
}

function notifyLocation(title: string, description: string): string | null {
  for (const pattern of [
    /\bin the area of (.+?) in (?:Manhattan|Brooklyn|Queens|Bronx|Staten Island)\b/i,
    /\bon (.+?) in (?:Manhattan|Brooklyn|Queens|Bronx|Staten Island)\b/i,
    /\bnear (.+?) in (?:Manhattan|Brooklyn|Queens|Bronx|Staten Island)\b/i,
  ]) {
    const match = pattern.exec(description);
    if (match) return match[1].replace(/[ .]+$/, "");
  }
  const parts = title.split(" - ").map((part) => part.trim()).filter(Boolean);
  return parts.length >= 3 ? parts[parts.length - 1] : null;
}

async function notifyNyc(): Promise<PublicIncident[]> {
  return rssItems(
    await fetchText(
      "https://feeds.everbridge.net/feeds/453003085617722/rss/rss.xml",
    ),
  ).flatMap((item) => {
    const title = xmlField(item, "title");
    const description = xmlField(item, "description");
    const combined = `${title} ${description}`;
    if (SENSITIVE_RE.test(combined)) return [];
    const eventType = title.replace(/^Notify NYC - /i, "").split(" - ", 1)[0];
    const parsed = incident({
      sourceId: "notify-nyc",
      sourceKey:
        xmlField(item, "guid") ||
        xmlField(item, "link") ||
        `${title}|${xmlField(item, "pubDate")}`,
      city: "nyc",
      reportedAt: absoluteIso(xmlField(item, "pubDate")),
      eventType,
      classificationText: combined,
      locationText: notifyLocation(title, description),
    });
    return parsed ? [parsed] : [];
  });
}

const SOURCES: Record<string, SourceDefinition> = {
  hc911: { city: "chattanooga", intervalMs: 60_000, fetch: chattanooga },
  "datasf-police": { city: "sf", intervalMs: 10 * 60_000, fetch: dataSfPolice },
  "datasf-fire": { city: "sf", intervalMs: 10 * 60_000, fetch: dataSfFire },
  "phl-police": { city: "philly", intervalMs: 15 * 60_000, fetch: phillyPolice },
  "montco-cad": { city: "philly", intervalMs: 2 * 60_000, fetch: montcoCad },
  "chesco-cad": { city: "philly", intervalMs: 2 * 60_000, fetch: chescoCad },
  "notify-nyc": { city: "nyc", intervalMs: 2 * 60_000, fetch: notifyNyc },
};

function incidentId(sourceId: string, sourceKey: string): string {
  return `public-${createHash("sha256")
    .update(`${sourceId}\x1f${sourceKey}`)
    .digest("hex")
    .slice(0, 24)}`;
}

function sourceBase(category: string): number {
  return {
    violent_weapon: 1,
    violent_no_weapon: 0.85,
    shots_heard: 0.9,
    robbery: 0.8,
    burglary_in_progress: 0.65,
    medical_priority: 0.6,
    medical_other: 0.35,
    fire_hazmat: 0.75,
    traffic_crash_injury: 0.55,
    traffic_crash_no_injury: 0.3,
    disorder: 0.4,
  }[category] ?? 0.5;
}

function timestampMillis(value: unknown): number {
  if (value instanceof Timestamp) return value.toMillis();
  if (value && typeof value === "object" && "toMillis" in value) {
    const toMillis = (value as { toMillis?: unknown }).toMillis;
    if (typeof toMillis === "function") {
      const millis = Number(toMillis.call(value));
      return Number.isFinite(millis) ? millis : 0;
    }
  }
  return 0;
}

async function refreshSource(sourceId: string): Promise<void> {
  ensureAdmin();
  const definition = SOURCES[sourceId];
  const db = getFirestore();
  const stateRef = db.doc(`publicSourceState/${sourceId}`);
  const now = Date.now();
  const claim = await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(stateRef);
    const data = snapshot.data() || {};
    if (timestampMillis(data.nextPollAt) > now) return null;
    transaction.set(
      stateRef,
      {
        nextPollAt: Timestamp.fromMillis(now + definition.intervalMs),
        leaseStartedAt: Timestamp.fromMillis(now),
      },
      { merge: true },
    );
    return Array.isArray(data.seenIds)
      ? data.seenIds.filter((value): value is string => typeof value === "string")
      : [];
  });
  if (claim === null) return;

  try {
    const fetched = await definition.fetch();
    const seen = new Set(claim);
    const fresh = fetched.filter((row) => {
      const age = now - Date.parse(row.reportedAt);
      return Number.isFinite(age) && age >= -10 * 60_000 && age <= MAX_AGE_MS;
    });
    const newRows = fresh
      .filter((row) => !seen.has(incidentId(row.sourceId, row.sourceKey)))
      .slice(0, 450);
    const batch = db.batch();
    const ingestedAt = new Date(now).toISOString().replace(/Z$/, "+00:00");
    for (const row of newRows) {
      const id = incidentId(row.sourceId, row.sourceKey);
      seen.add(id);
      batch.set(db.doc(`incidents/${id}`), {
        reported_at: row.reportedAt,
        ingested_at: ingestedAt,
        raw_text: row.eventType,
        severity_category: row.category,
        s_base: sourceBase(row.category),
        location_text: row.locationText,
        lat: row.lat,
        lng: row.lng,
        confidence: 1,
        geocode_status: row.lat === null ? "failed" : "source",
        location_confidence: row.lat === null ? "none" : "medium",
        inhibitor_status: "passed",
        inhibitor_reason: "structured public source; privacy reduced",
        audio_clip: null,
        feed_id: row.sourceId,
        description: row.eventType,
        unit_status: row.status,
        has_word_timings: false,
        city: row.city,
        mentions: [],
        mention_count: 0,
        last_mention_at: row.reportedAt,
      });
    }
    batch.set(
      stateRef,
      {
        seenIds: [...seen].slice(-MAX_SEEN_IDS),
        lastSuccessAt: FieldValue.serverTimestamp(),
        lastFetchedCount: fetched.length,
        lastCreatedCount: newRows.length,
        lastError: FieldValue.delete(),
      },
      { merge: true },
    );
    await batch.commit();
  } catch (error) {
    await stateRef.set(
      {
        lastErrorAt: FieldValue.serverTimestamp(),
        lastError:
          error instanceof Error ? error.message.slice(0, 500) : "unknown",
      },
      { merge: true },
    );
    throw error;
  }
}

export async function refreshPublicSources(city: string): Promise<void> {
  const selected = Object.entries(SOURCES)
    .filter(([, definition]) => definition.city === city)
    .map(([sourceId]) => sourceId);
  await Promise.all(
    selected.map(async (sourceId) => {
      try {
        await refreshSource(sourceId);
      } catch (error) {
        console.warn("[public-source-refresh] failed", {
          sourceId,
          error: error instanceof Error ? error.message : "unknown",
        });
      }
    }),
  );
}
