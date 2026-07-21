"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/contexts/AuthContext";
import { isFirebaseConfigured } from "@/lib/firebase";
import { normalizeHttpUrl } from "@/lib/safe-url";
import {
  LogOut,
  LogIn,
  UserCircle,
  ChevronDown,
  Download,
  Upload,
  Loader2,
  Check,
  AlertCircle,
  Pencil,
  Trash2,
  X as XIcon,
} from "lucide-react";
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

type DeleteStatus =
  | { kind: "idle" }
  | { kind: "confirm" }
  | { kind: "running" }
  | { kind: "error"; message: string };

export default function AuthBar() {
  const router = useRouter();
  const { user, loading, signOutUser, updateDisplayName, deleteAccount } = useAuth();
  const { destinations, lists, addDestination, createList } = useSavedDestinations();
  const [open, setOpen] = useState(false);
  const [importStatus, setImportStatus] = useState<ImportStatus>({ kind: "idle" });
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  // Inline display-name editor state. We keep the draft separate from
  // the auth profile so cancelling discards changes without surprising
  // the user with mid-edit re-renders if the auth value updates.
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [nameSaving, setNameSaving] = useState(false);
  const [deleteStatus, setDeleteStatus] = useState<DeleteStatus>({ kind: "idle" });

  if (!isFirebaseConfigured() || loading || !user) {
    return null;
  }

  const label = user.isAnonymous
    ? "Guest"
    : user.displayName || user.email || "Signed in";
  const safePhotoUrl = normalizeHttpUrl(user.photoURL);

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

  const startNameEdit = () => {
    setNameDraft(user?.displayName ?? "");
    setEditingName(true);
  };

  const saveName = async () => {
    if (nameSaving) return;
    setNameSaving(true);
    try {
      await updateDisplayName(nameDraft);
      setEditingName(false);
    } finally {
      setNameSaving(false);
    }
  };

  const handleDeleteClick = async () => {
    if (deleteStatus.kind === "running") return;
    if (deleteStatus.kind !== "confirm") {
      setDeleteStatus({ kind: "confirm" });
      return;
    }
    setDeleteStatus({ kind: "running" });
    try {
      const outcome = await deleteAccount();
      if (outcome === "deleted") {
        setOpen(false);
        // Auth state listener will re-render with user=null and the
        // bar will hide itself; no further work needed here.
        return;
      }
      if (outcome === "requires-reauth") {
        setDeleteStatus({
          kind: "error",
          message: "For your safety, please sign out and sign back in, then try again.",
        });
        return;
      }
      setDeleteStatus({ kind: "idle" });
    } catch (e) {
      setDeleteStatus({
        kind: "error",
        message: e instanceof Error ? e.message : "Couldn't delete account",
      });
    }
  };

  const handleImportFile = async (file: File) => {
    setImportStatus({ kind: "running" });
    try {
      if (file.size > 2 * 1024 * 1024) {
        throw new Error("Import file is too large (maximum 2 MB).");
      }
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
        type="button"
        aria-label="Account menu"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 rounded-lg px-2.5 py-1.5 backdrop-blur-md shadow-lg transition-colors hover:brightness-110"
        style={{
          background: "var(--pill-bg, rgba(255,255,255,0.08))",
          border: "1px solid var(--pill-border, rgba(255,255,255,0.1))",
        }}
      >
        {safePhotoUrl ? (
          // Firebase profile photos can come from arbitrary identity-provider
          // hosts, so they intentionally bypass Next's fixed remote allowlist.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={safePhotoUrl}
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
            className="absolute bottom-full right-0 mb-2 w-60 rounded-xl shadow-2xl overflow-hidden backdrop-blur-md z-[999]"
            style={{ background: "var(--panel-bg)", border: "1px solid var(--panel-border)" }}
          >
            <div className="px-3 py-2.5" style={{ borderBottom: "1px solid var(--panel-border)" }}>
              {editingName && !user.isAnonymous ? (
                <div className="flex items-center gap-1.5">
                  <input
                    autoFocus
                    type="text"
                    aria-label="Display name"
                    value={nameDraft}
                    onChange={(e) => setNameDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void saveName();
                      else if (e.key === "Escape") setEditingName(false);
                    }}
                    placeholder="Display name"
                    maxLength={60}
                    disabled={nameSaving}
                    className="flex-1 min-w-0 px-2 py-1 rounded-md text-xs focus:outline-none focus:ring-1"
                    style={{
                      background: "var(--panel-input-bg)",
                      color: "var(--panel-text)",
                      border: "1px solid var(--panel-border)",
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => void saveName()}
                    disabled={nameSaving || !nameDraft.trim()}
                    className="p-1 rounded-md disabled:opacity-50"
                    style={{ color: "#22c55e" }}
                    aria-label="Save display name"
                    title="Save"
                  >
                    {nameSaving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
                  </button>
                  <button
                    type="button"
                    onClick={() => setEditingName(false)}
                    disabled={nameSaving}
                    className="p-1 rounded-md disabled:opacity-50"
                    style={{ color: "var(--panel-text-muted)" }}
                    aria-label="Cancel"
                    title="Cancel"
                  >
                    <XIcon className="w-3.5 h-3.5" />
                  </button>
                </div>
              ) : (
                <div className="flex items-center justify-between gap-2 min-w-0">
                  <p className="text-xs font-medium truncate min-w-0" style={{ color: "var(--panel-text)" }}>
                    {label}
                  </p>
                  {!user.isAnonymous && (
                    <button
                      type="button"
                      onClick={startNameEdit}
                      className="shrink-0 p-1 rounded-md transition-colors"
                      style={{ color: "var(--panel-text-muted)" }}
                      onMouseEnter={(e) => (e.currentTarget.style.background = "var(--panel-hover)")}
                      onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                      aria-label="Edit display name"
                      title="Edit display name"
                    >
                      <Pencil className="w-3 h-3" />
                    </button>
                  )}
                </div>
              )}
              {user.email && !user.isAnonymous && (
                <p className="text-[10px] truncate mt-0.5" style={{ color: "var(--panel-text-muted)" }}>
                  {user.email}
                </p>
              )}
              {user.isAnonymous && (
                <p className="text-[10px] leading-snug mt-0.5" style={{ color: "var(--panel-text-muted)" }}>
                  Sign in to save places, sync across devices, and get alerts.
                </p>
              )}
            </div>
            {user.isAnonymous && (
              <button type="button"
                onClick={() => { setOpen(false); router.push("/login"); }}
                className="w-full flex items-center gap-2.5 px-3 py-2.5 text-xs font-semibold transition-colors bg-blue-500/10 hover:bg-blue-500/20"
                style={{
                  color: "#3b82f6",
                  borderBottom: "1px solid var(--panel-border)",
                }}
              >
                <LogIn className="w-4 h-4" />
                Sign in / Create account
              </button>
            )}
            <button type="button"
              onClick={handleExport}
              className="w-full flex items-center gap-2.5 px-3 py-2.5 text-xs font-medium transition-colors hover:bg-white/5"
              style={{ color: "var(--panel-text)" }}
              title="Download a JSON snapshot of your saved data and preferences"
            >
              <Download className="w-4 h-4" style={{ color: "var(--panel-text-muted)" }} />
              Export my data
            </button>
            <button type="button"
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
            {/* Delete-account section. Only shown for non-anonymous
                users — anonymous "guest" sessions are wiped just by
                signing out, so a separate destroy action would be
                noise. Confirmation is inline (two taps) rather than a
                native confirm() dialog because confirm() text isn't
                customizable on iOS and the consequences of an
                accidental tap warrant a visible second step. */}
            {!user.isAnonymous && (
              <>
                {deleteStatus.kind === "error" && (
                  <div
                    className="px-3 py-2 text-[10px] flex items-start gap-1.5"
                    style={{ color: "#ef4444", background: "rgba(239,68,68,0.08)" }}
                  >
                    <AlertCircle className="w-3 h-3 shrink-0 mt-px" />
                    <span>{deleteStatus.message}</span>
                  </div>
                )}
                {deleteStatus.kind === "confirm" && (
                  <div
                    className="px-3 py-2 text-[10px] leading-snug"
                    style={{ color: "#fbbf24", background: "rgba(251,191,36,0.10)" }}
                  >
                    This permanently wipes your saved places, lists, trip history, and preferences. Tap again to confirm.
                  </div>
                )}
                <button type="button"
                  onClick={() => void handleDeleteClick()}
                  disabled={deleteStatus.kind === "running"}
                  className="w-full flex items-center gap-2.5 px-3 py-2.5 text-xs font-medium transition-colors text-red-400 hover:bg-red-500/10 disabled:opacity-50"
                  style={{ borderTop: "1px solid var(--panel-border)" }}
                >
                  {deleteStatus.kind === "running" ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Trash2 className="w-4 h-4" />
                  )}
                  {deleteStatus.kind === "confirm"
                    ? "Tap again to permanently delete"
                    : deleteStatus.kind === "running"
                      ? "Deleting…"
                      : "Delete my account"}
                </button>
              </>
            )}
            {/* A guest signing out would just be re-issued a fresh
                anonymous session by the auto-guest gate, so "Log out" is
                only meaningful for a real account. Guests upgrade via the
                "Sign in / Create account" CTA above instead. */}
            {!user.isAnonymous && (
              <button type="button"
                onClick={() => { setOpen(false); void signOutUser(); }}
                className="w-full flex items-center gap-2.5 px-3 py-2.5 text-xs font-medium transition-colors text-red-400 hover:bg-red-500/10"
              >
                <LogOut className="w-4 h-4" />
                Log out
              </button>
            )}
          </div>
          {/* Hidden file input — triggered programmatically by the
              "Import from file" button. Lives outside the dropdown so
              it survives close events. */}
          <input
            ref={fileInputRef}
            type="file"
            aria-label="Import CityPulse settings file"
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
