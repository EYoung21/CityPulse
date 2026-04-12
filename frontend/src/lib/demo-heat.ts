/**
 * Synthetic heat points around Philadelphia for demos / sparse real data.
 * Deterministic so the layer does not jitter on re-render.
 */
export function phillyDemoHeatPoints(): [number, number, number][] {
  const out: [number, number, number][] = [];
  let seed = 1234567;
  const rnd = () => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };

  const cluster = (
    centerLat: number,
    centerLng: number,
    spread: number,
    n: number,
    wMin: number,
    wMax: number
  ) => {
    for (let i = 0; i < n; i++) {
      const u = rnd() + rnd() + rnd() + rnd();
      const g = (u - 2) * spread;
      const v = rnd() + rnd() + rnd() + rnd();
      const h = (v - 2) * spread;
      const w = wMin + rnd() * (wMax - wMin);
      out.push([centerLat + g, centerLng + h, w]);
    }
  };

  // Center City / downtown
  cluster(39.9526, -75.1652, 0.018, 55, 0.35, 1.0);
  // West Philly
  cluster(39.954, -75.22, 0.022, 40, 0.28, 0.85);
  // North
  cluster(39.985, -75.15, 0.02, 35, 0.25, 0.75);
  // South / stadiums
  cluster(39.905, -75.17, 0.025, 38, 0.3, 0.9);
  // Northeast pocket
  cluster(39.97, -75.085, 0.016, 28, 0.22, 0.7);
  // Scattered city-wide
  for (let i = 0; i < 45; i++) {
    const lat = 39.88 + rnd() * 0.14;
    const lng = -75.28 + rnd() * 0.22;
    out.push([lat, lng, 0.15 + rnd() * 0.55]);
  }

  return out;
}
