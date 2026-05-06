#!/usr/bin/env python3
"""Build stylized metro district overlays for the map UI.

These districts are intentionally *not* literal neighborhood boundaries.
They are a game-map layer: fewer, larger regions that cover the entire
scanner footprint for each city and read cleanly at metro zoom levels.

We generate them by:
1. defining a rough metro hull polygon per city,
2. placing named district seeds inside that hull,
3. assigning a dense hex grid to the nearest seed with a light,
   deterministic wobble so boundaries feel less rigid than straight
   Voronoi cells,
4. unioning the assigned hexes into district polygons and exporting
   them as GeoJSON-like JSON for the frontend.
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass
from pathlib import Path

from shapely.geometry import MultiPolygon, Point, Polygon
from shapely.ops import unary_union

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
        "hex_radius": 0.0075,
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
            Seed("Airport & Tinicum", "airport-tinicum", -75.23, 39.85, 1.0),
            Seed("Upper Darby & Yeadon", "upper-darby-yeadon", -75.28, 39.95, 0.9),
            Seed("West Philly", "west-philly", -75.22, 39.95, 0.9),
            Seed("Center City", "center-city", -75.16, 39.95, 0.83),
            Seed("South Philly", "south-philly", -75.16, 39.91, 0.9),
            Seed("North Philly", "north-philly", -75.16, 39.99, 0.9),
            Seed("River Wards", "river-wards", -75.11, 39.96, 0.9),
            Seed("Northeast Philly", "northeast-philly", -75.05, 40.01, 0.93),
            Seed("Lower Bucks", "lower-bucks", -74.96, 40.13, 1.02),
            Seed("Doylestown & Central Bucks", "doylestown-central-bucks", -75.13, 40.25, 1.08),
            Seed("Norristown & Conshohocken", "norristown-conshohocken", -75.31, 40.12, 0.95),
            Seed("Lansdale & North Montco", "lansdale-north-montco", -75.28, 40.23, 1.02),
        ],
    },
    "nyc": {
        "hex_radius": 0.0068,
        "hulls": [
            [
                (-74.05, 40.69),
                (-74.02, 40.86),
                (-73.91, 40.92),
                (-73.74, 40.90),
                (-73.70, 40.74),
                (-73.74, 40.56),
                (-74.00, 40.58),
                (-74.08, 40.63),
            ],
            [
                (-74.26, 40.49),
                (-74.23, 40.63),
                (-74.10, 40.64),
                (-74.05, 40.58),
                (-74.08, 40.50),
                (-74.18, 40.49),
            ],
        ],
        "seeds": [
            Seed("Lower Manhattan", "lower-manhattan", -74.01, 40.71, 0.84),
            Seed("Midtown", "midtown", -73.99, 40.76, 0.86),
            Seed("Uptown West", "uptown-west", -73.99, 40.80, 0.9),
            Seed("Harlem & Uptown", "harlem-uptown", -73.95, 40.84, 0.9),
            Seed("Lower Brooklyn", "lower-brooklyn", -74.01, 40.67, 0.94),
            Seed("North Brooklyn", "north-brooklyn", -73.95, 40.72, 0.9),
            Seed("Central Brooklyn", "central-brooklyn", -73.94, 40.67, 0.94),
            Seed("South Brooklyn", "south-brooklyn", -73.99, 40.61, 0.98),
            Seed("LIC & Astoria", "lic-astoria", -73.92, 40.76, 0.88),
            Seed("North Queens", "north-queens", -73.85, 40.78, 0.94),
            Seed("Central Queens", "central-queens", -73.87, 40.74, 0.96),
            Seed("Eastern Queens", "eastern-queens", -73.79, 40.72, 1.02),
            Seed("JFK & South Queens", "jfk-south-queens", -73.82, 40.64, 1.0),
            Seed("South Bronx", "south-bronx", -73.91, 40.82, 0.92),
            Seed("North Bronx", "north-bronx", -73.86, 40.88, 0.98),
            Seed("Staten Island North", "staten-island-north", -74.11, 40.63, 0.96),
            Seed("Staten Island South", "staten-island-south", -74.18, 40.55, 1.0),
        ],
    },
    "sf": {
        "hex_radius": 0.0065,
        "hulls": [
            [
                (-122.53, 37.81),
                (-122.48, 37.84),
                (-122.39, 37.84),
                (-122.31, 37.81),
                (-122.24, 37.75),
                (-122.17, 37.65),
                (-122.10, 37.44),
                (-122.16, 37.41),
                (-122.27, 37.43),
                (-122.37, 37.49),
                (-122.45, 37.60),
                (-122.52, 37.74),
            ],
            [
                (-122.53, 37.58),
                (-122.48, 37.60),
                (-122.44, 37.50),
                (-122.49, 37.45),
                (-122.54, 37.50),
            ],
        ],
        "seeds": [
            Seed("Outer Richmond", "outer-richmond", -122.49, 37.78, 0.96),
            Seed("Northside", "northside", -122.43, 37.80, 0.88),
            Seed("Market Core", "market-core", -122.41, 37.78, 0.82),
            Seed("Mission & Castro", "mission-castro", -122.43, 37.75, 0.9),
            Seed("Bayview & South SF", "bayview-south-sf", -122.39, 37.71, 0.94),
            Seed("Daly City", "daly-city", -122.47, 37.69, 0.96),
            Seed("Peninsula North", "peninsula-north", -122.42, 37.64, 0.98),
            Seed("Mid-Peninsula West", "mid-peninsula-west", -122.36, 37.58, 0.98),
            Seed("San Mateo Bayfront", "san-mateo-bayfront", -122.31, 37.56, 0.96),
            Seed("Belmont & San Carlos", "belmont-san-carlos", -122.29, 37.52, 0.96),
            Seed("Redwood City", "redwood-city", -122.23, 37.49, 0.94),
            Seed("Menlo Park & Atherton", "menlo-park-atherton", -122.19, 37.46, 0.96),
            Seed("Palo Alto & Stanford", "palo-alto-stanford", -122.15, 37.43, 0.98),
            Seed("Coastside", "coastside", -122.48, 37.52, 1.08),
            Seed("Treasure Island / Bay Fringe", "treasure-island-bay-fringe", -122.26, 37.80, 1.0),
        ],
    },
    "chattanooga": {
        "hex_radius": 0.0068,
        "hulls": [
            [
                (-85.52, 35.00),
                (-85.48, 35.14),
                (-85.40, 35.22),
                (-85.28, 35.21),
                (-85.18, 35.17),
                (-85.10, 35.09),
                (-85.10, 34.97),
                (-85.18, 34.90),
                (-85.30, 34.88),
                (-85.44, 34.89),
                (-85.50, 34.94),
            ],
        ],
        "seeds": [
            Seed("Lookout & St. Elmo", "lookout-st-elmo", -85.36, 35.00, 0.98),
            Seed("Downtown Chattanooga", "downtown-chattanooga", -85.31, 35.05, 0.84),
            Seed("North Shore & Red Bank", "north-shore-red-bank", -85.31, 35.08, 0.9),
            Seed("Hixson", "hixson", -85.26, 35.13, 0.94),
            Seed("Soddy-Daisy", "soddy-daisy", -85.24, 35.20, 1.04),
            Seed("East Chattanooga & Brainerd", "east-chattanooga-brainerd", -85.24, 35.03, 0.92),
            Seed("East Ridge & Rossville", "east-ridge-rossville", -85.22, 34.96, 0.98),
            Seed("Signal Mountain", "signal-mountain", -85.39, 35.13, 1.0),
            Seed("Ooltewah & Collegedale", "ooltewah-collegedale", -85.14, 35.05, 1.04),
        ],
    },
}


def pointy_hexagon(cx: float, cy: float, radius: float) -> Polygon:
    return Polygon(
        [
            (
                cx + radius * math.cos(math.radians(30 + 60 * i)),
                cy + radius * math.sin(math.radians(30 + 60 * i)),
            )
            for i in range(6)
        ]
    )


def score_seed(seed: Seed, idx: int, lng: float, lat: float, lng_scale: float) -> float:
    dx = (lng - seed.lng) * lng_scale
    dy = lat - seed.lat
    base = math.hypot(dx, dy) * seed.bias
    wave = (
        math.sin((lng * 31.0 + lat * 27.0 + idx * 0.8) * 10.0)
        + 0.55 * math.sin((lng * 17.0 - lat * 23.0 + idx * 1.4) * 12.0)
        + 0.35 * math.cos((lng * 41.0 + lat * 13.0 + idx * 2.1) * 8.0)
    )
    return base * (1.0 + 0.028 * wave)


def iter_hex_centers(bounds: tuple[float, float, float, float], radius: float):
    minx, miny, maxx, maxy = bounds
    width = math.sqrt(3.0) * radius
    vert_step = 1.5 * radius
    row = 0
    y = miny - radius
    while y <= maxy + radius:
        x = minx - width + (width / 2.0 if row % 2 else 0.0)
        while x <= maxx + width:
            yield x, y
            x += width
        row += 1
        y += vert_step


def polygon_to_output(geom: Polygon | MultiPolygon) -> tuple[list, list, dict]:
    if isinstance(geom, Polygon):
        polygons = [geom]
    else:
        polygons = list(geom.geoms)
    polygons = [p for p in polygons if p.area > 0]
    multi_polygon_out = []
    polygon_out = []
    all_lngs = []
    all_lats = []
    for poly in polygons:
        exterior = [[round(x, 5), round(y, 5)] for x, y in poly.exterior.coords]
        holes = [
            [[round(x, 5), round(y, 5)] for x, y in interior.coords]
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


def build_city(slug: str, cfg: dict) -> None:
    clip = unary_union([Polygon(hull) for hull in cfg["hulls"]])
    radius = cfg["hex_radius"]
    seeds: list[Seed] = cfg["seeds"]
    lng_scale = math.cos(math.radians(sum(seed.lat for seed in seeds) / len(seeds)))
    clip_test = clip.buffer(radius * 0.75)

    by_slug: dict[str, list[Polygon]] = {seed.slug: [] for seed in seeds}
    for lng, lat in iter_hex_centers(clip.bounds, radius):
        center = Point(lng, lat)
        if not clip_test.contains(center):
            continue
        cell = pointy_hexagon(lng, lat, radius)
        if not cell.intersects(clip):
            continue
        best = min(
            enumerate(seeds),
            key=lambda pair: score_seed(pair[1], pair[0], lng, lat, lng_scale),
        )[1]
        by_slug[best.slug].append(cell.intersection(clip))

    geoms = {
        seed.slug: unary_union(by_slug[seed.slug]).intersection(clip).buffer(0)
        for seed in seeds
    }
    seed_by_slug = {seed.slug: seed for seed in seeds}

    for _ in range(4):
        mains = {}
        orphans = []
        for seed in seeds:
            polys = as_polygons(geoms[seed.slug])
            if not polys:
                mains[seed.slug] = Polygon()
                continue
            seed_point = Point(seed.lng, seed.lat)
            containing = [poly for poly in polys if poly.buffer(1e-9).contains(seed_point)]
            if containing:
                main = max(containing, key=lambda poly: poly.area)
            else:
                main = min(polys, key=lambda poly: poly.representative_point().distance(seed_point))
            mains[seed.slug] = main
            for poly in polys:
                if not poly.equals(main):
                    orphans.append(poly)
        if not orphans:
            geoms = mains
            break
        for orphan in sorted(orphans, key=lambda poly: poly.area, reverse=True):
            target = min(
                seeds,
                key=lambda seed: (
                    mains[seed.slug].distance(orphan.representative_point())
                    if not mains[seed.slug].is_empty
                    else Point(seed.lng, seed.lat).distance(orphan.representative_point())
                ),
            )
            mains[target.slug] = unary_union([mains[target.slug], orphan]).buffer(0)
        geoms = mains

    districts = []
    for seed in seeds:
        geom = geoms[seed.slug]
        if geom.is_empty:
            continue
        if geom.geom_type not in {"Polygon", "MultiPolygon"}:
            continue
        polygon, multi_polygon, bounds = polygon_to_output(geom)
        districts.append(
            {
                "name": seed.name,
                "slug": seed.slug,
                "center": {"lat": round(seed.lat, 5), "lng": round(seed.lng, 5)},
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
