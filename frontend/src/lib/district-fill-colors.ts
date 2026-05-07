import type { District } from "./districts";

/** Greedy graph coloring: adjacent districts (see `neighbors`) get different palette slots. */
export function districtFillsGreedy(districts: District[], palette: string[]): string[] {
  const n = districts.length;
  if (n === 0) return [];

  const hasNeighborField = districts.every((d) => Array.isArray(d.neighbors));
  if (!hasNeighborField) {
    return districts.map((_, i) => palette[i % palette.length]);
  }

  const slugToIdx = new Map(districts.map((d, i) => [d.slug, i]));
  const adj: Set<number>[] = Array.from({ length: n }, () => new Set());
  for (let i = 0; i < n; i++) {
    for (const s of districts[i].neighbors || []) {
      const j = slugToIdx.get(s);
      if (j !== undefined && j !== i) {
        adj[i].add(j);
        adj[j].add(i);
      }
    }
  }

  const order = Array.from({ length: n }, (_, i) => i).sort(
    (a, b) => adj[b].size - adj[a].size
  );
  const colorIdx = new Array<number>(n).fill(-1);
  let maxC = 0;
  for (const v of order) {
    const used = new Set<number>();
    for (const u of adj[v]) {
      const cu = colorIdx[u];
      if (cu >= 0) used.add(cu);
    }
    let c = 0;
    while (used.has(c)) c++;
    colorIdx[v] = c;
    maxC = Math.max(maxC, c);
  }

  const colors = expandPalette(palette, maxC + 1);
  return colorIdx.map((c) => colors[c]);
}

function expandPalette(base: string[], minLen: number): string[] {
  if (base.length >= minLen) return base;
  const out = [...base];
  let hue = 33;
  while (out.length < minLen) {
    hue = (hue + 41) % 360;
    out.push(`hsl(${hue} 38% 44%)`);
  }
  return out;
}
