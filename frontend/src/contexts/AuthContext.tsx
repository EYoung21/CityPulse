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
  signInWithPopup,
  signInWithRedirect,
  signOut,
  updateProfile,
  type User,
} from "firebase/auth";
import { pulseTokenFromUrl, urlWithoutPulseToken } from "@/lib/pulse-auth-handoff";
import { clearAccountLocalData } from "@/lib/account-local-data";
import { Timestamp, collection, deleteDoc, doc, getDocs, getFirestore, onSnapshot, query, serverTimestamp, setDoc, where, writeBatch } from "firebase/firestore";
import { getFirebaseApp, isFirebaseConfigured } from "@/lib/firebase";
import { readBoundedJsonResponse } from "@/lib/upstream-response";

const ADMIN_EMAILS = ["eliyoung4now@gmail.com", "kethansany@gmail.com", "rickywhy@gmail.com"];

function formatFirebaseAuthError(e: unknown): string {
  const code =
    typeof e === "object" && e !== null && "code" in e ? String((e as { code: string }).code) : "";
  switch (code) {
    case "auth/unauthorized-domain":
      return "This domain is not allowed for sign-in. In Firebase Console → Authentication → Settings, add it under Authorized domains (include your production host and any Vercel preview host you use).";
    case "auth/operation-not-allowed":
      return "Google sign-in is turned off. Enable the Google provider in Firebase Console → Authentication → Sign-in method.";
    case "auth/network-request-failed":
      return "Network error while signing in. Check your connection and try again.";
    case "auth/web-storage-unsupported":
      return "This browser blocks storage needed for sign-in. Try another browser or turn off strict tracking / private mode.";
    case "auth/redirect-cancelled-by-user":
      return "";
    default:
      return code ? `Sign-in error (${code}). Try again or use email.` : "Google sign-in failed. Try again.";
  }
}

export type UserTier = "free" | "pro" | "enterprise";

