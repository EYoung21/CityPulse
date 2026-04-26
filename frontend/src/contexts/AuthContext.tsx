"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  GoogleAuthProvider,
  createUserWithEmailAndPassword,
  deleteUser,
  getAuth,
  getRedirectResult,
  onAuthStateChanged,
  reauthenticateWithPopup,
  sendEmailVerification,
  signInAnonymously,
  signInWithCustomToken as fbSignInWithCustomToken,
  signInWithEmailAndPassword,
  signInWithRedirect,
  signOut,
  updateProfile,
  type User,
} from "firebase/auth";
import { Timestamp, collection, deleteDoc, doc, getDocs, getFirestore, onSnapshot, serverTimestamp, setDoc, writeBatch } from "firebase/firestore";
import { getFirebaseApp, isFirebaseConfigured } from "@/lib/firebase";

const ADMIN_EMAILS = ["eliyoung4now@gmail.com", "kethansany@gmail.com", "rickywhy@gmail.com"];

export type UserTier = "free" | "pro" | "enterprise";

type AuthState = {
  user: User | null;
  loading: boolean;
  isAdmin: boolean;
  tier: UserTier;
  isPro: boolean;
  signInWithGoogle: () => Promise<void>;
  signUpWithEmail: (email: string, password: string) => Promise<void>;
  signInWithEmail: (email: string, password: string) => Promise<void>;
  resendVerification: () => Promise<void>;
  signOutUser: () => Promise<void>;
  continueAsGuest: () => Promise<void>;
  /** Update the current user's Firebase Auth display name and mirror
   *  it to the users/{uid} profile doc. No-op if not signed in or
   *  signed in anonymously. */
  updateDisplayName: (name: string) => Promise<void>;
  /** Permanently delete the current user's account. Wipes their
   *  user-owned Firestore subcollections (best-effort) before calling
   *  Firebase Auth's deleteUser. Returns "requires-reauth" when the
   *  user needs to re-authenticate before the deletion can complete. */
  deleteAccount: () => Promise<"deleted" | "requires-reauth" | "cancelled">;
};

const AuthContext = createContext<AuthState | null>(null);

