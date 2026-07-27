"use client";

import Link from "next/link";
import LiveTripView from "@/components/LiveTripView";
import { useShareFragment } from "@/hooks/useShareFragment";
import { isLiveShareId } from "@/lib/live-share-validation";

export default function SharedLiveFragmentPage({ brand }: { brand: string }) {
  const share = useShareFragment("id", 64);

  if (share.status === "loading") {
    return (
      <main className="min-h-screen flex items-center justify-center bg-slate-950 text-slate-100 p-6">
        <p className="text-sm text-slate-400">Opening live share…</p>
      </main>
    );
  }

  if (share.status !== "ready" || !isLiveShareId(share.value)) {
    return (
      <main className="min-h-screen flex items-center justify-center bg-slate-950 text-slate-100 p-6">
        <div className="max-w-md text-center">
          <p className="text-xs uppercase tracking-widest text-slate-500">{brand}</p>
          <h1 className="text-2xl font-bold mt-2">Invalid live share</h1>
          <p className="text-sm text-slate-400 mt-3">
            This link is missing a valid share ID or has expired. Ask the sender for a fresh link.
          </p>
          <Link href="/" className="inline-block mt-6 px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-semibold">
            Open {brand}
          </Link>
        </div>
      </main>
    );
  }

  return <LiveTripView shareId={share.value} brand={brand} />;
}
