#!/usr/bin/env python3
"""Build stylized metro district overlays for the map UI.

These districts are intentionally *not* literal neighborhood polygons.
They are a game-map layer: fewer, larger regions that cover the metro
scanner footprint and feel closer to a Mafia III district map than a
county choropleth.

The old generator assigned a hex grid directly to seeds, which made the
final borders visibly stepped. This version instead:

1. softens a hand-tuned metro hull per city,
2. lays down a fine square coverage inside that hull,
3. grows districts outward from seed cells with a shared terrain field
   so every district stays contiguous while borders bend organically,
4. simplifies the resulting polygon coverage while preserving shared
   edges and exact no-overlap coverage.
"""

from __future__ import annotations

import heapq
import json
import math
from dataclasses import dataclass
from pathlib import Path

from shapely import coverage_simplify, coverage_union_all, set_precision
from shapely.geometry import LineString, MultiPolygon, Point, Polygon, box
from shapely.ops import linemerge, polygonize, unary_union

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "frontend/public/districts"


@dataclass(frozen=True)
class Seed:
    name: str
    slug: str
    lng: float
    lat: float
    bias: float = 1.0


CITY_CONFIGS = {
    "philly": {
        "grid_step": 0.0052,
        "expand": 0.05,
        "smooth_multiplier": 6.2,
        "terrain_strength": 0.17,
        "phase": 0.35,
        "hulls": [
            [
                (-75.70, 39.83),
                (-75.66, 40.10),
                (-75.60, 40.22),
                (-75.47, 40.29),
                (-75.30, 40.30),
                (-75.10, 40.29),
                (-74.92, 40.23),
                (-74.86, 40.08),
                (-74.89, 39.91),
                (-75.02, 39.81),
                (-75.20, 39.78),
                (-75.40, 39.79),
                (-75.58, 39.80),
            ],
        ],
        "seeds": [
            Seed("West Chester & Chester County", "west-chester-chester-county", -75.61, 39.96, 1.05),
            Seed("Pottstown & Upper Schuylkill", "pottstown-upper-schuylkill", -75.61, 40.23, 1.08),
            Seed("King of Prussia", "king-of-prussia", -75.38, 40.10, 0.94),
            Seed("Main Line", "main-line", -75.33, 40.00, 0.92),
            Seed("Media & Springfield", "media-springfield", -75.39, 39.92, 0.96),
            Seed("Chester & Riverfront", "chester-riverfront", -75.38, 39.85, 1.02),
            Seed("Airport & Tinicum", "airport-tinicum", -75.23, 39.85, 1.00),
            Seed("Upper Darby & Yeadon", "upper-darby-yeadon", -75.28, 39.95, 0.90),
            Seed("West Philly", "west-philly", -75.22, 39.95, 0.90),
            Seed("Center City", "center-city", -75.16, 39.95, 0.83),
            Seed("South Philly", "south-philly", -75.16, 39.91, 0.90),
            Seed("North Philly", "north-philly", -75.16, 39.99, 0.90),
            Seed("River Wards", "river-wards", -75.11, 39.96, 0.90),
            Seed("Northeast Philly", "northeast-philly", -75.05, 40.01, 0.93),
            Seed("Lower Bucks", "lower-bucks", -74.96, 40.13, 1.02),
            Seed("Doylestown & Central Bucks", "doylestown-central-bucks", -75.13, 40.25, 1.08),
            Seed("Norristown & Conshohocken", "norristown-conshohocken", -75.31, 40.12, 0.95),
            Seed("Lansdale & North Montco", "lansdale-north-montco", -75.28, 40.23, 1.02),
        ],
    },
    "nyc": {
        "grid_step": 0.0046,
        "expand": 0.04,
        "smooth_multiplier": 6.0,
        "terrain_strength": 0.15,
        "phase": 1.15,
        "hulls": [
            [
                (-74.24, 40.63),
                (-74.22, 40.83),
                (-74.14, 40.90),
                (-73.93, 40.93),
                (-73.74, 40.90),
                (-73.70, 40.73),
                (-73.73, 40.58),
                (-73.88, 40.58),
                (-74.05, 40.60),
                (-74.18, 40.61),
            ],
            [
                (-74.27, 40.49),
                (-74.22, 40.64),
                (-74.10, 40.65),
                (-74.03, 40.60),
                (-74.07, 40.49),
                (-74.18, 40.48),
            ],
        ],
        "seeds": [
            Seed("Lower Manhattan", "lower-manhattan", -74.01, 40.71, 0.84),
            Seed("Midtown", "midtown", -73.99, 40.76, 0.86),
            Seed("Uptown West", "uptown-west", -73.99, 40.80, 0.90),
            Seed("Harlem & Uptown", "harlem-uptown", -73.95, 40.84, 0.90),
            Seed("Lower Brooklyn", "lower-brooklyn", -74.01, 40.67, 0.94),
            Seed("North Brooklyn", "north-brooklyn", -73.95, 40.72, 0.90),
            Seed("Central Brooklyn", "central-brooklyn", -73.94, 40.67, 0.94),
            Seed("South Brooklyn", "south-brooklyn", -73.99, 40.61, 0.98),
            Seed("LIC & Astoria", "lic-astoria", -73.92, 40.76, 0.88),
            Seed("North Queens", "north-queens", -73.85, 40.78, 0.94),
            Seed("Central Queens", "central-queens", -73.87, 40.74, 0.96),
            Seed("Eastern Queens", "eastern-queens", -73.79, 40.72, 1.02),
            Seed("JFK & South Queens", "jfk-south-queens", -73.82, 40.64, 1.00),
            Seed("South Bronx", "south-bronx", -73.91, 40.82, 0.92),
            Seed("North Bronx", "north-bronx", -73.86, 40.88, 0.98),
            Seed("Hudson Waterfront", "hudson-waterfront", -74.07, 40.72, 0.96),
            Seed("Newark & North Jersey", "newark-north-jersey", -74.18, 40.74, 1.02),
            Seed("Staten Island North", "staten-island-north", -74.11, 40.63, 0.96),
            Seed("Staten Island South", "staten-island-south", -74.18, 40.55, 1.00),
        ],
    },
    "sf": {
        "grid_step": 0.0048,
        "expand": 0.05,
        "smooth_multiplier": 5.8,
        "terrain_strength": 0.16,
        "phase": 2.05,
        "hulls": [
            [
                (-122.53, 37.81),
                (-122.48, 37.84),
                (-122.34, 37.84),
                (-122.24, 37.78),
                (-122.17, 37.66),
                (-122.10, 37.44),
                (-122.16, 37.41),
                (-122.29, 37.43),
                (-122.39, 37.49),
                (-122.45, 37.60),
                (-122.52, 37.74),
            ],
            [
                (-122.35, 37.84),
                (-122.15, 37.84),
                (-121.97, 37.73),
                (-121.98, 37.55),
                (-122.08, 37.43),
                (-122.17, 37.44),
                (-122.15, 37.62),
                (-122.24, 37.78),
            ],
            [
                (-122.55, 37.58),
                (-122.48, 37.60),
                (-122.44, 37.50),
                (-122.49, 37.45),
                (-122.56, 37.49),
            ],
        ],
        "seeds": [
            Seed("Outer Richmond", "outer-richmond", -122.49, 37.78, 0.96),
            Seed("Northside", "northside", -122.43, 37.80, 0.88),
            Seed("Market Core", "market-core", -122.41, 37.78, 0.82),
            Seed("Mission & Castro", "mission-castro", -122.43, 37.75, 0.90),
            Seed("Bayview & South SF", "bayview-south-sf", -122.39, 37.71, 0.94),
            Seed("Daly City", "daly-city", -122.47, 37.69, 0.96),
            Seed("Peninsula North", "peninsula-north", -122.42, 37.64, 0.98),
            Seed("Mid-Peninsula West", "mid-peninsula-west", -122.36, 37.58, 0.98),
            Seed("Belmont & San Carlos", "belmont-san-carlos", -122.29, 37.52, 0.96),
            Seed("Redwood City", "redwood-city", -122.23, 37.49, 0.94),
            Seed("Menlo Park & Atherton", "menlo-park-atherton", -122.19, 37.46, 0.96),
            Seed("Palo Alto & Stanford", "palo-alto-stanford", -122.15, 37.43, 0.98),
            Seed("Coastside", "coastside", -122.48, 37.52, 1.08),
            Seed("Oakland & Berkeley", "oakland-berkeley", -122.27, 37.79, 0.98),
            Seed("East Bay South", "east-bay-south", -122.12, 37.64, 1.02),
        ],
    },
    "chattanooga": {
        "grid_step": 0.0048,
        "expand": 0.035,
        "smooth_multiplier": 5.8,
        "terrain_strength": 0.16,
        "phase": 2.75,
        "hulls": [
            [
                (-85.53, 35.00),
                (-85.49, 35.14),
                (-85.41, 35.23),
                (-85.27, 35.22),
                (-85.16, 35.19),
                (-85.06, 35.10),
                (-85.07, 34.96),
                (-85.16, 34.89),
                (-85.30, 34.87),
                (-85.45, 34.88),
                (-85.51, 34.94),
            ],
        ],
        "seeds": [
            Seed("Lookout & St. Elmo", "lookout-st-elmo", -85.36, 35.00, 0.98),
            Seed("Downtown Chattanooga", "downtown-chattanooga", -85.31, 35.05, 0.84),
            Seed("North Shore & Red Bank", "north-shore-red-bank", -85.31, 35.08, 0.90),
            Seed("Hixson", "hixson", -85.26, 35.13, 0.94),
            Seed("Soddy-Daisy", "soddy-daisy", -85.24, 35.20, 1.04),
            Seed("East Chattanooga & Brainerd", "east-chattanooga-brainerd", -85.24, 35.03, 0.92),
            Seed("East Ridge & Rossville", "east-ridge-rossville", -85.22, 34.96, 0.98),
            Seed("Signal Mountain", "signal-mountain", -85.39, 35.13, 1.00),
            Seed("Ooltewah & Collegedale", "ooltewah-collegedale", -85.14, 35.05, 1.04),
        ],
    },
}


