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
  type LucideIcon,
} from "lucide-react";
import {
  CATEGORY_LABELS,
  useSavedDestinations,
  type SavedCategory,
  type SavedDestination,
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

const CATEGORY_ORDER: SavedCategory[] = ["home", "work", "favorite", "custom"];

export default function SavedPlaces({ onFlyTo, onDirections }: Props) {
  const { destinations, canSave, removeDestination, setCategory } = useSavedDestinations();
  const [openMenu, setOpenMenu] = useState<string | null>(null);

  const grouped = useMemo(() => {
    const out: Record<SavedCategory, SavedDestination[]> = {
      home: [],
      work: [],
      favorite: [],
      custom: [],
    };
    for (const d of destinations) {
      out[d.category].push(d);
    }
    return out;
  }, [destinations]);

  if (!canSave || destinations.length === 0) return null;

  return (
    <div className="px-4 pb-2">
      <h3
        className="text-[10px] font-semibold uppercase tracking-wider flex items-center gap-1.5 mb-1.5"
        style={{ color: "var(--panel-text-muted)" }}
      >
        <Star className="w-3 h-3" /> Saved Places
      </h3>

      <div className="space-y-2">
        {CATEGORY_ORDER.map((cat) => {
          const items = grouped[cat];
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
              {items.map((dest) => {
                const Icon = CATEGORY_ICON[dest.category];
                const color = CATEGORY_COLOR[dest.category];
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
                      style={{ color, fill: dest.category === "favorite" ? color : "transparent" }}
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
                        className="absolute right-2 top-full mt-1 z-20 rounded-lg shadow-2xl py-1 min-w-[140px]"
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
                          Move to
                        </p>
                        {CATEGORY_ORDER.filter((c) => c !== dest.category).map((c) => {
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
                              <ItemIcon
                                className="w-3.5 h-3.5"
                                style={{ color: CATEGORY_COLOR[c] }}
                              />
                              {CATEGORY_LABELS[c]}
                            </button>
                          );
                        })}
                        <div
                          className="my-1 mx-3 h-px"
                          style={{ background: "var(--panel-border)" }}
                        />
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
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}
