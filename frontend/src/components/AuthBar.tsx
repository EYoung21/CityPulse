"use client";

import { useRef, useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { isFirebaseConfigured } from "@/lib/firebase";
import { LogOut, UserCircle, ChevronDown, Download, Upload, Loader2, Check, AlertCircle } from "lucide-react";
import { useSavedDestinations } from "@/hooks/useSavedDestinations";
import {
  applyAccountImport,
  buildAccountExport,
  downloadAccountExport,
  parseAccountExport,
  type ImportResult,
} from "@/lib/account-export";

type ImportStatus =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "done"; result: ImportResult }
  | { kind: "error"; message: string };

export default function AuthBar() {
  const { user, loading, signOutUser } = useAuth();
  const { destinations, lists, addDestination, createList } = useSavedDestinations();
  const [open, setOpen] = useState(false);
  const [importStatus, setImportStatus] = useState<ImportStatus>({ kind: "idle" });
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  if (!isFirebaseConfigured() || loading || !user) {
    return null;
  }

  const label = user.isAnonymous
    ? "Guest"
    : user.displayName || user.email || "Signed in";

  const handleExport = () => {
    const exp = buildAccountExport({
      savedDestinations: destinations,
      savedLists: lists,
      account: {
        name: user.displayName || undefined,
        email: user.email || undefined,
      },
    });
    downloadAccountExport(exp);
    setOpen(false);
  };

  const handleImportClick = () => {
    fileInputRef.current?.click();
  };

  const handleImportFile = async (file: File) => {
    setImportStatus({ kind: "running" });
    try {
      const text = await file.text();
      const exp = parseAccountExport(text);
      const result = await applyAccountImport(exp, {
        upsertList: async (list) => {
          // Map by name: if a list with this name already exists, reuse
          // its id rather than creating a duplicate. Color from the
          // export wins.
          const existing = lists.find((l) => l.name === list.name);
          if (existing) return existing.id;
          return await createList(list.name, list.color || undefined);
        },
        upsertDestination: async (dest, remappedListId) => {
          // Skip if a destination with the same lat/lng already exists
          // — by lat/lng we mean ≈11m, the same threshold pushRecent
          // uses. Avoids importing the same Home pin twice.
          const exists = destinations.some(
            (d) => Math.abs(d.lat - dest.lat) < 1e-4 && Math.abs(d.lng - dest.lng) < 1e-4
          );
          if (exists) return;
          await addDestination(dest.name, dest.lat, dest.lng, dest.category, remappedListId);
        },
      });
      setImportStatus({ kind: "done", result });
      // Auto-clear after a few seconds so the menu returns to its
      // normal state.
      window.setTimeout(() => setImportStatus({ kind: "idle" }), 4000);
    } catch (err) {
      setImportStatus({
        kind: "error",
        message: err instanceof Error ? err.message : "Import failed",
      });
    } finally {
      // Reset file input so re-selecting the same file fires onChange.
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 rounded-lg px-2.5 py-1.5 backdrop-blur-md shadow-lg transition-colors hover:brightness-110"
        style={{
          background: "var(--pill-bg, rgba(255,255,255,0.08))",
          border: "1px solid var(--pill-border, rgba(255,255,255,0.1))",
        }}
      >
        {user.photoURL ? (
          <img
            src={user.photoURL}
            alt=""
            className="w-5 h-5 rounded-full"
            referrerPolicy="no-referrer"
          />
        ) : (
          <UserCircle className="w-4 h-4 shrink-0" style={{ color: "var(--panel-text-muted)" }} />
        )}
        <span
          className="text-xs max-w-[120px] truncate hidden sm:inline"
          style={{ color: "var(--pill-text, #ccc)" }}
          title={label}
        >
          {label}
        </span>
        <ChevronDown
          className={`w-3 h-3 transition-transform ${open ? "rotate-180" : ""}`}
          style={{ color: "var(--panel-text-muted)" }}
        />
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-[998]" onClick={() => setOpen(false)} />
          <div
            className="absolute bottom-full right-0 mb-2 w-48 rounded-xl shadow-2xl overflow-hidden backdrop-blur-md z-[999]"
            style={{ background: "var(--panel-bg)", border: "1px solid var(--panel-border)" }}
          >
            <div className="px-3 py-2.5" style={{ borderBottom: "1px solid var(--panel-border)" }}>
              <p className="text-xs font-medium truncate" style={{ color: "var(--panel-text)" }}>
                {label}
              </p>
              {user.email && !user.isAnonymous && (
                <p className="text-[10px] truncate mt-0.5" style={{ color: "var(--panel-text-muted)" }}>
                  {user.email}
                </p>
              )}
            </div>
            <button
              onClick={handleExport}
              className="w-full flex items-center gap-2.5 px-3 py-2.5 text-xs font-medium transition-colors hover:bg-white/5"
              style={{ color: "var(--panel-text)" }}
              title="Download a JSON snapshot of your saved data and preferences"
            >
              <Download className="w-4 h-4" style={{ color: "var(--panel-text-muted)" }} />
              Export my data
            </button>
            <button
              onClick={handleImportClick}
              disabled={importStatus.kind === "running"}
              className="w-full flex items-center gap-2.5 px-3 py-2.5 text-xs font-medium transition-colors hover:bg-white/5 disabled:opacity-50"
              style={{
                color: "var(--panel-text)",
                borderBottom: "1px solid var(--panel-border)",
              }}
              title="Restore a JSON snapshot from another device"
            >
              {importStatus.kind === "running" ? (
                <Loader2 className="w-4 h-4 animate-spin" style={{ color: "var(--panel-text-muted)" }} />
              ) : (
                <Upload className="w-4 h-4" style={{ color: "var(--panel-text-muted)" }} />
              )}
              {importStatus.kind === "running" ? "Importing…" : "Import from file"}
            </button>
            {importStatus.kind === "done" && (
              <div
                className="px-3 py-2 text-[10px] flex items-start gap-1.5"
                style={{ color: "#22c55e", background: "rgba(34,197,94,0.08)" }}
              >
                <Check className="w-3 h-3 shrink-0 mt-px" />
                <span>
                  Imported {importStatus.result.imported.savedDestinations} places, {importStatus.result.imported.savedLists} lists, {importStatus.result.imported.tripHistory} trips, {importStatus.result.imported.recentSearches} recents{importStatus.result.imported.parkedPin ? ", parked pin" : ""}.
                </span>
              </div>
            )}
            {importStatus.kind === "error" && (
              <div
                className="px-3 py-2 text-[10px] flex items-start gap-1.5"
                style={{ color: "#ef4444", background: "rgba(239,68,68,0.08)" }}
              >
                <AlertCircle className="w-3 h-3 shrink-0 mt-px" />
                <span>{importStatus.message}</span>
              </div>
            )}
            <button
              onClick={() => { setOpen(false); void signOutUser(); }}
              className="w-full flex items-center gap-2.5 px-3 py-2.5 text-xs font-medium transition-colors text-red-400 hover:bg-red-500/10"
            >
              <LogOut className="w-4 h-4" />
              Log out
            </button>
          </div>
          {/* Hidden file input — triggered programmatically by the
              "Import from file" button. Lives outside the dropdown so
              it survives close events. */}
          <input
            ref={fileInputRef}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void handleImportFile(file);
            }}
          />
        </>
      )}
    </div>
  );
}
