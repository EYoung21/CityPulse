import {
  collection,
  getFirestore,
  limit as limitFn,
  onSnapshot,
  orderBy,
  query,
} from "firebase/firestore";
import { getFirebaseApp } from "@/lib/firebase";
import type { Incident } from "@/lib/api";
import { enrichIncidents } from "@/lib/incident-weights";

const COLLECTION = "incidents";
const MAX_DOCS = 500;

function mapDoc(id: string, data: Record<string, unknown>): Incident {
  return {
    id,
    reported_at: String(data.reported_at ?? ""),
    raw_text: String(data.raw_text ?? ""),
    severity_category: String(data.severity_category ?? ""),
    s_base: Number(data.s_base ?? 0),
    location_text:
      data.location_text === null || data.location_text === undefined
        ? null
        : String(data.location_text),
    lat:
      data.lat === null || data.lat === undefined ? null : Number(data.lat),
    lng:
      data.lng === null || data.lng === undefined ? null : Number(data.lng),
    confidence: Number(data.confidence ?? 1),
    geocode_status: String(data.geocode_status ?? "pending"),
    inhibitor_status: String(data.inhibitor_status ?? "passed"),
    inhibitor_reason:
      data.inhibitor_reason === null || data.inhibitor_reason === undefined
        ? null
        : String(data.inhibitor_reason),
    w_eff: 0,
  };
}

/**
 * Live incidents for the map (non-blocked only). Caller should filter by category client-side if needed.
 */
export function subscribeIncidents(
  onData: (incidents: Incident[]) => void,
  onError?: (e: Error) => void
): () => void {
  const db = getFirestore(getFirebaseApp());
  const q = query(
    collection(db, COLLECTION),
    orderBy("reported_at", "desc"),
    limitFn(MAX_DOCS)
  );

  return onSnapshot(
    q,
    (snap) => {
      const list: Incident[] = [];
      snap.forEach((doc) => {
        const row = mapDoc(doc.id, doc.data());
        if (row.inhibitor_status !== "blocked") {
          list.push(row);
        }
      });
      onData(enrichIncidents(list));
    },
    (err) => {
      onError?.(err instanceof Error ? err : new Error(String(err)));
    }
  );
}
