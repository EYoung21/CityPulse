"use client";

import { useMemo, useState } from "react";
import {
  Star,
  Navigation,
  Trash2,
  Home,
  Briefcase,
  MapPin,
  MoreHorizontal,
  ChevronDown,
  ChevronRight,
  Plus,
  Folder,
  Pencil,
  Check,
  X,
  type LucideIcon,
} from "lucide-react";
import {
  CATEGORY_LABELS,
  useSavedDestinations,
  type SavedCategory,
  type SavedDestination,
  type SavedList,
} from "@/hooks/useSavedDestinations";

interface Props {
  onFlyTo: (lat: number, lng: number) => void;
  onDirections: (name: string, coords: { lat: number; lng: number }) => void;
}

const CATEGORY_ICON: Record<SavedCategory, LucideIcon> = {
  home: Home,
  work: Briefcase,
  favorite: Star,
  custom: MapPin,
};

const CATEGORY_COLOR: Record<SavedCategory, string> = {
  home: "#22c55e",
  work: "#3b82f6",
  favorite: "#f59e0b",
  custom: "#94a3b8",
};

const PINNED_ORDER: SavedCategory[] = ["home", "work", "favorite"];

/** Deterministic accent color from a list id — keeps the rendered hue
 *  stable across reloads even if the user didn't pick one explicitly. */
function listColor(list: SavedList): string {
  if (list.color) return list.color;
  const palette = ["#a78bfa", "#f472b6", "#34d399", "#fbbf24", "#60a5fa", "#fb7185", "#5eead4"];
  let hash = 0;
  for (let i = 0; i < list.id.length; i++) hash = (hash * 31 + list.id.charCodeAt(i)) & 0xfffffff;
  return palette[hash % palette.length];
}

