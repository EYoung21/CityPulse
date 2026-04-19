"use client";

/** Tiny in-app feedback / bug-report submitter.
 *
 *  Writes to Firestore `feedback/{id}`. Public-create, admin-read
 *  (rules pinned to the same admin email allow-list used elsewhere).
 *  We attach lightweight context (app version, viewport, pulse city,
 *  user-agent slug) so triage doesn't have to play 20 questions —
 *  but never anything sensitive (no precise location, no map state,
 *  no auth token).
 *
 *  Anonymous submissions are allowed (auth not required) so users can
 *  report breakage even if sign-in itself is what's broken. We mirror
 *  the auth uid + email when available so the team can follow up.
 */

import { addDoc, collection, getFirestore, serverTimestamp } from "firebase/firestore";
import { getFirebaseApp, isFirebaseConfigured } from "@/lib/firebase";
import { getCurrentCity } from "@/lib/pulse-cities";

const COLLECTION = "feedback";
const MESSAGE_MAX = 1000;
const EMAIL_MAX = 254;
const RATE_LIMIT_MS = 30_000;
const RATE_LIMIT_KEY = "pp:feedback-last-submit";

export type FeedbackKind = "bug" | "feature" | "praise" | "other";

export const FEEDBACK_KINDS: { kind: FeedbackKind; label: string; hint: string }[] = [
  { kind: "bug",     label: "Something's broken",  hint: "Crashes, wrong data, layout bugs"     },
  { kind: "feature", label: "Feature request",     hint: "What would make PhillyPulse better?" },
  { kind: "praise",  label: "Good vibes",          hint: "Tell us what you love (we read it!)"  },
  { kind: "other",   label: "General feedback",    hint: "Anything else"                         },
];

interface SubmitInput {
  kind: FeedbackKind;
  message: string;
  /** Optional contact email — only used if the user is signed-out
   *  or wants us to reply at a different address than their account. */
  contactEmail?: string;
}

interface CurrentUserSnapshot {
  uid: string | null;
  email: string | null;
  displayName: string | null;
  isAnonymous: boolean;
}

/** Lightweight client-context that we always attach so reports are
 *  actionable without a back-and-forth. Nothing personally
 *  identifying beyond what the user already exposes by visiting the
 *  site. */
function collectContext() {
  if (typeof window === "undefined") return {};
  return {
    url: window.location.pathname + window.location.hash,
    userAgent: navigator.userAgent.slice(0, 240),
    viewport: `${window.innerWidth}x${window.innerHeight}`,
    devicePixelRatio: window.devicePixelRatio || 1,
    language: navigator.language || null,
    online: navigator.onLine,
    city: getCurrentCity().slug,
  };
}

export function checkRateLimit(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(RATE_LIMIT_KEY);
    if (!raw) return null;
    const last = Number(raw);
    if (!Number.isFinite(last)) return null;
    const elapsed = Date.now() - last;
    if (elapsed >= RATE_LIMIT_MS) return null;
    const wait = Math.ceil((RATE_LIMIT_MS - elapsed) / 1000);
    return `Wait ${wait}s before sending more feedback.`;
  } catch {
    return null;
  }
}

export async function submitFeedback(
  input: SubmitInput,
  user: CurrentUserSnapshot
): Promise<string> {
  if (!isFirebaseConfigured()) {
    throw new Error("Feedback isn't available offline. Try again when you're connected.");
  }
  const message = input.message.trim();
  if (!message) throw new Error("Add a quick description before sending.");
  if (message.length > MESSAGE_MAX) {
    throw new Error(`Keep it under ${MESSAGE_MAX} characters please.`);
  }
  const blocked = checkRateLimit();
  if (blocked) throw new Error(blocked);

  const contactEmail = (input.contactEmail ?? "").trim().slice(0, EMAIL_MAX) || null;
  // Loose email sanity check — we don't want to reject obviously
  // valid addresses with strict regex, just catch obvious typos.
  if (contactEmail && !/^\S+@\S+\.\S+$/.test(contactEmail)) {
    throw new Error("That email doesn't look right. Double-check the format.");
  }

  const db = getFirestore(getFirebaseApp());
  const ref = await addDoc(collection(db, COLLECTION), {
    kind: input.kind,
    message: message.slice(0, MESSAGE_MAX),
    contactEmail,
    ownerUid: user.uid,
    ownerEmail: user.email,
    ownerDisplayName: user.displayName,
    ownerIsAnonymous: user.isAnonymous,
    appVersion: process.env.NEXT_PUBLIC_APP_VERSION || "dev",
    context: collectContext(),
    createdAt: serverTimestamp(),
    status: "new",
  });

  try {
    window.localStorage.setItem(RATE_LIMIT_KEY, String(Date.now()));
  } catch { /* ignore */ }

  return ref.id;
}