type AuthState = {
  user: User | null;
  loading: boolean;
  isAdmin: boolean;
  tier: UserTier;
  isPro: boolean;
  /** Set when Google redirect/popup fails; cleared on success or via clearLastAuthError. */
  lastAuthError: string | null;
  clearLastAuthError: () => void;
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
  const [loading, setLoading] = useState(isFirebaseConfigured);
  // True while a cross-domain __pulse_token handoff is being exchanged. Folded
  // into the exposed `loading` so the auth gate shows a spinner and waits for the
  // exchange instead of bouncing the arriving user to /landing first.
  const [crossDomainPending, setCrossDomainPending] = useState<boolean>(
    () =>
      isFirebaseConfigured() &&
      typeof window !== "undefined" &&
      pulseTokenFromUrl(new URL(window.location.href)) != null
  );
  const [tier, setTier] = useState<UserTier>("free");
  // proUntil mirrors users/{uid}.proUntil from Firestore. It's set
  // by the Stripe webhook when a finite-duration pass (currently
  // just the 3-day pass) is purchased. Independent of `tier` so a
  // user can hold both a subscription AND a pass without one
  // stomping the other on cancel/refund. Resolved into isPro via
  // an OR below.
  const [proUntil, setProUntil] = useState<Date | null>(null);
  // Captured clock state lets the render stay pure while a timeout still
  // re-evaluates access at the exact pass-expiry boundary.
  const [expiryNow, setExpiryNow] = useState(Date.now);
  const [lastAuthError, setLastAuthError] = useState<string | null>(null);

  const clearLastAuthError = useCallback(() => setLastAuthError(null), []);

  const isAdmin = useMemo(
    () => !!user?.email && ADMIN_EMAILS.includes(user.email.toLowerCase()),
    [user]
  );

  // Cross-domain auth: exchange the fragment handoff (or a legacy query
  // handoff from an older deployment) for a destination-project token.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const arrivalUrl = new URL(window.location.href);
    const idToken = pulseTokenFromUrl(arrivalUrl);
    if (!idToken) return;

    // Remove the one-shot credential immediately. Fragment handoffs never
    // reached the server; this also scrubs any legacy query-string token.
    window.history.replaceState({}, "", urlWithoutPulseToken(arrivalUrl));
    if (!isFirebaseConfigured()) return;

    // Safety net so a hung/failed exchange can't leave the gate spinning forever;
    // on success, onAuthStateChanged clears the pending state immediately.
    const controller = new AbortController();
    const safety = window.setTimeout(() => {
      controller.abort();
      setCrossDomainPending(false);
    }, 8000);
    (async () => {
      try {
        const res = await fetch("/api/auth/exchange", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ idToken }),
          signal: controller.signal,
        });
        if (!res.ok) {
          setCrossDomainPending(false);
          return;
        }
        const raw = await readBoundedJsonResponse(res, 64 * 1024);
        const customToken = raw && typeof raw === "object" && !Array.isArray(raw)
          ? (raw as Record<string, unknown>).customToken
          : null;
        if (typeof customToken !== "string" || !customToken || customToken.length > 8_192) {
          setCrossDomainPending(false);
          return;
        }
        const auth = getAuth(getFirebaseApp());
        await fbSignInWithCustomToken(auth, customToken);
      } catch (e) {
        console.warn("Cross-domain auth failed:", e);
        setCrossDomainPending(false);
      }
    })();
    return () => {
      window.clearTimeout(safety);
      controller.abort();
    };
  }, []);

  useEffect(() => {
    if (!isFirebaseConfigured()) return;
    const auth = getAuth(getFirebaseApp());

    // Holds the Firestore subscription for the currently-signed-in
    // user. We tear it down on every auth state change to avoid
    // leaking a listener after sign-out and to avoid a stale doc
    // shadowing the new user's data on account switching.
    let userDocUnsub: (() => void) | null = null;
    let authUnsub: (() => void) | null = null;
    let cancelled = false;
    const authSafety = window.setTimeout(() => {
      if (!cancelled) setLoading(false);
    }, 8000);

    const handleAuthState = (u: User | null) => {
      if (cancelled) return;
      window.clearTimeout(authSafety);
      if (u) setCrossDomainPending(false);
      setUser(u);
      if (u) setLastAuthError(null);

      // Always clean up any previous user-doc listener before we either
      // subscribe to the new one or settle into the signed-out state.
      if (userDocUnsub) {
        userDocUnsub();
        userDocUnsub = null;
      }

      if (u && u.email) {
        const db = getFirestore(getFirebaseApp());
        userDocUnsub = onSnapshot(
          doc(db, "users", u.uid),
          (snap) => {
            const data = snap.data();
            if (data?.tier && ["free", "pro", "enterprise"].includes(data.tier)) {
              setTier(data.tier as UserTier);
            } else {
              setTier("free");
            }
            const raw = data?.proUntil as Timestamp | undefined;
            const next = raw && typeof raw.toDate === "function" ? raw.toDate() : null;
            setProUntil(next);
          },
          () => {
            setTier("free");
            setProUntil(null);
          }
        );
        setLoading(false);
        if (!u.isAnonymous) void u.getIdToken().catch(() => {});
      } else {
        setTier("free");
        setProUntil(null);
        setLoading(false);
      }
    };

    // Finish Google (OAuth) sign-in when returning from `signInWithRedirect`.
    // Runs once per load; no pending redirect is a normal outcome. Register the
    // auth-state observer immediately instead of waiting for this network-backed
    // promise: redirect restoration can stall offline or behind privacy tooling,
    // and it must never strand the entire app on its loading gate.
    authUnsub = onAuthStateChanged(auth, handleAuthState);
    void getRedirectResult(auth)
      .catch((e) => {
        console.warn("getRedirectResult:", e);
        const msg = formatFirebaseAuthError(e);
        if (msg) setLastAuthError(msg);
      });

    return () => {
      cancelled = true;
      window.clearTimeout(authSafety);
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
      setExpiryNow(Date.now());
    }, safe);
    return () => window.clearTimeout(handle);
  }, [proUntil]);

  // Mirror tier to localStorage so non-React libs (alerts-inbox prune,
  // etc.) can read it synchronously without prop drilling. Admins are
  // always Pro in the UI/API — if their Firestore doc is still `free`,
  // mirror at least `pro` here so those libs match `isPro`.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const mirrored: UserTier = isAdmin && tier === "free" ? "pro" : tier;
    try {
      window.localStorage.setItem("pp:tier", mirrored);
    } catch {
      /* storage blocked — non-fatal */
    }
    window.dispatchEvent(new CustomEvent("pp:tier-changed", { detail: { tier: mirrored } }));
  }, [tier, isAdmin]);

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
    setLastAuthError(null);
    // Popup is more reliable than full-page redirect on Safari, iOS, and some
    // privacy modes. COOP is `same-origin-allow-popups` (middleware + next.config).
    try {
      await signInWithPopup(auth, provider);
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === "auth/popup-blocked") {
        await signInWithRedirect(auth, provider);
        return;
      }
      if (code === "auth/popup-closed-by-user" || code === "auth/cancelled-popup-request") {
        return;
      }
      setLastAuthError(formatFirebaseAuthError(e));
      throw e;
    }
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

    // Firebase account deletion requires a recent login. Check that before
    // touching any data; the old order wiped Firestore first, then left the
    // account alive and empty when the user cancelled reauthentication.
    const ensureRecentLogin = async (): Promise<"ready" | "requires-reauth" | "cancelled"> => {
      const token = await u.getIdTokenResult();
      const authTimeMs = Date.parse(token.authTime);
      // Firebase currently accepts a roughly five-minute-old login. Keep a
      // wide safety margin so cleanup cannot run across the server threshold.
      if (Number.isFinite(authTimeMs) && Date.now() - authTimeMs < 2 * 60_000) {
        return "ready";
      }

      const googleProvider = u.providerData.some((p) => p.providerId === "google.com");
      if (!googleProvider) return "requires-reauth";
      try {
        await reauthenticateWithPopup(u, new GoogleAuthProvider());
        return "ready";
      } catch (reauthErr) {
        const code = (reauthErr as { code?: string }).code;
        if (code === "auth/popup-closed-by-user" || code === "auth/cancelled-popup-request") {
          return "cancelled";
        }
        return "requires-reauth";
      }
    };

    const recentLogin = await ensureRecentLogin();
    if (recentLogin !== "ready") return recentLogin;

    // Best-effort wipe of user-owned Firestore data before account deletion.
    // A single collection failure does not prevent the remaining cleanup.
    const wipeUserData = async () => {
      try {
        const db = getFirestore(getFirebaseApp());
        const deleteDocs = async (docs: Array<{ ref: Parameters<ReturnType<typeof writeBatch>["delete"]>[0] }>) => {
          let batch = writeBatch(db);
          let count = 0;
          for (const item of docs) {
            batch.delete(item.ref);
            count += 1;
            if (count >= 400) {
              await batch.commit();
              batch = writeBatch(db);
              count = 0;
            }
          }
          if (count > 0) await batch.commit();
        };

        // Wipe known per-user subcollections in batches of 400 (well
        // under Firestore's 500-write batch cap).
        for (const sub of ["savedDestinations", "savedLists", "userPrefs", "tripHistory"]) {
          try {
            const col = collection(db, "users", u.uid, sub);
            const snap = await getDocs(col);
            await deleteDocs(snap.docs);
          } catch { /* sub-collection missing or rules blocked — skip */ }
        }

        // These records live in top-level collections rather than under the
        // user document. Each rule permits an owner-constrained query/delete.
        for (const [collectionName, ownerField] of [
          ["pushSubscriptions", "uid"],
          ["keywordWatches", "uid"],
          ["commuteSchedules", "uid"],
          ["liveTrips", "ownerUid"],
        ] as const) {
          try {
            const owned = query(
              collection(db, collectionName),
              where(ownerField, "==", u.uid)
            );
            const snap = await getDocs(owned);
            await deleteDocs(snap.docs);
          } catch { /* unavailable collection/index — continue cleanup */ }
        }
        try { await deleteDoc(doc(db, "users", u.uid)); } catch { /* ignore */ }
      } catch { /* whole wipe blocked — proceed to auth deletion */ }
    };

    try {
      await wipeUserData();
      await deleteUser(u);
      clearAccountLocalData();
      return "deleted";
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === "auth/requires-recent-login") return "requires-reauth";
      throw e;
    }
  }, []);

  // A user is Pro if any of three are true: their persistent tier is
  // a paid one, they're a hard-coded admin, or they hold an unexpired
  // finite-duration pass. The pass check is `>` so a proUntil exactly
  // equal to "right now" reads as expired (matches the webhook's
  // intent of granting full hours and not a tick more).
  const isPro =
    tier === "pro" ||
    tier === "enterprise" ||
    isAdmin ||
    (!!proUntil && proUntil.getTime() > expiryNow);

  const value = useMemo(
    () => ({
      user,
      loading: loading || crossDomainPending,
      isAdmin,
      tier,
      isPro,
      lastAuthError,
      clearLastAuthError,
      signInWithGoogle,
      signUpWithEmail,
      signInWithEmail,
      resendVerification,
      signOutUser,
      continueAsGuest,
      updateDisplayName,
      deleteAccount,
    }),
    [
      user,
      loading,
      crossDomainPending,
      isAdmin,
      tier,
      isPro,
      lastAuthError,
      clearLastAuthError,
      signInWithGoogle,
      signUpWithEmail,
      signInWithEmail,
      resendVerification,
      signOutUser,
      continueAsGuest,
      updateDisplayName,
      deleteAccount,
    ]
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
          lastAuthError: null,
          clearLastAuthError: () => {},
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
