#!/usr/bin/env python3
"""Build stylized metro district overlays for the map UI.

These districts are intentionally *not* literal neighborhood polygons.
They are a game-map layer: fewer, larger regions that cover the metro
scanner footprint and feel closer to a Mafia III district map than a
county choropleth.

Each city is built as a Voronoi diagram over hand-tuned seed points
clipped to a hand-tuned metro hull. The Voronoi construction guarantees
that every shared border between two districts is a single straight
segment (a perpendicular bisector) — adjacent districts always meet
exactly, with no grid artifacts or staircase aliasing at any zoom level.

The legacy `bias`, `grid_step`, `smooth_multiplier`, `terrain_strength`,
and `phase` config fields are kept for source compatibility but ignored
by the Voronoi generator; tune cell size by adjusting seed positions.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

from shapely.geometry import MultiPoint, MultiPolygon, Point, Polygon, box
from shapely.ops import unary_union, voronoi_diagram

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
        "grid_step": 0.006,
        "expand": 0.075,
        "smooth_multiplier": 6.2,
        "terrain_strength": 0.17,
        "phase": 0.35,
        "hulls": [
            [
                (-75.93, 39.74),
                (-75.86, 40.10),
                (-75.72, 40.31),
                (-75.50, 40.43),
                (-75.22, 40.44),
                (-74.92, 40.38),
                (-74.66, 40.28),
                (-74.62, 40.08),
                (-74.72, 39.88),
                (-74.95, 39.72),
                (-75.25, 39.62),
                (-75.61, 39.65),
                (-75.84, 39.70),
            ],
        ],
        "seeds": [
            Seed("Reading & Berks", "reading-berks", -75.89, 40.34, 1.14),
            Seed("West Chester & Chester County", "west-chester-chester-county", -75.61, 39.96, 1.05),
            Seed("Pottstown & Upper Schuylkill", "pottstown-upper-schuylkill", -75.61, 40.23, 1.08),
            Seed("Wilmington & New Castle", "wilmington-new-castle", -75.55, 39.72, 1.12),
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
            Seed("South Jersey", "south-jersey", -74.90, 39.93, 1.05),
            Seed("Lower Bucks", "lower-bucks", -74.96, 40.13, 1.02),
            Seed("Trenton & Mercer", "trenton-mercer", -74.76, 40.22, 1.10),
            Seed("Doylestown & Central Bucks", "doylestown-central-bucks", -75.13, 40.25, 1.08),
            Seed("Norristown & Conshohocken", "norristown-conshohocken", -75.31, 40.12, 0.95),
            Seed("Lansdale & North Montco", "lansdale-north-montco", -75.28, 40.23, 1.02),
        ],
    },
    "nyc": {
        "grid_step": 0.0054,
        "expand": 0.06,
        "smooth_multiplier": 6.0,
        "terrain_strength": 0.15,
        "phase": 1.15,
        "hulls": [
            [
                (-74.38, 40.62),
                (-74.34, 40.90),
                (-74.17, 41.04),
                (-73.88, 41.04),
                (-73.55, 40.96),
                (-73.44, 40.78),
                (-73.51, 40.55),
                (-73.75, 40.49),
                (-74.03, 40.54),
                (-74.28, 40.57),
            ],
            [
                (-74.33, 40.47),
                (-74.25, 40.66),
                (-74.09, 40.66),
                (-73.99, 40.59),
                (-74.05, 40.45),
                (-74.22, 40.44),
            ],
        ],
        "seeds": [
            Seed("Bergen & Passaic", "bergen-passaic", -74.17, 40.89, 1.10),
            Seed("Essex & Union", "essex-union", -74.23, 40.70, 1.06),
            Seed("Westchester", "westchester", -73.80, 40.96, 1.10),
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
            Seed("Nassau North Shore", "nassau-north-shore", -73.63, 40.80, 1.08),
            Seed("Nassau South Shore", "nassau-south-shore", -73.62, 40.64, 1.08),
            Seed("South Bronx", "south-bronx", -73.91, 40.82, 0.92),
            Seed("North Bronx", "north-bronx", -73.86, 40.88, 0.98),
            Seed("Hudson Waterfront", "hudson-waterfront", -74.07, 40.72, 0.96),
            Seed("Newark & North Jersey", "newark-north-jersey", -74.18, 40.74, 1.02),
            Seed("Staten Island North", "staten-island-north", -74.11, 40.63, 0.96),
            Seed("Staten Island South", "staten-island-south", -74.18, 40.55, 1.00),
        ],
    },
    "sf": {
        "grid_step": 0.0056,
        "expand": 0.07,
        "smooth_multiplier": 5.8,
        "terrain_strength": 0.16,
        "phase": 2.05,
        "hulls": [
            [
                (-122.62, 37.66),
                (-122.57, 37.88),
                (-122.44, 38.03),
                (-122.19, 38.03),
                (-121.88, 37.91),
                (-121.74, 37.70),
                (-121.78, 37.48),
                (-121.94, 37.28),
                (-122.16, 37.22),
                (-122.37, 37.31),
                (-122.52, 37.48),
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
            Seed("Marin & North Bay", "marin-north-bay", -122.42, 37.95, 1.12),
            Seed("Berkeley & East Bay North", "berkeley-east-bay-north", -122.27, 37.86, 1.00),
            Seed("Oakland & Alameda", "oakland-alameda", -122.25, 37.78, 0.96),
            Seed("San Leandro & Hayward", "san-leandro-hayward", -122.12, 37.66, 1.00),
            Seed("Fremont & Newark", "fremont-newark", -122.02, 37.53, 1.04),
            Seed("Tri-Valley", "tri-valley", -121.88, 37.70, 1.10),
            Seed("South Bay", "south-bay", -121.93, 37.34, 1.08),
        ],
    },
    "chattanooga": {
        "grid_step": 0.0056,
        "expand": 0.06,
        "smooth_multiplier": 5.8,
        "terrain_strength": 0.16,
        "phase": 2.75,
        "hulls": [
            [
                (-85.62, 34.99),
                (-85.56, 35.18),
                (-85.43, 35.30),
                (-85.24, 35.30),
                (-85.02, 35.25),
                (-84.82, 35.15),
                (-84.83, 34.97),
                (-85.02, 34.81),
                (-85.26, 34.78),
                (-85.50, 34.83),
                (-85.60, 34.91),
            ],
        ],
        "seeds": [
            Seed("North Georgia", "north-georgia", -85.28, 34.86, 1.12),
            Seed("Lookout & St. Elmo", "lookout-st-elmo", -85.36, 35.00, 0.98),
            Seed("Downtown Chattanooga", "downtown-chattanooga", -85.31, 35.05, 0.84),
            Seed("North Shore & Red Bank", "north-shore-red-bank", -85.31, 35.08, 0.90),
            Seed("Hixson", "hixson", -85.26, 35.13, 0.94),
            Seed("Soddy-Daisy", "soddy-daisy", -85.24, 35.20, 1.04),
            Seed("East Chattanooga & Brainerd", "east-chattanooga-brainerd", -85.24, 35.03, 0.92),
            Seed("East Ridge & Rossville", "east-ridge-rossville", -85.22, 34.96, 0.98),
            Seed("Signal Mountain", "signal-mountain", -85.39, 35.13, 1.00),
            Seed("Ooltewah & Collegedale", "ooltewah-collegedale", -85.14, 35.05, 1.04),
            Seed("Cleveland & Bradley County", "cleveland-bradley-county", -84.88, 35.16, 1.12),
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


def build_voronoi_districts(clip, seeds: list[Seed]) -> dict[str, Polygon | MultiPolygon]:
    """Voronoi-partition the metro hull around the seed points.

    Each Voronoi cell is the locus of points closer to one seed than to any
    other; cell boundaries are perpendicular bisectors — clean straight
    segments shared exactly between adjacent districts."""
    multi = MultiPoint([(s.lng, s.lat) for s in seeds])

    # voronoi_diagram clips each cell to the envelope rectangle. Pass an
    # envelope much larger than the hull so the final intersection-with-hull
    # step is what shapes the perimeter cells, not the envelope.
    minx, miny, maxx, maxy = clip.bounds
    pad = max(maxx - minx, maxy - miny)
    envelope = box(minx - pad, miny - pad, maxx + pad, maxy + pad)
    diagram = voronoi_diagram(multi, envelope=envelope)
    cells = list(diagram.geoms)

    out: dict[str, Polygon | MultiPolygon] = {}
    used = [False] * len(cells)
    for s in seeds:
        seed_pt = Point(s.lng, s.lat)
        for i, cell in enumerate(cells):
            if used[i] or not cell.contains(seed_pt):
                continue
            clipped = cell.intersection(clip).buffer(0)
            if not clipped.is_empty:
                out[s.slug] = clipped
                used[i] = True
            break

    # Safety net: any sliver of the hull not assigned to a cell (can happen
    # when two seeds collide at the same Voronoi boundary) goes to the
    # geometrically nearest seed so coverage is exact.
    covered = unary_union([g for g in out.values() if not g.is_empty]).buffer(0)
    missing = clip.difference(covered)
    if not missing.is_empty:
        for piece in as_polygons(missing):
            rp = piece.representative_point()
            target = min(seeds, key=lambda s: rp.distance(Point(s.lng, s.lat)))
            existing = out.get(target.slug)
            out[target.slug] = unary_union([existing, piece]).buffer(0) if existing else piece

    return out


def build_city(slug: str, cfg: dict) -> None:
    clip = soften_clip(cfg["hulls"], cfg["expand"])
    seeds: list[Seed] = cfg["seeds"]
    geoms = build_voronoi_districts(clip, seeds)

    districts = []
    for seed in seeds:
        geom = geoms.get(seed.slug)
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

    # Adjacent districts share a boundary (Shapely touches). Used by the map
    # for greedy graph coloring so neighbors rarely share the same fill hue.
    slugs = [d["slug"] for d in districts]
    for d in districts:
        g = geoms.get(d["slug"])
        if g is None or g.is_empty:
            d["neighbors"] = []
            continue
        nbr: list[str] = []
        for s in slugs:
            if s == d["slug"]:
                continue
            og = geoms.get(s)
            if og is None or og.is_empty:
                continue
            if g.touches(og):
                nbr.append(s)
        nbr.sort()
        d["neighbors"] = nbr

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
