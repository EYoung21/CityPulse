/** Multi-stop route order optimizer.
 *
 *  When a user has 2–8 stops between origin and destination, the
 *  optimal visit order is a small Travelling-Salesman Problem with
 *  fixed endpoints. n <= 8 means at most 8! = 40,320 permutations of
 *  intermediate stops — brute-force evaluation is well under one
 *  second on every device, so we sidestep heuristic approximations
 *  entirely and just enumerate.
 *
 *  Distance metric: haversine great-circle distance, summed across
 *  consecutive waypoints. This is a pure straight-line approximation,
 *  not an actual road-network distance — but for "is it shorter to
 *  hit Stop B before Stop A?" the bird's-eye answer is right ~95% of
 *  the time and costs us zero ORS API calls. The user always sees the
 *  road-network total distance after the route refreshes, and can
 *  drag-reorder back if the optimizer's suggestion looks wrong.
 *
 *  We bail out (`needed: false`) when:
 *    - 0 or 1 intermediate stops (nothing to reorder)
 *    - The current order is already the shortest within 1% margin
 *      (avoids "optimized!" flicker when the user already nailed it)
 *    - 9+ stops (40k permutations is fine; 9! = 362,880 starts to be
 *      noticeable. We just don't offer optimization at that size to
 *      keep the UI honest.)
 */

const MAX_OPTIMIZABLE_STOPS = 8;

export interface OptimizableStop<T = unknown> {
  lat: number;
  lng: number;
  /** Opaque payload — we hand it back unchanged in the optimal order. */
  payload: T;
}

export interface OptimizeResult<T> {
  /** True if we were able to compute (and the answer is meaningfully
   *  better than the input order). False if the input is too small or
   *  too large to bother. */
  needed: boolean;
  /** The recommended order of intermediate stops. Empty when needed
   *  is false. */
  order: OptimizableStop<T>[];
  /** Length of the original order (km). */
  originalKm: number;
  /** Length of the optimal order (km). */
  optimalKm: number;
}

function haversineKm(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number }
): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const x =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

function tourLengthKm(
  origin: { lat: number; lng: number },
  stops: OptimizableStop[],
  dest: { lat: number; lng: number }
): number {
  let total = 0;
  let prev: { lat: number; lng: number } = origin;
  for (const s of stops) {
    total += haversineKm(prev, s);
    prev = s;
  }
  total += haversineKm(prev, dest);
  return total;
}

/** Heap's algorithm — yields every permutation of `arr` in-place. We
 *  use a generator so we can short-circuit early if a permutation
 *  exceeds the running best (not done yet, but cheap to add). */
function* permutations<T>(arr: T[]): Generator<T[]> {
  const n = arr.length;
  const c = new Array<number>(n).fill(0);
  yield arr.slice();
  let i = 0;
  while (i < n) {
    if (c[i] < i) {
      const swap = i % 2 === 0 ? 0 : c[i];
      [arr[swap], arr[i]] = [arr[i], arr[swap]];
      yield arr.slice();
      c[i]++;
      i = 0;
    } else {
      c[i] = 0;
      i++;
    }
  }
}

export function optimizeStopOrder<T>(
  origin: { lat: number; lng: number },
  stops: OptimizableStop<T>[],
  dest: { lat: number; lng: number }
): OptimizeResult<T> {
  if (stops.length < 2) {
    return { needed: false, order: stops.slice(), originalKm: 0, optimalKm: 0 };
  }
  if (stops.length > MAX_OPTIMIZABLE_STOPS) {
    return { needed: false, order: stops.slice(), originalKm: 0, optimalKm: 0 };
  }

  const originalKm = tourLengthKm(origin, stops, dest);
  let bestKm = originalKm;
  let bestOrder = stops.slice();

  // Permute by index so the original order is always "perm 0" — a
  // trivial way to ensure we never recommend a reordering that ties
  // the input.
  const indices = stops.map((_, i) => i);
  for (const perm of permutations(indices)) {
    const candidate = perm.map((i) => stops[i]);
    const len = tourLengthKm(origin, candidate, dest);
    if (len < bestKm - 1e-6) {
      bestKm = len;
      bestOrder = candidate;
    }
  }

  // 1% margin — anything below that is rounding noise that won't
  // visibly change the road-network route, and surfacing it as
  // "optimized!" would feel dishonest.
  const meaningfulImprovement = (originalKm - bestKm) / Math.max(originalKm, 1e-6) > 0.01;
  return {
    needed: meaningfulImprovement,
    order: meaningfulImprovement ? bestOrder : stops.slice(),
    originalKm,
    optimalKm: meaningfulImprovement ? bestKm : originalKm,
  };
}

export const ROUTE_OPTIMIZE_MAX_STOPS = MAX_OPTIMIZABLE_STOPS;
