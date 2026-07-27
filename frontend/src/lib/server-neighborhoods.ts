import { readFile } from "node:fs/promises";
import path from "node:path";
import { normalizeMapRegions } from "@/lib/map-region-validation";
import type { Neighborhood } from "@/lib/neighborhoods";

const SUPPORTED_DATASETS = new Set(["philly", "sf", "nyc", "chattanooga"]);
const MAX_DATASET_BYTES = 2 * 1024 * 1024;
const datasetCache = new Map<string, Promise<Neighborhood[]>>();

async function readDataset(citySlug: string): Promise<Neighborhood[]> {
  if (!SUPPORTED_DATASETS.has(citySlug)) return [];

  const filePath = path.join(
    process.cwd(),
    "public",
    "neighborhoods",
    `${citySlug}.json`,
  );
  const raw = await readFile(filePath);
  if (raw.byteLength > MAX_DATASET_BYTES) {
    throw new Error(`Neighborhood dataset is too large: ${citySlug}`);
  }
  const parsed: unknown = JSON.parse(raw.toString("utf8"));
  return (normalizeMapRegions(parsed) as Neighborhood[] | null) ?? [];
}

export function serverNeighborhoods(citySlug: string): Promise<Neighborhood[]> {
  const normalized = citySlug.trim().toLowerCase();
  const cached = datasetCache.get(normalized);
  if (cached) return cached;

  const pending = readDataset(normalized).catch((error) => {
    datasetCache.delete(normalized);
    throw error;
  });
  datasetCache.set(normalized, pending);
  return pending;
}

export async function getServerNeighborhoodBySlug(
  citySlug: string,
  neighborhoodSlug: string,
): Promise<Neighborhood | null> {
  const neighborhoods = await serverNeighborhoods(citySlug);
  return neighborhoods.find((neighborhood) => neighborhood.slug === neighborhoodSlug) ?? null;
}
