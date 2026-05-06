#!/usr/bin/env python3
"""Build frontend/public/neighborhoods/philly.json from raw click_that_hood GeoJSON.

Downloads the Philadelphia GeoJSON (158 neighborhoods) and merges them into
12 major districts via true polygon union, producing clean non-overlapping
district boundaries.

Usage:
  python3 scripts/build_philly_districts.py
  # or with a local file:
  python3 scripts/build_philly_districts.py /tmp/philadelphia.geojson

Source:
  https://raw.githubusercontent.com/codeforgermany/click_that_hood/main/public/data/philadelphia.geojson
"""
import json
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


def _geom_to_rings(geom: dict) -> list:
    """Extract outer rings from a GeoJSON Polygon or MultiPolygon geometry."""
    rings = []
    if geom["type"] == "Polygon":
        if geom["coordinates"]:
            rings.append(geom["coordinates"][0])
    elif geom["type"] == "MultiPolygon":
        for poly in geom["coordinates"]:
            if poly:
                rings.append(poly[0])
    return rings


def _rings_to_output(rings: list) -> list:
    """Round coordinates to 5 decimal places."""
    return [[[round(c[0], 5), round(c[1], 5)] for c in ring] for ring in rings]


def build(geojson_path: str | None = None) -> None:
    from shapely.geometry import Polygon, shape
    from shapely.ops import unary_union

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

    merged_by_district = []
    for dname, members in DISTRICT_MAP.items():
        # Collect shapely geometries for all member neighborhoods.
        shapes = []
        for n in members:
            feat = feat_by_name.get(n)
            if feat:
                try:
                    shapes.append(shape(feat["geometry"]))
                except Exception:
                    pass
        if not shapes:
            print(f"  SKIP: no polygon data for '{dname}'")
            continue

        # True polygon union — each major district is built from exact source
        # neighborhood geometry rather than bounding boxes or convex hulls.
        merged = unary_union(shapes)
        # Do not simplify here. Even topology-preserving simplification can
        # nudge shared borders enough to create visible slivers or overlaps
        # between adjacent districts.
        merged_by_district.append((dname, len(shapes), merged))

    def polygon_pieces(geom):
        if geom.is_empty:
            return []
        if geom.geom_type == "Polygon":
            return [geom]
        if geom.geom_type == "MultiPolygon":
            return list(geom.geoms)
        if geom.geom_type == "GeometryCollection":
            pieces = []
            for g in geom.geoms:
                pieces.extend(polygon_pieces(g))
            return pieces
        return []

    districts = []
    for dname, shape_count, merged in merged_by_district:
        # Extract outer rings from the result (Polygon or MultiPolygon).
        pieces = polygon_pieces(merged)
        if not pieces:
            print(f"  SKIP: no remaining polygon pieces for '{dname}'")
            continue

        rings_out = []
        multi_polygon_out = []
        for piece in pieces:
            if not isinstance(piece, Polygon) or piece.area <= 0:
                continue
            exterior = [[round(c[0], 5), round(c[1], 5)] for c in piece.exterior.coords]
            holes = [
                [[round(c[0], 5), round(c[1], 5)] for c in interior.coords]
                for interior in piece.interiors
            ]
            rings_out.append(exterior)
            multi_polygon_out.append([exterior, *holes])
        if not rings_out:
            print(f"  SKIP: no exterior rings for '{dname}'")
            continue

        all_lats = [c[1] for ring in rings_out for c in ring]
        all_lngs = [c[0] for ring in rings_out for c in ring]
        bounds = {
            "north": round(max(all_lats), 5), "south": round(min(all_lats), 5),
            "east":  round(max(all_lngs), 5), "west":  round(min(all_lngs), 5),
        }
        centroid = merged.centroid
        center = {"lat": round(centroid.y, 5), "lng": round(centroid.x, 5)}
        slug = (dname.lower()
                .replace(" & ", "-").replace(", ", "-")
                .replace(" ", "-").replace(",", ""))
        total_verts = sum(len(r) for r in rings_out)
        districts.append({
            "name": dname, "slug": slug,
            "center": center, "bounds": bounds,
            "polygon": rings_out,
            "multiPolygon": multi_polygon_out,
        })
        print(f"  {dname}: {shape_count} neighborhoods → {len(rings_out)} piece(s), {total_verts} verts")

    with open(OUT_PATH, "w") as f:
        json.dump(districts, f, separators=(",", ":"))
    print(f"\nWrote {len(districts)} districts → {OUT_PATH}  ({OUT_PATH.stat().st_size:,} bytes)")


if __name__ == "__main__":
    src = sys.argv[1] if len(sys.argv) > 1 else None
    build(src)
