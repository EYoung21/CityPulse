#!/usr/bin/env python3
"""Build frontend/public/neighborhoods/philly.json from raw click_that_hood GeoJSON.

Downloads the Philadelphia GeoJSON (158 neighborhoods) and merges them into
12 major districts via convex hull, producing organic polygon shapes.

Usage:
  python3 scripts/build_philly_districts.py
  # or with a local file:
  python3 scripts/build_philly_districts.py /tmp/philadelphia.geojson

Source:
  https://raw.githubusercontent.com/codeforgermany/click_that_hood/main/public/data/philadelphia.geojson
"""
import json
import math
import sys
import urllib.request
from pathlib import Path

SOURCE_URL = "https://raw.githubusercontent.com/codeforgermany/click_that_hood/main/public/data/philadelphia.geojson"
OUT_PATH = Path(__file__).parent.parent / "frontend/public/neighborhoods/philly.json"

# Maps each of the 158 click_that_hood neighborhood names to one of 12 districts.
DISTRICT_MAP: dict[str, list[str]] = {
    "Center City": [
        "Center City East", "Rittenhouse", "Logan Square", "Chinatown",
        "Washington Square West", "Fitler Square", "Old City", "Society Hill",
        "Graduate Hospital", "Hawthorne",
    ],
    "South Philly": [
        "East Passyunk", "West Passyunk", "Passyunk Square", "Point Breeze",
        "Grays Ferry", "Girard Estates", "Lower Moyamensing", "Pennsport",
        "Queen Village", "Bella Vista", "Dickinson Narrows", "Whitman",
        "Packer Park", "Stadium District", "Navy Yard", "Newbold", "Greenwich",
        # "Mechanicsville" excluded — source data places it at 40.106°N (bad coordinates)
        # "Penrose" → Southwest Philly (near airport/Schuylkill)
    ],
    "Fishtown & Northern Liberties": [
        "Fishtown - Lower Kensington", "Northern Liberties", "East Poplar",
        "West Poplar", "Spring Garden", "Francisville", "Callowhill", "Riverfront",
    ],
    "Kensington": [
        "Old Kensington", "East Kensington", "West Kensington", "Upper Kensington",
        "Fairhill", "Hartranft", "Ludlow", "Sharswood", "Franklinville",
    ],
    "Port Richmond": [
        "Port Richmond", "Richmond", "Bridesburg", "Wissinoming",
        "Juniata Park", "Harrowgate",
    ],
    "Fairmount & Brewerytown": [
        "Fairmount", "Brewerytown", "East Park", "West Park",
    ],
    "Strawberry Mansion & North Philly": [
        "Strawberry Mansion", "North Central", "Glenwood", "Nicetown",
        "Hunting Park", "Tioga", "Stanton", "Allegheny West", "Feltonville",
        "Yorktown", "Dunlap", "Logan",
    ],
    "West Philly": [
        "University City", "Spruce Hill", "Cedar Park", "Cobbs Creek",
        "Walnut Hill", "Garden Court", "Powelton", "West Powelton", "Mill Creek",
        "Mantua", "Haddington", "Haverford North", "Carroll Park", "Kingsessing",
        "Woodland Terrace", "Belmont", "East Parkside", "West Parkside",
    ],
    "Southwest Philly": [
        "Eastwick", "Elmwood", "Paschall", "Bartram Village", "Industrial",
        "Airport", "Penrose", "Southwest Schuylkill", "Overbrook",
        "Wynnefield", "Wynnefield Heights",
    ],
    "Germantown & Northwest": [
        "Germantown - Penn Knox", "Germantown - Morton", "Germantown - Westside",
        "West Central Germantown", "Southwest Germantown", "East Mount Airy",
        "West Mount Airy", "Chestnut Hill", "East Oak Lane", "West Oak Lane",
        "Wister", "Olney", "Cedarbrook", "Ogontz", "Fern Rock", "East Germantown",
    ],
    "Roxborough & Manayunk": [
        "Roxborough", "Roxborough Park", "Upper Roxborough", "Manayunk",
        "East Falls", "Andorra", "Wissahickon", "Wissahickon Park",
        "Wissahickon Hills", "Dearnley Park", "Germany Hill",
    ],
    "Northeast Philly": [
        "Mayfair", "Oxford Circle", "Rhawnhurst", "Northwood", "Lawndale",
        "Fox Chase", "Burholme", "Crescentville", "Frankford", "Holmesburg",
        "Torresdale", "West Torresdale", "Pennypack", "Pennypack Park",
        "Pennypack Woods", "Tacony", "Somerton", "Morrell Park", "Parkwood Manor",
        "Byberry", "Crestmont Farms", "Millbrook", "Winchester Park",
        "Melrose Park Gardens", "Franklin Mills", "Normandy Village", "Modena",
        "McGuire", "Clearview", "Academy Gardens", "Northeast Phila Airport",
        "Bustleton", "Summerdale", "Lexington Park", "Aston-Woodbridge",
    ],
}