def as_polygons(geom) -> list[Polygon]:
    if geom.is_empty:
        return []
    if isinstance(geom, Polygon):
        return [geom] if geom.area > 0 else []
    if isinstance(geom, MultiPolygon):
        return [poly for poly in geom.geoms if poly.area > 0]
    if hasattr(geom, "geoms"):
        polys = []
        for piece in geom.geoms:
            polys.extend(as_polygons(piece))
        return polys
    return []


def polygon_to_output(geom: Polygon | MultiPolygon) -> tuple[list, list, dict]:
    polygons = as_polygons(geom)
    multi_polygon_out = []
    polygon_out = []
    all_lngs = []
    all_lats = []
    for poly in polygons:
        exterior = [[round(x, 7), round(y, 7)] for x, y in poly.exterior.coords]
        holes = [
            [[round(x, 7), round(y, 7)] for x, y in interior.coords]
            for interior in poly.interiors
        ]
        multi_polygon_out.append([exterior, *holes])
        polygon_out.append(exterior)
        all_lngs.extend(x for x, _ in exterior)
        all_lats.extend(y for _, y in exterior)
    bounds = {
        "north": round(max(all_lats), 5),
        "south": round(min(all_lats), 5),
        "east": round(max(all_lngs), 5),
        "west": round(min(all_lngs), 5),
    }
    return polygon_out, multi_polygon_out, bounds


