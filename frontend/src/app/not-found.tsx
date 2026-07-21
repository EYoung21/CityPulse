import Link from "next/link";

export default function NotFound() {
  return (
    <main className="min-h-dvh flex items-center justify-center bg-slate-950 px-6 text-slate-100">
      <div className="max-w-md text-center">
        <p className="text-xs uppercase tracking-[0.25em] text-slate-500">CityPulse</p>
        <h1 className="mt-2 text-3xl font-bold">Page not found</h1>
        <p className="mt-3 text-sm leading-relaxed text-slate-400">
          This link may be outdated or incomplete. Return to the live map to keep exploring.
        </p>
        <Link
          href="/?view=map"
          className="mt-6 inline-flex rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-500"
        >
          Open CityPulse map
        </Link>
      </div>
    </main>
  );
}