def _all_points(feat_by_name: dict, names: list[str]) -> list[tuple[float, float]]:
    pts: list[tuple[float, float]] = []
    for name in names:
        feat = feat_by_name.get(name)
        if not feat:
            continue
        geom = feat["geometry"]
        if geom["type"] == "Polygon":
            for ring in geom["coordinates"]:
                pts.extend(ring)
        elif geom["type"] == "MultiPolygon":
            for poly in geom["coordinates"]:
                for ring in poly:
                    pts.extend(ring)
    return pts


def _cross(O, A, B):
    return (A[0] - O[0]) * (B[1] - O[1]) - (A[1] - O[1]) * (B[0] - O[0])


def _convex_hull(pts: list) -> list:
    pts = sorted(set(map(tuple, pts)))
    if len(pts) < 3:
        return pts
    lower: list = []
    for p in pts:
        while len(lower) >= 2 and _cross(lower[-2], lower[-1], p) <= 0:
            lower.pop()
        lower.append(p)
    upper: list = []
    for p in reversed(pts):
        while len(upper) >= 2 and _cross(upper[-2], upper[-1], p) <= 0:
            upper.pop()
        upper.append(p)
    return lower[:-1] + upper[:-1]


def _rdp(pts: list, tol: float) -> list:
    """Ramer-Douglas-Peucker simplification."""
    if len(pts) < 3:
        return pts
    a, b = pts[0], pts[-1]
    dx, dy = b[0] - a[0], b[1] - a[1]
    denom = math.hypot(dx, dy) or 1e-12
    dmax, idx = 0.0, 0
    for i in range(1, len(pts) - 1):
        p = pts[i]
        d = abs(dy * p[0] - dx * p[1] + b[0] * a[1] - b[1] * a[0]) / denom
        if d > dmax:
            dmax, idx = d, i
    if dmax > tol:
        l = _rdp(pts[:idx + 1], tol)
        r = _rdp(pts[idx:], tol)
        return l[:-1] + r
    return [pts[0], pts[-1]]


def build(geojson_path: str | None = None) -> None:
    if geojson_path:
        with open(geojson_path) as f:
            raw = json.load(f)
    else:
        print(f"Downloading {SOURCE_URL} …")
        with urllib.request.urlopen(SOURCE_URL) as resp:
            raw = json.load(resp)

    feat_by_name = {f["properties"]["name"]: f for f in raw["features"]}

    # Warn about any names in DISTRICT_MAP that aren't in the source data.
    all_source = set(feat_by_name)
    for d, names in DISTRICT_MAP.items():
        for n in names:
            if n not in all_source:
                print(f"  WARNING: '{n}' not found in source (district: {d})")

    districts = []
    for dname, members in DISTRICT_MAP.items():
        pts = _all_points(feat_by_name, members)
        if not pts:
            print(f"  SKIP: no polygon data for '{dname}'")
            continue
        hull = _convex_hull(pts)
        # RDP on the open hull (first != last), then close manually.
        # Passing a closed ring (first == last) to RDP collapses it to 2 pts.
        simplified = _rdp(hull, tol=0.0005)
        poly = [[round(p[0], 5), round(p[1], 5)] for p in (simplified + [simplified[0]])]
        lats = [p[1] for p in poly]
        lngs = [p[0] for p in poly]
        bounds = {
            "north": round(max(lats), 5), "south": round(min(lats), 5),
            "east": round(max(lngs), 5),  "west": round(min(lngs), 5),
        }
        center = {
            "lat": round((bounds["north"] + bounds["south"]) / 2, 5),
            "lng": round((bounds["east"]  + bounds["west"])  / 2, 5),
        }
        slug = (dname.lower()
                .replace(" & ", "-").replace(", ", "-")
                .replace(" ", "-").replace(",", ""))
        districts.append({
            "name": dname, "slug": slug,
            "center": center, "bounds": bounds,
            "polygon": [poly],
        })
        print(f"  {dname}: {len(pts)} pts → {len(hull)} hull → {len(simplified)} verts")

    with open(OUT_PATH, "w") as f:
        json.dump(districts, f, separators=(",", ":"))
    print(f"\nWrote {len(districts)} districts → {OUT_PATH}  ({OUT_PATH.stat().st_size:,} bytes)")


if __name__ == "__main__":
    src = sys.argv[1] if len(sys.argv) > 1 else None
    build(src)