def soften_clip(hulls: list[list[tuple[float, float]]], expand: float):
    clip = unary_union([Polygon(hull) for hull in hulls]).buffer(0)
    if expand > 0:
        clip = clip.buffer(expand, join_style=1)
    return clip.buffer(0)


def build_grid_cells(clip, step: float):
    minx, miny, maxx, maxy = clip.bounds
    cols = int(math.ceil((maxx - minx) / step)) + 2
    rows = int(math.ceil((maxy - miny) / step)) + 2
    cells = {}
    coords = {}
    for row in range(rows):
        y = miny + row * step
        for col in range(cols):
            x = minx + col * step
            piece = box(x - step / 2, y - step / 2, x + step / 2, y + step / 2).intersection(clip)
            if piece.is_empty:
                continue
            key = (row, col)
            cells[key] = piece
            rp = piece.representative_point()
            coords[key] = (rp.x, rp.y)
    return cells, coords


def choose_seed_cells(cells: dict, coords: dict, seeds: list[Seed]) -> dict[int, tuple[int, int]]:
    available = set(cells.keys())
    chosen = {}
    for idx, seed in enumerate(seeds):
        if not available:
            raise RuntimeError("ran out of grid cells while placing seed cells")
        best = min(
            available,
            key=lambda rc: (coords[rc][0] - seed.lng) ** 2 + (coords[rc][1] - seed.lat) ** 2,
        )
        chosen[idx] = best
        available.remove(best)
    return chosen