export default function SavedPlaces({ onFlyTo, onDirections }: Props) {
  const {
    destinations,
    lists,
    canSave,
    removeDestination,
    setCategory,
    setDestinationList,
    createList,
    renameList,
    deleteList,
  } = useSavedDestinations();

  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [collapsedLists, setCollapsedLists] = useState<Set<string>>(new Set());
  const [renamingListId, setRenamingListId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [showCreateList, setShowCreateList] = useState(false);
  const [createDraft, setCreateDraft] = useState("");

  // Bucket destinations: pinned categories (home/work/favorite) stay
  // flat; custom destinations split between user-defined lists and
  // an "Other" bucket for un-listed customs.
  const grouped = useMemo(() => {
    const pinned: Record<SavedCategory, SavedDestination[]> = {
      home: [], work: [], favorite: [], custom: [],
    };
    const byList: Record<string, SavedDestination[]> = {};
    const unlisted: SavedDestination[] = [];
    for (const d of destinations) {
      if (d.category !== "custom") {
        pinned[d.category].push(d);
        continue;
      }
      if (d.listId && lists.some((l) => l.id === d.listId)) {
        (byList[d.listId] ||= []).push(d);
      } else {
        unlisted.push(d);
      }
    }
    return { pinned, byList, unlisted };
  }, [destinations, lists]);

  // Don't render an empty section for fresh accounts who have never
  // saved anything — the "Saved Places" header would just be noise.
  if (!canSave || (destinations.length === 0 && lists.length === 0)) return null;

  const toggleCollapse = (id: string) => {
    setCollapsedLists((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const handleCreateList = async () => {
    const name = createDraft.trim();
    if (!name) { setShowCreateList(false); return; }
    await createList(name);
    setCreateDraft("");
    setShowCreateList(false);
  };

  const handleRenameSubmit = async (id: string) => {
    const next = renameDraft.trim();
    if (next) await renameList(id, next);
    setRenamingListId(null);
    setRenameDraft("");
  };

  // Single destination row used inside both pinned categories and
  // user-defined lists. Pulled out so the move-menu logic stays in
  // one place. `accentColor` lets list-bound rows pick up their
  // parent list's hue rather than the default custom grey.
  const renderRow = (dest: SavedDestination, accentColor?: string) => {
    const Icon = CATEGORY_ICON[dest.category];
    const baseColor = accentColor ?? CATEGORY_COLOR[dest.category];
    const menuOpen = openMenu === dest.id;
    return (
      <div
        key={dest.id}
        className="relative flex items-center gap-2 px-3 py-2 rounded-lg transition-colors cursor-pointer group"
        style={{ background: "var(--panel-input-bg)" }}
        onClick={() => onFlyTo(dest.lat, dest.lng)}
        onMouseEnter={(e) => (e.currentTarget.style.background = "var(--panel-hover)")}
        onMouseLeave={(e) => (e.currentTarget.style.background = "var(--panel-input-bg)")}
      >
        <Icon
          className="w-3.5 h-3.5 shrink-0"
          style={{ color: baseColor, fill: dest.category === "favorite" ? baseColor : "transparent" }}
        />
        <span
          className="text-xs truncate flex-1"
          style={{ color: "var(--panel-text)" }}
          title={dest.name}
        >
          {dest.name}
        </span>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onDirections(dest.name, { lat: dest.lat, lng: dest.lng });
          }}
          className="opacity-0 group-hover:opacity-100 transition-opacity text-blue-500/50 hover:text-blue-500 shrink-0"
          title="Get directions"
          aria-label={`Get directions to ${dest.name}`}
        >
          <Navigation className="w-3.5 h-3.5" />
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation();
            setOpenMenu(menuOpen ? null : dest.id);
          }}
          className="opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
          style={{ color: "var(--panel-text-muted)" }}
          title="More"
          aria-label="More options"
        >
          <MoreHorizontal className="w-3.5 h-3.5" />
        </button>

        {menuOpen && (
          <div
            className="absolute right-2 top-full mt-1 z-20 rounded-lg shadow-2xl py-1 min-w-[180px] max-h-[60vh] overflow-y-auto"
            style={{
              background: "var(--panel-bg-secondary)",
              border: "1px solid var(--panel-border)",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <p
              className="text-[9px] uppercase tracking-wider px-3 py-1"
              style={{ color: "var(--panel-text-muted)" }}
            >
              Move to category
            </p>
            {PINNED_ORDER.filter((c) => c !== dest.category).map((c) => {
              const ItemIcon = CATEGORY_ICON[c];
              return (
                <button
                  key={c}
                  onClick={() => {
                    void setCategory(dest.id, c);
                    setOpenMenu(null);
                  }}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-xs"
                  style={{ color: "var(--panel-text-secondary)" }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = "var(--panel-hover)")}
                  onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                >
                  <ItemIcon className="w-3.5 h-3.5" style={{ color: CATEGORY_COLOR[c] }} />
                  {CATEGORY_LABELS[c]}
                </button>
              );
            })}

            {(lists.length > 0 || dest.category === "custom") && (
              <>
                <div
                  className="my-1 mx-3 h-px"
                  style={{ background: "var(--panel-border)" }}
                />
                <p
                  className="text-[9px] uppercase tracking-wider px-3 py-1"
                  style={{ color: "var(--panel-text-muted)" }}
                >
                  Move to list
                </p>
                <button
                  onClick={() => {
                    void setDestinationList(dest.id, null);
                    setOpenMenu(null);
                  }}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-xs"
                  style={{
                    color: dest.category === "custom" && !dest.listId ? "var(--panel-text)" : "var(--panel-text-secondary)",
                    background: dest.category === "custom" && !dest.listId ? "var(--panel-hover)" : "transparent",
                  }}
                >
                  <MapPin className="w-3.5 h-3.5" style={{ color: CATEGORY_COLOR.custom }} />
                  Uncategorized
                </button>
                {lists.map((l) => {
                  const isHere = dest.listId === l.id;
                  return (
                    <button
                      key={l.id}
                      onClick={() => {
                        void setDestinationList(dest.id, l.id);
                        setOpenMenu(null);
                      }}
                      className="w-full flex items-center gap-2 px-3 py-1.5 text-xs"
                      style={{
                        color: isHere ? "var(--panel-text)" : "var(--panel-text-secondary)",
                        background: isHere ? "var(--panel-hover)" : "transparent",
                      }}
                      onMouseEnter={(e) => { if (!isHere) e.currentTarget.style.background = "var(--panel-hover)"; }}
                      onMouseLeave={(e) => { if (!isHere) e.currentTarget.style.background = "transparent"; }}
                    >
                      <Folder className="w-3.5 h-3.5" style={{ color: listColor(l) }} />
                      <span className="truncate">{l.name}</span>
                    </button>
                  );
                })}
              </>
            )}

            <div className="my-1 mx-3 h-px" style={{ background: "var(--panel-border)" }} />
            <button
              onClick={() => {
                void removeDestination(dest.id);
                setOpenMenu(null);
              }}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-red-500"
              onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(239,68,68,0.08)")}
              onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
            >
              <Trash2 className="w-3.5 h-3.5" />
              Remove
            </button>
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="px-4 pb-2">
      <div className="flex items-center justify-between mb-1.5">
        <h3
          className="text-[10px] font-semibold uppercase tracking-wider flex items-center gap-1.5"
          style={{ color: "var(--panel-text-muted)" }}
        >
          <Star className="w-3 h-3" /> Saved Places
        </h3>
        <button
          type="button"
          onClick={() => setShowCreateList((v) => !v)}
          className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider transition-colors hover:opacity-100"
          style={{ color: "var(--panel-text-muted)", opacity: 0.8 }}
          title="Create a new list"
        >
          <Plus className="w-3 h-3" /> New list
        </button>
      </div>

      {showCreateList && (
        <div
          className="mb-2 flex items-center gap-1.5 px-2.5 py-2 rounded-lg"
          style={{ background: "var(--panel-input-bg)", border: "1px solid var(--panel-border)" }}
        >
          <Folder className="w-3.5 h-3.5 shrink-0" style={{ color: "var(--panel-text-muted)" }} />
          <input
            autoFocus
            value={createDraft}
            onChange={(e) => setCreateDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void handleCreateList();
              if (e.key === "Escape") { setShowCreateList(false); setCreateDraft(""); }
            }}
            placeholder="List name (e.g. Coffee shops)"
            maxLength={60}
            className="flex-1 bg-transparent outline-none text-xs"
            style={{ color: "var(--panel-text)" }}
          />
          <button
            onClick={() => void handleCreateList()}
            disabled={!createDraft.trim()}
            className="p-1 rounded text-blue-500 disabled:opacity-30 hover:bg-blue-500/10"
            aria-label="Create list"
          >
            <Check className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => { setShowCreateList(false); setCreateDraft(""); }}
            className="p-1 rounded transition-colors"
            style={{ color: "var(--panel-text-muted)" }}
            aria-label="Cancel"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      <div className="space-y-2">
        {/* Pinned categories: home / work / favorite */}
        {PINNED_ORDER.map((cat) => {
          const items = grouped.pinned[cat];
          if (items.length === 0) return null;
          const isPinned = cat === "home" || cat === "work";
          return (
            <div key={cat} className="space-y-1">
              {isPinned && (
                <p
                  className="text-[9px] uppercase tracking-wider px-1"
                  style={{ color: "var(--panel-text-muted)", letterSpacing: "0.08em" }}
                >
                  {CATEGORY_LABELS[cat]}
                </p>
              )}
              {items.map((dest) => renderRow(dest))}
            </div>
          );
        })}

        {/* User-defined lists */}
        {lists.map((list) => {
          const items = grouped.byList[list.id] ?? [];
          const collapsed = collapsedLists.has(list.id);
          const accent = listColor(list);
          const isRenaming = renamingListId === list.id;
          return (
            <div key={list.id} className="space-y-1">
              <div className="flex items-center gap-1 px-1">
                <button
                  type="button"
                  onClick={() => toggleCollapse(list.id)}
                  className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider hover:opacity-100 transition-opacity"
                  style={{
                    color: "var(--panel-text-muted)",
                    letterSpacing: "0.08em",
                    opacity: 0.85,
                  }}
                  aria-expanded={!collapsed}
                  aria-label={`Toggle ${list.name}`}
                >
                  {collapsed ? <ChevronRight className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                  <Folder className="w-3 h-3" style={{ color: accent }} />
                  {isRenaming ? (
                    <input
                      autoFocus
                      value={renameDraft}
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => setRenameDraft(e.target.value)}
                      onKeyDown={(e) => {
                        e.stopPropagation();
                        if (e.key === "Enter") void handleRenameSubmit(list.id);
                        if (e.key === "Escape") { setRenamingListId(null); setRenameDraft(""); }
                      }}
                      onBlur={() => void handleRenameSubmit(list.id)}
                      maxLength={60}
                      className="bg-transparent outline-none text-[10px] uppercase tracking-wider"
                      style={{ color: "var(--panel-text)", letterSpacing: "0.08em" }}
                    />
                  ) : (
                    <span>{list.name}</span>
                  )}
                  <span style={{ color: "var(--panel-text-muted)" }}>· {items.length}</span>
                </button>
                <div className="flex-1" />
                {!isRenaming && (
                  <>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setRenamingListId(list.id);
                        setRenameDraft(list.name);
                      }}
                      className="p-0.5 opacity-0 hover:opacity-100 group-hover:opacity-100 transition-opacity"
                      style={{ color: "var(--panel-text-muted)" }}
                      title="Rename list"
                      aria-label={`Rename list ${list.name}`}
                    >
                      <Pencil className="w-3 h-3" />
                    </button>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        const msg = items.length === 0
                          ? `Delete list "${list.name}"?`
                          : `Delete list "${list.name}"? Its ${items.length} place${items.length === 1 ? "" : "s"} will be moved back to Uncategorized.`;
                        if (window.confirm(msg)) void deleteList(list.id);
                      }}
                      className="p-0.5 opacity-0 hover:opacity-100 hover:text-red-500 transition-opacity"
                      style={{ color: "var(--panel-text-muted)" }}
                      title="Delete list"
                      aria-label={`Delete list ${list.name}`}
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </>
                )}
              </div>
              {!collapsed && (
                <>
                  {items.length === 0 ? (
                    <p
                      className="text-[10px] italic px-3 py-1.5"
                      style={{ color: "var(--panel-text-muted)" }}
                    >
                      Empty — assign a saved place via its menu.
                    </p>
                  ) : (
                    items.map((dest) => renderRow(dest, accent))
                  )}
                </>
              )}
            </div>
          );
        })}

        {/* Uncategorized custom destinations */}
        {grouped.unlisted.length > 0 && (
          <div className="space-y-1">
            {(lists.length > 0 || PINNED_ORDER.some((c) => grouped.pinned[c].length > 0)) && (
              <p
                className="text-[9px] uppercase tracking-wider px-1"
                style={{ color: "var(--panel-text-muted)", letterSpacing: "0.08em" }}
              >
                Other Saved
              </p>
            )}
            {grouped.unlisted.map((dest) => renderRow(dest))}
          </div>
        )}
      </div>
    </div>
  );
}
