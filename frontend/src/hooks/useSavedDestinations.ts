"use client";

import { useCallback, useEffect, useState } from "react";
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getFirestore,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  updateDoc,
  writeBatch,
} from "firebase/firestore";
import { getFirebaseApp, isFirebaseConfigured } from "@/lib/firebase";
import { useAuth } from "@/contexts/AuthContext";

/** Built-in categories pinned at top of the list. `custom` is everything
 *  else (the user's freeform saved places). */
export type SavedCategory = "home" | "work" | "favorite" | "custom";

export const CATEGORY_LABELS: Record<SavedCategory, string> = {
  home: "Home",
  work: "Work",
  favorite: "Favorite",
  custom: "Saved",
};

/** A user-defined named bucket for grouping custom destinations
 *  (e.g. "Coffee shops", "Parks", "Vet appointments"). Lives in a
 *  parallel `savedLists` subcollection. Only applies to `custom`
 *  category items — Home/Work/Favorite stay flat, since collapsing
 *  those into lists would hurt the quick-tap chips. */
export interface SavedList {
  id: string;
  name: string;
  createdAt: string;
  /** Optional accent color (hex) shown on the list header / list-tinted
   *  map markers. Falls back to a deterministic color from the list id. */
  color?: string | null;
}

export interface SavedDestination {
  id: string;
  name: string;
  lat: number;
  lng: number;
  category: SavedCategory;
  /** When category === "custom", optionally pinned to a SavedList.
   *  null/undefined means "uncategorized custom". */
  listId?: string | null;
  createdAt: string;
}

export function useSavedDestinations() {
  const { user } = useAuth();
  const [destinations, setDestinations] = useState<SavedDestination[]>([]);
  const [lists, setLists] = useState<SavedList[]>([]);
  const [loading, setLoading] = useState(true);

  const canSave = isFirebaseConfigured() && !!user && !user.isAnonymous;

  useEffect(() => {
    if (!canSave) {
      setDestinations([]);
      setLists([]);
      setLoading(false);
      return;
    }

    const db = getFirestore(getFirebaseApp());
    const destCol = collection(db, "users", user!.uid, "savedDestinations");
    const destQ = query(destCol, orderBy("createdAt", "desc"));
    const listsCol = collection(db, "users", user!.uid, "savedLists");
    const listsQ = query(listsCol, orderBy("createdAt", "asc"));

    const unsubDest = onSnapshot(
      destQ,
      (snap) => {
        const list: SavedDestination[] = [];
        snap.forEach((d) => {
          const data = d.data();
          const cat = String(data.category ?? "custom") as SavedCategory;
          list.push({
            id: d.id,
            name: String(data.name ?? ""),
            lat: Number(data.lat ?? 0),
            lng: Number(data.lng ?? 0),
            category: (["home", "work", "favorite", "custom"] as const).includes(cat) ? cat : "custom",
            listId: data.listId ? String(data.listId) : null,
            createdAt: data.createdAt?.toDate?.()?.toISOString?.() ?? "",
          });
        });
        setDestinations(list);
        setLoading(false);
      },
      () => setLoading(false)
    );

    const unsubLists = onSnapshot(
      listsQ,
      (snap) => {
        const arr: SavedList[] = [];
        snap.forEach((d) => {
          const data = d.data();
          arr.push({
            id: d.id,
            name: String(data.name ?? ""),
            color: data.color ? String(data.color) : null,
            createdAt: data.createdAt?.toDate?.()?.toISOString?.() ?? "",
          });
        });
        setLists(arr);
      },
      () => { /* non-fatal — lists feature degrades silently */ }
    );

    return () => { unsubDest(); unsubLists(); };
  }, [canSave, user]);

  const addDestination = useCallback(
    async (
      name: string,
      lat: number,
      lng: number,
      category: SavedCategory = "custom",
      listId: string | null = null,
    ) => {
      if (!canSave) return;
      const db = getFirestore(getFirebaseApp());
      const col = collection(db, "users", user!.uid, "savedDestinations");

      // home / work are singletons — replace the existing one.
      if (category === "home" || category === "work") {
        const existing = destinations.filter((d) => d.category === category);
        await Promise.all(
          existing.map((d) => deleteDoc(doc(db, "users", user!.uid, "savedDestinations", d.id)))
        );
      }
      await addDoc(col, {
        name,
        lat,
        lng,
        category,
        listId: category === "custom" ? listId : null,
        createdAt: serverTimestamp(),
      });
    },
    [canSave, user, destinations]
  );

  const removeDestination = useCallback(
    async (destId: string) => {
      if (!canSave) return;
      const db = getFirestore(getFirebaseApp());
      await deleteDoc(doc(db, "users", user!.uid, "savedDestinations", destId));
    },
    [canSave, user]
  );

  const setCategory = useCallback(
    async (destId: string, category: SavedCategory) => {
      if (!canSave) return;
      const db = getFirestore(getFirebaseApp());
      // Moving out of "custom" wipes the listId — Home/Work/Favorite
      // are flat, no membership.
      const patch: Record<string, unknown> = { category };
      if (category !== "custom") patch.listId = null;
      await updateDoc(doc(db, "users", user!.uid, "savedDestinations", destId), patch);
    },
    [canSave, user]
  );

  /** Reassign a destination to a different list (or null = uncategorized).
   *  Auto-promotes the destination to "custom" so list-membership is
   *  always meaningful — Home/Work pins can't sit inside user lists. */
  const setDestinationList = useCallback(
    async (destId: string, listId: string | null) => {
      if (!canSave) return;
      const db = getFirestore(getFirebaseApp());
      await updateDoc(doc(db, "users", user!.uid, "savedDestinations", destId), {
        category: "custom",
        listId,
      });
    },
    [canSave, user]
  );

  const createList = useCallback(
    async (name: string, color?: string): Promise<string | null> => {
      if (!canSave) return null;
      const trimmed = name.trim().slice(0, 60);
      if (!trimmed) return null;
      const db = getFirestore(getFirebaseApp());
      const ref = await addDoc(collection(db, "users", user!.uid, "savedLists"), {
        name: trimmed,
        color: color ?? null,
        createdAt: serverTimestamp(),
      });
      return ref.id;
    },
    [canSave, user]
  );

  const renameList = useCallback(
    async (listId: string, name: string) => {
      if (!canSave) return;
      const trimmed = name.trim().slice(0, 60);
      if (!trimmed) return;
      const db = getFirestore(getFirebaseApp());
      await updateDoc(doc(db, "users", user!.uid, "savedLists", listId), { name: trimmed });
    },
    [canSave, user]
  );

  /** Delete a list. Member destinations aren't deleted — they're
   *  released back to "uncategorized custom" so the user doesn't lose
   *  saved spots from a typo'd list deletion. */
  const deleteList = useCallback(
    async (listId: string) => {
      if (!canSave) return;
      const db = getFirestore(getFirebaseApp());
      const members = destinations.filter((d) => d.listId === listId);
      const batch = writeBatch(db);
      for (const d of members) {
        batch.update(doc(db, "users", user!.uid, "savedDestinations", d.id), { listId: null });
      }
      batch.delete(doc(db, "users", user!.uid, "savedLists", listId));
      await batch.commit();
    },
    [canSave, user, destinations]
  );

  return {
    destinations,
    lists,
    loading,
    canSave,
    addDestination,
    removeDestination,
    setCategory,
    setDestinationList,
    createList,
    renameList,
    deleteList,
  };
}