def terrain_factor(
    lng: float,
    lat: float,
    bounds: tuple[float, float, float, float],
    phase: float,
    strength: float,
) -> float:
    minx, miny, maxx, maxy = bounds
    cx = (minx + maxx) / 2
    cy = (miny + maxy) / 2
    span_x = max(maxx - minx, 1e-9)
    span_y = max(maxy - miny, 1e-9)
    nx = (lng - cx) / span_x
    ny = (lat - cy) / span_y
    field = (
        0.58 * math.sin(2.4 * nx + 1.8 * ny + phase)
        + 0.32 * math.cos(4.7 * ny - 1.1 * nx - phase * 0.7)
        + 0.18 * math.sin(6.4 * (nx - ny) + phase * 1.3)
    )
    return max(0.72, min(1.34, 1.0 + strength * field))


def grow_districts_contiguous(
    clip,
    seeds: list[Seed],
    step: float,
    phase: float,
    terrain_strength: float,
) -> dict[str, Polygon | MultiPolygon]:
    cells, coords = build_grid_cells(clip, step)
    seed_cells = choose_seed_cells(cells, coords, seeds)

    owner: dict[tuple[int, int], int] = {}
    dist: dict[tuple[int, int], float] = {}
    pq: list[tuple[float, int, tuple[int, int]]] = []

    for seed_idx, cell_key in seed_cells.items():
        owner[cell_key] = seed_idx
        dist[cell_key] = 0.0
        heapq.heappush(pq, (0.0, seed_idx, cell_key))

    neighbors = [
        (-1, 0), (1, 0), (0, -1), (0, 1),
        (-1, -1), (-1, 1), (1, -1), (1, 1),
    ]

    while pq:
        cost, seed_idx, key = heapq.heappop(pq)
        if cost != dist.get(key) or owner.get(key) != seed_idx:
            continue
        x, y = coords[key]
        for drow, dcol in neighbors:
            nkey = (key[0] + drow, key[1] + dcol)
            if nkey not in cells:
                continue
            nx, ny = coords[nkey]
            lng_scale = math.cos(math.radians((y + ny) / 2))
            edge = math.hypot((nx - x) * lng_scale, ny - y)
            if edge <= 0:
                continue
            terrain = terrain_factor((x + nx) / 2, (y + ny) / 2, clip.bounds, phase, terrain_strength)
            new_cost = cost + edge * seeds[seed_idx].bias * terrain
            prev = dist.get(nkey)
            if prev is None or new_cost < prev - 1e-12:
                dist[nkey] = new_cost
                owner[nkey] = seed_idx
                heapq.heappush(pq, (new_cost, seed_idx, nkey))

    # Safety net: if a disconnected hull component somehow lacked a seed,
    # claim its cells by straight-line proximity so the final coverage
    # still fully blankets the metro hull.
    for key, piece in cells.items():
        if key in owner:
            continue
        rp = piece.representative_point()
        owner[key] = min(
            range(len(seeds)),
            key=lambda i: math.hypot(rp.x - seeds[i].lng, rp.y - seeds[i].lat) * seeds[i].bias,
        )

    by_slug: dict[str, list[Polygon]] = {seed.slug: [] for seed in seeds}
    for key, seed_idx in owner.items():
        by_slug[seeds[seed_idx].slug].append(cells[key])

    geoms = {
        seed.slug: unary_union(by_slug[seed.slug]).intersection(clip).buffer(0)
        for seed in seeds
    }

    # Patch any tiny numeric leftover slivers back into the nearest
    # district so exported polygons exactly cover the softened hull.
    covered = unary_union([geom for geom in geoms.values() if not geom.is_empty]).buffer(0)
    missing = clip.difference(covered)
    if not missing.is_empty:
        for piece in as_polygons(missing):
            rp = piece.representative_point()
            target = min(
                seeds,
                key=lambda seed: math.hypot(rp.x - seed.lng, rp.y - seed.lat) * seed.bias,
            )
            geoms[target.slug] = unary_union([geoms[target.slug], piece]).buffer(0)

    return geoms


