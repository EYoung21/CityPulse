"use client";

import { useState } from "react";
import Link from "next/link";
import ShareRedirect from "@/components/ShareRedirect";
import { useShareFragment } from "@/hooks/useShareFragment";
import { decodeTripToken } from "@/lib/share-trip";

function fmtRemaining(ms: number): string {
  if (ms <= 0) return "arriving now";
  const totalMin = Math.ceil(ms / 60_000);
  if (totalMin < 60) return `~${totalMin} min`;
  const hours = Math.floor(totalMin / 60);
  const minutes = totalMin % 60;
  return minutes === 0 ? `~${hours}h` : `~${hours}h ${minutes}m`;
}

export default function SharedTripFragmentPage({ brand }: { brand: string }) {
  const [openedAt] = useState(Date.now);
  const token = useShareFragment("t", 64_000);
  const decoded = token.status === "ready"
    ? decodeTripToken(token.value)
    : null;

  if (token.status !== "loading" && !decoded) {
    return (
      <main className="min-h-screen flex items-center justify-center bg-slate-950 text-slate-100 p-6">
        <div className="max-w-md text-center">
          <p className="text-xs uppercase tracking-widest text-slate-500">{brand}</p>
          <h1 className="text-2xl font-bold mt-2">This trip link is invalid</h1>
          <p className="text-sm text-slate-400 mt-3">Ask the sender for a fresh link.</p>
          <Link href="/" className="inline-block mt-6 px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-semibold">
            Open {brand}
          </Link>
        </div>
      </main>
    );
  }

  const sender = decoded?.name?.trim() || "Someone";
  const appUrl = token.status === "ready"
    ? `/#${new URLSearchParams([["trip", token.value]]).toString()}`
    : "/";

  return (
    <main
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "#0a0a14",
        color: "#fff",
        fontFamily: "system-ui, -apple-system, sans-serif",
      }}
    >
      {decoded && <ShareRedirect appUrl={appUrl} />}
      <div style={{ textAlign: "center", padding: 24, maxWidth: 480 }}>
        <p style={{ fontSize: 14, color: "#94a3b8", letterSpacing: 2, textTransform: "uppercase", margin: 0 }}>
          {brand} · Shared trip
        </p>
        <h1 style={{ fontSize: 28, marginTop: 8, marginBottom: 0 }}>
          {decoded ? `${sender} is on the way` : "Opening shared trip…"}
        </h1>
        {decoded && (
          <p style={{ color: "#cbd5e1", marginTop: 8 }}>
            ETA {fmtRemaining(decoded.etaEpochMs - openedAt)}
          </p>
        )}
        <p style={{ color: "#94a3b8", marginTop: 16 }}>Opening the live map…</p>
        {decoded && (
          <p style={{ color: "#475569", marginTop: 24, fontSize: 12 }}>
            If you aren&apos;t redirected,{" "}
            <a href={appUrl} style={{ color: "#3b82f6" }}>tap here</a>.
          </p>
        )}
      </div>
    </main>
  );
}
