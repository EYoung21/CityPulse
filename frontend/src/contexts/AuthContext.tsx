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
  getAuth,
  onAuthStateChanged,
  sendEmailVerification,
  signInAnonymously,
  signInWithCustomToken as fbSignInWithCustomToken,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut,
  type User,
} from "firebase/auth";
import { doc, getDoc, getFirestore, serverTimestamp, setDoc } from "firebase/firestore";
import { getFirebaseApp, isFirebaseConfigured } from "@/lib/firebase";

const ADMIN_EMAILS = ["eliyoung4now@gmail.com", "kethansany@gmail.com"];

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
};

const AuthContext = createContext<AuthState | null>(null);

const noop = async () => {};

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [tier, setTier] = useState<UserTier>("free");

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
    const unsub = onAuthStateChanged(auth, async (u) => {
      setUser(u);
      if (u && u.email) {
        try {
          const db = getFirestore(getFirebaseApp());
          const snap = await getDoc(doc(db, "users", u.uid));
          const data = snap.data();
          if (data?.tier && ["free", "pro", "enterprise"].includes(data.tier)) {
            setTier(data.tier as UserTier);
          } else {
            setTier("free");
          }
        } catch {
          setTier("free");
        }
      } else {
        setTier("free");
      }
      setLoading(false);
    });
    return () => unsub();
  }, []);

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
    await signInWithPopup(auth, provider);
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

  const isAdmin = !!user?.email && ADMIN_EMAILS.includes(user.email.toLowerCase());
  const isPro = tier === "pro" || tier === "enterprise" || isAdmin;

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
    }),
    [user, loading, isAdmin, tier, isPro, signInWithGoogle, signUpWithEmail, signInWithEmail, resendVerification, signOutUser, continueAsGuest]
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