def chaikin_line(coords: list[tuple[float, float]], *, closed: bool, iterations: int = 4):
    pts = [tuple(p) for p in (coords[:-1] if closed else coords)]
    for _ in range(iterations):
        if len(pts) <= 2:
            break
        out = [] if closed else [pts[0]]
        n = len(pts)
        limit = n if closed else n - 1
        for i in range(limit):
            p = pts[i]
            q = pts[(i + 1) % n]
            out.append((0.75 * p[0] + 0.25 * q[0], 0.75 * p[1] + 0.25 * q[1]))
            out.append((0.25 * p[0] + 0.75 * q[0], 0.25 * p[1] + 0.75 * q[1]))
        if not closed:
            out.append(pts[-1])
        pts = out
    return pts + [pts[0]] if closed and pts else pts


def smooth_coverage_boundaries(geoms: dict[str, Polygon | MultiPolygon]):
    merged_lines = linemerge(unary_union([geom.boundary for geom in geoms.values() if not geom.is_empty]))
    smoothed_lines = []
    for seg in (list(merged_lines.geoms) if hasattr(merged_lines, "geoms") else [merged_lines]):
        coords = list(seg.coords)
        if len(coords) < 3:
            smoothed_lines.append(seg)
            continue
        smoothed_lines.append(
            LineString(
                chaikin_line(
                    coords,
                    closed=coords[0] == coords[-1],
                    iterations=4,
                )
            )
        )

    polygon_pieces = list(polygonize(unary_union(smoothed_lines)))
    by_slug: dict[str, list[Polygon]] = {slug: [] for slug in geoms}
    for poly in polygon_pieces:
        rp = poly.representative_point()
        owner = None
        for slug, geom in geoms.items():
            if geom.buffer(1e-9).contains(rp):
                owner = slug
                break
        if owner is None:
            owner = min(geoms, key=lambda slug: geoms[slug].distance(rp))
        by_slug[owner].append(poly)

    return {
        slug: unary_union(parts).buffer(0)
        for slug, parts in by_slug.items()
        if parts
    }


def build_city(slug: str, cfg: dict) -> None:
    clip = soften_clip(cfg["hulls"], cfg["expand"])
    seeds: list[Seed] = cfg["seeds"]
    geoms = grow_districts_contiguous(
        clip=clip,
        seeds=seeds,
        step=cfg["grid_step"],
        phase=cfg["phase"],
        terrain_strength=cfg["terrain_strength"],
    )

    coverage = [geoms[seed.slug] for seed in seeds if not geoms[seed.slug].is_empty]
    simplified = coverage_simplify(
        coverage,
        cfg["grid_step"] * cfg["smooth_multiplier"],
        simplify_boundary=False,
    )

    simplified_by_slug = {}
    active_seeds = [seed for seed in seeds if not geoms[seed.slug].is_empty]
    for seed, geom in zip(active_seeds, simplified):
        snapped = set_precision(coverage_union_all(as_polygons(geom)).buffer(0), 1e-6)
        simplified_by_slug[seed.slug] = snapped.buffer(0)

    simplified_by_slug = smooth_coverage_boundaries(simplified_by_slug)
    simplified_by_slug = {
        slug: set_precision(coverage_union_all(as_polygons(geom)).buffer(0), 1e-7).buffer(0)
        for slug, geom in simplified_by_slug.items()
        if not geom.is_empty
    }

    districts = []
    for seed in seeds:
        geom = simplified_by_slug.get(seed.slug)
        if geom is None or geom.is_empty:
            continue
        polygon, multi_polygon, bounds = polygon_to_output(geom)
        seed_point = Point(seed.lng, seed.lat)
        center_point = seed_point if geom.buffer(1e-9).contains(seed_point) else geom.representative_point()
        districts.append(
            {
                "name": seed.name,
                "slug": seed.slug,
                "center": {"lat": round(center_point.y, 5), "lng": round(center_point.x, 5)},
                "bounds": bounds,
                "polygon": polygon,
                "multiPolygon": multi_polygon,
            }
        )

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    out_path = OUT_DIR / f"{slug}.json"
    with out_path.open("w") as f:
        json.dump(districts, f, separators=(",", ":"))
    print(f"{slug}: wrote {len(districts)} districts -> {out_path}")


def main() -> None:
    for slug, cfg in CITY_CONFIGS.items():
        build_city(slug, cfg)


if __name__ == "__main__":
    main()
