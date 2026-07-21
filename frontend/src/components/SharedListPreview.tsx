"use client";

import { useEffect, useState } from "react";
import { Check, ExternalLink, Loader2, MapPin, Share2 } from "lucide-react";
import type { DecodedListToken } from "@/lib/share-list";
import { useAuth } from "@/contexts/AuthContext";
import { useSavedDestinations } from "@/hooks/useSavedDestinations";

interface Props {
  snapshot: DecodedListToken;
}

type ImportState = "idle" | "importing" | "done" | "error";

/** Recipient view for a "Share my saved list" link. Renders a simple
 *  scrollable preview of the list's destinations and lets the user
 *  either:
 *    - "Add to my account" — creates a new SavedList in their Firestore
 *      and copies all destinations into it (auth required, anonymous
 *      users get prompted to sign in)
 *    - "Open in PhillyPulse" — bounces to the main app with the first
 *      item as a focus point (no account changes)
 *
 *  We deliberately don't render an embedded Leaflet map here — that
 *  would balloon the share-page bundle and these previews are usually
 *  10-30 items, perfectly readable as a list. */
export default function SharedListPreview({ snapshot }: Props) {
  const { user, signInWithGoogle, lastAuthError } = useAuth();
  const { canSave, lists, createList, addDestination } = useSavedDestinations();
  const [state, setState] = useState<ImportState>("idle");
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const [importedListId, setImportedListId] = useState<string | null>(null);

  const cleanColor = snapshot.color || "#3b82f6";

  // If the user already has a list with this exact name, the import
  // appends "(shared)" to disambiguate. We don't merge into the
  // existing list because that would silently create dupes if the
  // sender's catalog overlaps with the recipient's existing entries.
  const targetName = (() => {
    const exists = lists.some((l) => l.name === snapshot.listName);
    return exists ? `${snapshot.listName} (shared)` : snapshot.listName;
  })();

  const handleImport = async () => {
    if (!user || user.isAnonymous) {
      try {
        await signInWithGoogle();
        return; // The next render after auth state settles will show
                // the import button enabled; user re-taps.
      } catch {
        // Popup cancel is silent; other failures set lastAuthError in context.
        return;
      }
    }
    if (!canSave) {
      setErrMsg("Saving is unavailable right now");
      return;
    }
    setState("importing");
    setErrMsg(null);
    try {
      const listId = await createList(targetName, cleanColor);
      if (!listId) throw new Error("Failed to create list");
      // Sequence the writes so they land in the same order the sender
      // had them. Promise.all here would be faster but Firestore would
      // reorder them by createdAt resolution.
      for (const item of snapshot.items) {
        await addDestination(item.name, item.lat, item.lng, "custom", listId);
      }
      setImportedListId(listId);
      setState("done");
    } catch (e) {
      console.error("[pp] list import failed", e);
      setErrMsg(e instanceof Error ? e.message : "Import failed");
      setState("error");
    }
  };

  const handleOpenInApp = () => {
    // Focus the first item — recipient can pan from there. We pass
    // both lat/lng (for the URL hash) and a list-token query param so
    // a future enhancement can hydrate the markers without re-importing.
    if (snapshot.items.length === 0) {
      window.location.href = "/";
      return;
    }
    const first = snapshot.items[0];
    const url = `/#15/${first.lat.toFixed(5)}/${first.lng.toFixed(5)}`;
    window.location.href = url;
  };

  // After a successful import, replace the action area with a clear
  // confirmation rather than a "Re-import" button that's almost always
  // a mistake (would create dupes).
  useEffect(() => {
    if (state !== "done") return;
    const t = window.setTimeout(() => {
      // Drop the user into the main app once the visual confirmation
      // has had a beat to register.
      window.location.href = "/";
    }, 2400);
    return () => window.clearTimeout(t);
  }, [state]);

  return (
    <main
      style={{
        minHeight: "100vh",
        background: "linear-gradient(180deg, #0a0a14 0%, #0f172a 100%)",
        color: "#fff",
        fontFamily: "system-ui, -apple-system, sans-serif",
      }}
      className="flex flex-col items-center px-4 py-8"
    >
      <div className="w-full max-w-md">
        <div className="text-center mb-6">
          <p className="text-[11px] uppercase tracking-[0.2em] text-slate-500">
            PhillyPulse · Shared list
          </p>
          <div className="flex items-center justify-center gap-2 mt-3">
            <span
              className="inline-block w-3 h-3 rounded-full"
              style={{ background: cleanColor }}
              aria-hidden
            />
            <h1 className="text-2xl font-bold">{snapshot.listName}</h1>
          </div>
          {snapshot.senderName && (
            <p className="text-sm text-slate-400 mt-1">
              Shared by <span className="text-slate-200">{snapshot.senderName}</span>
            </p>
          )}
          <p className="text-xs text-slate-500 mt-2">
            {snapshot.items.length} {snapshot.items.length === 1 ? "place" : "places"}
          </p>
        </div>

        {/* Items list — capped to a comfortable scroll height so the
            CTA area stays in the viewport on mobile. */}
        <div
          className="rounded-2xl border border-white/10 overflow-hidden mb-4"
          style={{ background: "rgba(15, 23, 42, 0.6)", backdropFilter: "blur(12px)" }}
        >
          <ul
            className="divide-y divide-white/5 max-h-[40vh] overflow-y-auto"
          >
            {snapshot.items.map((it, idx) => (
              <li key={idx} className="flex items-start gap-3 px-3 py-2.5">
                <div
                  className="w-7 h-7 shrink-0 rounded-full flex items-center justify-center text-[11px] font-semibold"
                  style={{ background: `${cleanColor}33`, color: cleanColor }}
                >
                  {idx + 1}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium truncate">{it.name}</p>
                  <p className="text-[11px] text-slate-500 tabular-nums">
                    {it.lat.toFixed(4)}, {it.lng.toFixed(4)}
                  </p>
                </div>
                <a
                  href={`https://www.openstreetmap.org/?mlat=${it.lat}&mlon=${it.lng}#map=17/${it.lat}/${it.lng}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="shrink-0 mt-0.5 p-1.5 rounded-md text-slate-500 hover:text-slate-200 hover:bg-white/5"
                  aria-label="View on OpenStreetMap"
                  title="View on OpenStreetMap"
                >
                  <ExternalLink className="w-3.5 h-3.5" />
                </a>
              </li>
            ))}
            {snapshot.items.length === 0 && (
              <li className="px-3 py-6 text-center text-sm text-slate-500">
                This shared list has no places.
              </li>
            )}
          </ul>
        </div>

        {/* Action area */}
        <div className="space-y-2">
          {state === "done" ? (
            <div
              className="flex items-center justify-center gap-2 px-4 py-3 rounded-xl text-sm font-semibold"
              style={{ background: "rgba(34,197,94,0.15)", color: "#22c55e", border: "1px solid rgba(34,197,94,0.3)" }}
            >
              <Check className="w-4 h-4" />
              Added to your saved lists. Opening map…
            </div>
          ) : (
            <>
              <button
                type="button"
                onClick={handleImport}
                disabled={state === "importing" || snapshot.items.length === 0}
                className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl text-sm font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                style={{ background: cleanColor, color: "#fff" }}
              >
                {state === "importing" ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Importing {snapshot.items.length}…
                  </>
                ) : (
                  <>
                    <Share2 className="w-4 h-4" />
                    {user && !user.isAnonymous ? "Add to my saved lists" : "Sign in to add to my account"}
                  </>
                )}
              </button>
              <button
                type="button"
                onClick={handleOpenInApp}
                className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl text-sm font-medium border border-white/15 text-slate-200 hover:bg-white/5"
              >
                <MapPin className="w-4 h-4" />
                Open in PhillyPulse
              </button>
            </>
          )}
          {errMsg && (
            <p role="alert" className="text-xs text-rose-400 text-center mt-2">{errMsg}</p>
          )}
          {lastAuthError && (
            <p role="alert" className="text-xs text-rose-400 text-center mt-2">{lastAuthError}</p>
          )}
          {importedListId && state !== "done" && (
            <p className="text-[11px] text-slate-500 text-center">
              Imported as &ldquo;{targetName}&rdquo;
            </p>
          )}
        </div>

        <p className="text-[10px] text-slate-600 text-center mt-6 leading-relaxed">
          Shared lists are encoded directly in this link — nothing is uploaded
          to PhillyPulse&apos;s servers. The sender can&apos;t see who opens it.
        </p>
      </div>
    </main>
  );
}
