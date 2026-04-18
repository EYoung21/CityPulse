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

export interface SavedDestination {
  id: string;
  name: string;
  lat: number;
  lng: number;
  category: SavedCategory;
  createdAt: string;
}

export function useSavedDestinations() {
  const { user } = useAuth();
  const [destinations, setDestinations] = useState<SavedDestination[]>([]);
  const [loading, setLoading] = useState(true);

  const canSave = isFirebaseConfigured() && !!user && !user.isAnonymous;

  useEffect(() => {
    if (!canSave) {
      setDestinations([]);
      setLoading(false);
      return;
    }

    const db = getFirestore(getFirebaseApp());
    const col = collection(db, "users", user!.uid, "savedDestinations");
    const q = query(col, orderBy("createdAt", "desc"));

    const unsub = onSnapshot(
      q,
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
            createdAt: data.createdAt?.toDate?.()?.toISOString?.() ?? "",
          });
        });
        setDestinations(list);
        setLoading(false);
      },
      () => setLoading(false)
    );

    return () => unsub();
  }, [canSave, user]);

  const addDestination = useCallback(
    async (name: string, lat: number, lng: number, category: SavedCategory = "custom") => {
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
      await addDoc(col, { name, lat, lng, category, createdAt: serverTimestamp() });
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
      await updateDoc(doc(db, "users", user!.uid, "savedDestinations", destId), { category });
    },
    [canSave, user]
  );

  return { destinations, loading, canSave, addDestination, removeDestination, setCategory };
}
