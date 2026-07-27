"use client";

import Link from "next/link";
import SharedListPreview from "@/components/SharedListPreview";
import { useShareFragment } from "@/hooks/useShareFragment";
import { decodeListToken } from "@/lib/share-list";

export default function SharedListFragmentPage({ brand }: { brand: string }) {
  const token = useShareFragment("t", 32_000);
  const decoded = token.status === "ready"
    ? decodeListToken(token.value)
    : null;

  if (token.status === "loading") {
    return (
      <main className="min-h-screen flex items-center justify-center bg-slate-950 text-slate-100 p-6">
        <p className="text-sm text-slate-400">Opening shared list…</p>
      </main>
    );
  }

  if (!decoded) {
    return (
      <main className="min-h-screen flex items-center justify-center bg-slate-950 text-slate-100 p-6">
        <div className="max-w-md text-center">
          <p className="text-xs uppercase tracking-widest text-slate-500">{brand}</p>
          <h1 className="text-2xl font-bold mt-2">This share link is invalid</h1>
          <p className="text-sm text-slate-400 mt-3">
            The link may be incomplete, corrupted, or from a newer version of the app.
            Ask the sender for a fresh link.
          </p>
          <Link href="/" className="inline-block mt-6 px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-semibold">
            Open {brand}
          </Link>
        </div>
      </main>
    );
  }

  return <SharedListPreview snapshot={decoded} brand={brand} />;
}