const noop = async () => {};

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [tier, setTier] = useState<UserTier>("free");
  // proUntil mirrors users/{uid}.proUntil from Firestore. It's set
  // by the Stripe webhook when a finite-duration pass (currently
  // just the 3-day pass) is purchased. Independent of `tier` so a
  // user can hold both a subscription AND a pass without one
  // stomping the other on cancel/refund. Resolved into isPro via
  // an OR below.
  const [proUntil, setProUntil] = useState<Date | null>(null);
  // Tick state purely so we can re-render on pass expiry without
  // requiring a Firestore write. Bumped by a setTimeout scheduled
  // to fire at the exact `proUntil` moment whenever it changes.
  const [, setExpiryTick] = useState(0);

  // Cross-domain auth: if we arrived with a __pulse_token param, exchange it
  useEffect(() => {
    if (!isFirebaseConfigured()) return;
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const idToken = params.get("__pulse_token");
    if (!idToken) return;

    // Remove token from URL immediately
    params.delete("__pulse_token");
    const clean = params.toString();
    const newUrl = window.location.pathname + (clean ? `?${clean}` : "") + window.location.hash;
    window.history.replaceState({}, "", newUrl);

    (async () => {
      try {
        const res = await fetch("/api/auth/exchange", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ idToken }),
        });
        if (!res.ok) return;
        const { customToken } = await res.json();
        const auth = getAuth(getFirebaseApp());
        await fbSignInWithCustomToken(auth, customToken);
      } catch (e) {
        console.warn("Cross-domain auth failed:", e);
      }
    })();
  }, []);

  useEffect(() => {
    if (!isFirebaseConfigured()) {
      setLoading(false);
      return;
    }
    const auth = getAuth(getFirebaseApp());

    // Holds the Firestore subscription for the currently-signed-in
    // user. We tear it down on every auth state change to avoid
    // leaking a listener after sign-out and to avoid a stale doc
    // shadowing the new user's data on account switching.
    let userDocUnsub: (() => void) | null = null;
    let authUnsub: (() => void) | null = null;
    let cancelled = false;

    // Finish Google (OAuth) sign-in when returning from `signInWithRedirect`.
    // Runs once per load; no pending redirect is a normal outcome.
    void getRedirectResult(auth)
      .catch((e) => {
        console.warn("getRedirectResult:", e);
      })
      .finally(() => {
        if (cancelled) return;
        authUnsub = onAuthStateChanged(auth, (u) => {
          setUser(u);

          // Always clean up any previous user-doc listener before we
          // either subscribe to the new one or settle into the
          // signed-out state. Otherwise an account switch (sign out →
          // sign in as someone else) leaks the previous listener and
          // briefly flashes the previous user's tier.
          if (userDocUnsub) {
            userDocUnsub();
            userDocUnsub = null;
          }

          if (u && u.email) {
            const db = getFirestore(getFirebaseApp());
            // Real-time listener so a Stripe webhook write — either
            // tier:'pro' on subscription or proUntil on a 3-day pass —
            // reflects in the UI within a second of the webhook firing,
            // with no page reload required.
            userDocUnsub = onSnapshot(
              doc(db, "users", u.uid),
              (snap) => {
                const data = snap.data();
                if (data?.tier && ["free", "pro", "enterprise"].includes(data.tier)) {
                  setTier(data.tier as UserTier);
                } else {
                  setTier("free");
                }
                // Firestore Timestamps round-trip as objects with .toDate;
                // be defensive about the field being missing or wrong-typed
                // (e.g. left over from a manual Firestore edit during
                // testing) so a malformed doc doesn't crash the provider.
                const raw = data?.proUntil as Timestamp | undefined;
                const next = raw && typeof raw.toDate === "function" ? raw.toDate() : null;
                setProUntil(next);
              },
              () => {
                // Read denied or transient — fall back to free rather
                // than gambling on a stale grant.
                setTier("free");
                setProUntil(null);
              }
            );
            // Do not gate the whole app on the first `users/{uid}` snapshot.
            // Waiting here delayed map mount + `/api/*` loads until Firestore
            // connected (felt like "slow login"). Tier defaults to `free` until
            // the snapshot updates it.
            setLoading(false);
            // Warm the ID token so the first parallel REST calls after mount
            // avoid contending on the same refresh.
            if (!u.isAnonymous) void u.getIdToken().catch(() => {});
          } else {
            setTier("free");
            setProUntil(null);
            setLoading(false);
          }
        });
      });

    return () => {
      cancelled = true;
      authUnsub?.();
      if (userDocUnsub) userDocUnsub();
    };
  }, []);

  // Schedule a tick at the exact moment a pass expires so the UI
  // re-locks Pro features without waiting for the next Firestore
  // write or a page reload. We don't actually need to write
  // anything — the isPro derivation below re-reads `new Date()` on
  // every render, so a single state bump is enough to trigger the
  // re-evaluation. We cap the timeout at ~24 days (max safe
  // setTimeout delay is ~24.8 days; longer values fire immediately).
  // For passes longer than that we'd need a recurring scheduler,
  // but the 3-day pass is well inside the safe range.
  useEffect(() => {
    if (!proUntil) return;
    const ms = proUntil.getTime() - Date.now();
    if (ms <= 0) return;
    const safe = Math.min(ms, 24 * 24 * 60 * 60 * 1000);
    const handle = window.setTimeout(() => {
      setExpiryTick((n) => n + 1);
    }, safe);
    return () => window.clearTimeout(handle);
  }, [proUntil]);

  // Mirror tier to localStorage so non-React libs (alerts-inbox prune,
  // saved-place limit, etc.) can read it synchronously without prop
  // drilling through hooks. Also dispatch an event so listeners can
  // react to upgrades/downgrades within a single tab session.
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem("pp:tier", tier);
    } catch {
      /* storage blocked — non-fatal */
    }
    window.dispatchEvent(new CustomEvent("pp:tier-changed", { detail: { tier } }));
  }, [tier]);

  useEffect(() => {
    if (!isFirebaseConfigured() || !user || user.isAnonymous) return;
    if (!user.email) return;
    const db = getFirestore(getFirebaseApp());
    void setDoc(
      doc(db, "users", user.uid),
      {
        email: user.email,
        displayName: user.displayName,
        photoURL: user.photoURL,
        updatedAt: serverTimestamp(),
      },
      { merge: true }
    ).catch((e) => console.warn("User profile sync:", e));
  }, [user]);

  const signInWithGoogle = useCallback(async () => {
    const auth = getAuth(getFirebaseApp());
    const provider = new GoogleAuthProvider();
    // Redirect avoids popup/opener COOP issues on some browsers and hosts
    // (Chrome logging `window.closed` / `window.close` blocked under strict COOP).
    await signInWithRedirect(auth, provider);
  }, []);

  const signUpWithEmail = useCallback(async (email: string, password: string) => {
    const auth = getAuth(getFirebaseApp());
    const cred = await createUserWithEmailAndPassword(auth, email, password);
    await sendEmailVerification(cred.user);
  }, []);

  const signInWithEmail = useCallback(async (email: string, password: string) => {
    const auth = getAuth(getFirebaseApp());
    await signInWithEmailAndPassword(auth, email, password);
  }, []);

  const resendVerification = useCallback(async () => {
    const auth = getAuth(getFirebaseApp());
    if (auth.currentUser && !auth.currentUser.emailVerified) {
      await sendEmailVerification(auth.currentUser);
    }
  }, []);

  const signOutUser = useCallback(async () => {
    const auth = getAuth(getFirebaseApp());
    await signOut(auth);
  }, []);

  const continueAsGuest = useCallback(async () => {
    const auth = getAuth(getFirebaseApp());
    await signInAnonymously(auth);
  }, []);

  const updateDisplayName = useCallback(async (name: string) => {
    const auth = getAuth(getFirebaseApp());
    const u = auth.currentUser;
    if (!u || u.isAnonymous) return;
    const trimmed = name.trim().slice(0, 60);
    if (!trimmed) return;
    await updateProfile(u, { displayName: trimmed });
    // Mirror to the users/{uid} profile doc so other surfaces (live-
    // share recipient view, account export) see the new name without
    // waiting for the next sign-in. The merge:true makes this safe
    // even if the doc doesn't exist yet.
    try {
      const db = getFirestore(getFirebaseApp());
      await setDoc(
        doc(db, "users", u.uid),
        { displayName: trimmed, updatedAt: serverTimestamp() },
        { merge: true }
      );
    } catch { /* non-fatal — the auth profile update is the source of truth */ }
    // Force a re-render so consumers (AuthBar, etc) see the new
    // displayName immediately. setUser triggers state churn.
    setUser({ ...u } as User);
  }, []);

  const deleteAccount = useCallback(async (): Promise<"deleted" | "requires-reauth" | "cancelled"> => {
    const auth = getAuth(getFirebaseApp());
    const u = auth.currentUser;
    if (!u) return "cancelled";

    // Best-effort wipe of user-owned Firestore data before account
    // deletion. We deliberately don't fail the auth-deletion if a
    // subcollection cleanup hits an error — the security rules will
    // make orphaned data inaccessible to anyone else regardless.
    const wipeUserData = async () => {
      try {
        const db = getFirestore(getFirebaseApp());
        // Wipe known per-user subcollections in batches of 400 (well
        // under Firestore's 500-write batch cap).
        for (const sub of ["savedDestinations", "savedLists", "userPrefs", "tripHistory"]) {
          try {
            const col = collection(db, "users", u.uid, sub);
            const snap = await getDocs(col);
            let batch = writeBatch(db);
            let count = 0;
            for (const d of snap.docs) {
              batch.delete(d.ref);
              count++;
              if (count >= 400) {
                await batch.commit();
                batch = writeBatch(db);
                count = 0;
              }
            }
            if (count > 0) await batch.commit();
          } catch { /* sub-collection missing or rules blocked — skip */ }
        }
        try { await deleteDoc(doc(db, "users", u.uid)); } catch { /* ignore */ }
      } catch { /* whole wipe blocked — proceed to auth deletion */ }
    };

    const tryDelete = async () => {
      await wipeUserData();
      await deleteUser(u);
    };

    try {
      await tryDelete();
      return "deleted";
    } catch (e) {
      // Firebase requires a recent sign-in for account deletion. If
      // that's why we failed and the user has a Google provider, try
      // a reauth popup once and retry.
      const code = (e as { code?: string }).code;
      if (code === "auth/requires-recent-login") {
        const googleProvider = u.providerData.find((p) => p.providerId === "google.com");
        if (!googleProvider) return "requires-reauth";
        try {
          await reauthenticateWithPopup(u, new GoogleAuthProvider());
          await tryDelete();
          return "deleted";
        } catch (reauthErr) {
          // popup-closed-by-user → user backed out
          const rcode = (reauthErr as { code?: string }).code;
          if (rcode === "auth/popup-closed-by-user" || rcode === "auth/cancelled-popup-request") {
            return "cancelled";
          }
          return "requires-reauth";
        }
      }
      throw e;
    }
  }, []);

  const isAdmin = !!user?.email && ADMIN_EMAILS.includes(user.email.toLowerCase());
  // A user is Pro if any of three are true: their persistent tier is
  // a paid one, they're a hard-coded admin, or they hold an unexpired
  // finite-duration pass. The pass check is `>` so a proUntil exactly
  // equal to "right now" reads as expired (matches the webhook's
  // intent of granting full hours and not a tick more).
  const isPro =
    tier === "pro" ||
    tier === "enterprise" ||
    isAdmin ||
    (!!proUntil && proUntil.getTime() > Date.now());

  const value = useMemo(
    () => ({
      user,
      loading,
      isAdmin,
      tier,
      isPro,
      signInWithGoogle,
      signUpWithEmail,
      signInWithEmail,
      resendVerification,
      signOutUser,
      continueAsGuest,
      updateDisplayName,
      deleteAccount,
    }),
    [user, loading, isAdmin, tier, isPro, signInWithGoogle, signUpWithEmail, signInWithEmail, resendVerification, signOutUser, continueAsGuest, updateDisplayName, deleteAccount]
  );

  if (!isFirebaseConfigured()) {
    return (
      <AuthContext.Provider
        value={{
          user: null,
          loading: false,
          isAdmin: false,
          tier: "free",
          isPro: false,
          signInWithGoogle: noop,
          signUpWithEmail: noop,
          signInWithEmail: noop,
          resendVerification: noop,
          signOutUser: noop,
          continueAsGuest: noop,
          updateDisplayName: noop,
          deleteAccount: async () => "cancelled" as const,
        }}
      >
        {children}
      </AuthContext.Provider>
    );
  }

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth must be used within AuthProvider");
  }
  return ctx;
}
