import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const TOMTOM_KEY = process.env.TOMTOM_API_KEY || "";
const TOMTOM_TRAFFIC_TILE = "https://api.tomtom.com/traffic/map/4/tile";

type Params = Promise<{
  kind: string;
  z: string;
  x: string;
  y: string;
}>;

function tileNumber(value: string, max: number): number | null {
  const n = Number(value.replace(/\.png$/i, ""));
  if (!Number.isInteger(n) || n < 0 || n > max) return null;
  return n;
}

export async function GET(_request: Request, context: { params: Params }) {
  if (!TOMTOM_KEY) {
    return new Response(null, { status: 204 });
  }

  const { kind, z, x, y } = await context.params;
  const zoom = tileNumber(z, 22);
  if (zoom == null) {
    return NextResponse.json({ error: "invalid z" }, { status: 400 });
  }
  const maxTile = 2 ** zoom - 1;
  const tileX = tileNumber(x, maxTile);
  const tileY = tileNumber(y, maxTile);
  if (tileX == null || tileY == null) {
    return NextResponse.json({ error: "invalid tile" }, { status: 400 });
  }

  const path =
    kind === "flow"
      ? `flow/relative0/${zoom}/${tileX}/${tileY}.png`
      : kind === "incidents"
        ? `incidents/s3/${zoom}/${tileX}/${tileY}.png`
        : "";
  if (!path) {
    return NextResponse.json({ error: "invalid traffic layer" }, { status: 400 });
  }

  const url = `${TOMTOM_TRAFFIC_TILE}/${path}?key=${encodeURIComponent(TOMTOM_KEY)}`;
  try {
    const upstream = await fetch(url, {
      next: { revalidate: 60 },
      headers: { Accept: "image/png" },
    });
    if (!upstream.ok) {
      return new Response(null, { status: upstream.status === 404 ? 404 : 502 });
    }
    const body = await upstream.arrayBuffer();
    return new Response(body, {
      headers: {
        "Content-Type": upstream.headers.get("content-type") || "image/png",
        "Cache-Control": "public, max-age=60, stale-while-revalidate=120",
      },
    });
  } catch {
    return new Response(null, { status: 502 });
  }
}
