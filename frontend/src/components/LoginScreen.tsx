"use client";

import { useState } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { useAuth } from "@/contexts/AuthContext";
import { Mail, Eye, EyeOff, AlertCircle, CheckCircle2 } from "lucide-react";
import {
  citySiteName,
  getCurrentCity,
  getLaunchedCities,
} from "@/lib/pulse-cities";
import "./login.css";

type Mode = "login" | "signup";

export default function LoginScreen() {
  const {
    user,
    signInWithGoogle,
    signUpWithEmail,
    signInWithEmail,
    resendVerification,
    continueAsGuest,
    lastAuthError,
  } = useAuth();

  const router = useRouter();
  const [mode, setMode] = useState<Mode>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [verificationSent, setVerificationSent] = useState(false);

  const city = getCurrentCity();
  const siteName = citySiteName(city);
  const cityName = city.name;
  const accentRgb = city.accentRgb ?? "171, 255, 2";
  const accentRgb2 = city.accentRgb2 ?? "224, 255, 160";

  const needsVerification = user && !user.isAnonymous && user.email && !user.emailVerified;

  if (needsVerification) {
    return (
      <div
        className="lp-login-page"
        style={
          {
            "--accent-rgb": accentRgb,
            "--accent2-rgb": accentRgb2,
          } as React.CSSProperties
        }
      >
        <div className="lp-login-bg" />
        <div className="lp-login-shell">
          <div className="lp-login-card relative">
            <div className="lp-login-card-inner">
              <div className="text-center space-y-2">
                <div className="flex justify-center">
                  <Mail className="w-12 h-12" style={{ color: `rgb(${accentRgb})` }} />
                </div>
                <h1 className="text-xl font-bold text-white">Check your email</h1>
                <p className="text-sm" style={{ color: "rgba(255,255,255,0.55)" }}>
                  We sent a verification link to <strong>{user.email}</strong>. Click it to activate your account.
                </p>
              </div>
              <div className="space-y-3 mt-5">
                <button type="button"
                  onClick={async () => {
                    try {
                      await resendVerification();
                      setVerificationSent(true);
                    } catch {
                      setError("Failed to resend.");
                    }
                  }}
                  className="lp-login-btn lp-login-btnGhost"
                >
                  Resend verification email
                </button>
                {verificationSent && (
                  <div className="flex items-center gap-2 text-xs text-green-500">
                    <CheckCircle2 className="w-3.5 h-3.5" />
                    Verification email sent!
                  </div>
                )}
                <button type="button"
                  onClick={() => window.location.reload()}
                  className="lp-login-btn"
                  style={{ color: `rgb(${accentRgb})` }}
                >
                  After you verify, reload
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const handleEmailSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      if (mode === "signup") {
        await signUpWithEmail(email, password);
      } else {
        await signInWithEmail(email, password);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Something went wrong";
      if (msg.includes("email-already-in-use")) setError("An account with this email already exists.");
      else if (msg.includes("wrong-password") || msg.includes("invalid-credential")) setError("Invalid email or password.");
      else if (msg.includes("user-not-found")) setError("No account found with this email.");
      else if (msg.includes("weak-password")) setError("Password must be at least 6 characters.");
      else if (msg.includes("invalid-email")) setError("Please enter a valid email address.");
      else if (msg.includes("too-many-requests")) setError("Too many attempts. Try again later.");
      else setError(msg);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="lp-login-page"
      style={
        {
          "--accent-rgb": accentRgb,
          "--accent2-rgb": accentRgb2,
        } as React.CSSProperties
      }
    >
      <div className="lp-login-bg" />
      <main className="lp-login-shell">
        <div className="lp-login-card relative">
          <div className="lp-login-card-inner">
            <div className="lp-login-brand">
              <Image src="/logo.png" alt="" width={48} height={48} className="w-12 h-12" />
              <h1 className="lp-login-wordmark m-0">CityPulse</h1>
            </div>
            <div className="lp-login-subhead">
              {siteName} &middot; {cityName}
            </div>

        {/* Google sign-in */}
        <button type="button"
          onClick={async () => {
            setError("");
            try {
              await signInWithGoogle();
            } catch {
              // Detailed message is in lastAuthError from AuthContext
            }
          }}
          className="lp-login-btn lp-login-btnGhost flex items-center justify-center gap-3"
        >
          <svg viewBox="0 0 24 24" width="18" height="18">
            <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4" />
            <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
            <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05" />
            <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
          </svg>
          Continue with Google
        </button>

        {lastAuthError && (
          <div role="alert" className="flex items-start gap-2 text-xs text-red-400 -mt-1">
            <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            {lastAuthError}
          </div>
        )}

        <button
          type="button"
          onClick={async () => {
            setError("");
            setBusy(true);
            try {
              await continueAsGuest();
              // Anonymous guests are no longer auto-bounced off /login
              // (they may be here to upgrade), so send this fresh guest
              // into the app explicitly.
              router.push("/");
            } catch (err: unknown) {
              const msg = err instanceof Error ? err.message : "Guest sign-in failed.";
              setError(msg.includes("operation-not-allowed")
                ? "Guest sign-in is disabled in Firebase. Enable Anonymous under Authentication → Sign-in method."
                : "Could not continue as guest. Try again.");
            } finally {
              setBusy(false);
            }
          }}
          disabled={busy}
          className="lp-login-btn lp-login-btnGhost disabled:opacity-50"
          style={{ color: "rgba(255,255,255,0.7)" }}
        >
          Continue as guest
        </button>

        {/* Divider */}
        <div className="lp-login-divider">
          <div />
          <span>or</span>
          <div />
        </div>

        {/* Email form */}
        <form onSubmit={handleEmailSubmit} className="space-y-3">
          <div>
            <label htmlFor="login-email" className="sr-only">Email address</label>
            <input
              id="login-email"
              type="email"
              name="email"
              autoComplete="email"
              placeholder="Email address"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              className="lp-login-input"
            />
          </div>
          <div className="relative">
            <label htmlFor="login-password" className="sr-only">Password</label>
            <input
              id="login-password"
              type={showPassword ? "text" : "password"}
              name="password"
              autoComplete={mode === "signup" ? "new-password" : "current-password"}
              placeholder="Password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={6}
              className="lp-login-input pr-10"
            />
            <button
              type="button"
              onClick={() => setShowPassword(!showPassword)}
              aria-label={showPassword ? "Hide password" : "Show password"}
              aria-pressed={showPassword}
              className="absolute right-3 top-1/2 -translate-y-1/2 opacity-40 hover:opacity-70 transition-opacity"
              style={{ color: "white" }}
            >
              {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            </button>
          </div>

          {error && (
            <div role="alert" className="flex items-start gap-2 text-xs text-red-400">
              <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={busy}
            className="lp-login-btn lp-login-btnPrimary disabled:opacity-50"
          >
            {busy ? "…" : mode === "signup" ? "Create account" : "Sign in"}
          </button>
        </form>

        {/* Toggle login/signup */}
        <p className="lp-login-foot">
          {mode === "login" ? (
            <>
              Don&apos;t have an account?{" "}
              <button type="button"
                onClick={() => { setMode("signup"); setError(""); }}
                className="lp-login-link hover:underline"
              >
                Sign up
              </button>
            </>
          ) : (
            <>
              Already have an account?{" "}
              <button type="button"
                onClick={() => { setMode("login"); setError(""); }}
                className="lp-login-link hover:underline"
              >
                Sign in
              </button>
            </>
          )}
        </p>

        <div className="lp-login-citynav">
          <CityNav />
        </div>
          </div>
        </div>
      </main>
    </div>
  );
}

function CityNav() {
  const current = getCurrentCity();
  const others = getLaunchedCities().filter((c) => c.slug !== current.slug);

  return (
    <div className="w-full max-w-sm mt-6">
      <p
        className="text-center text-[10px] uppercase tracking-widest mb-3"
        style={{ color: "rgba(255,255,255,0.3)" }}
      >
        Pulse Network
      </p>
      <div className="flex flex-wrap justify-center gap-2">
        {others.map((city) => (
          <a
            key={city.slug}
            href={`https://${city.domain}`}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs transition-all hover:brightness-125"
            style={{
              background: "rgba(255,255,255,0.05)",
              border: "1px solid rgba(255,255,255,0.08)",
              color: "rgba(255,255,255,0.6)",
              textDecoration: "none",
            }}
          >
            <span>{city.emoji}</span>
            <span>{city.name}</span>
          </a>
        ))}
      </div>
    </div>
  );
}
