#!/usr/bin/env python3
"""Convert raw GeoJSON neighborhood data into the slim per-city JSON
files our app's `frontend/src/lib/neighborhoods.ts` consumes.

We deliberately ship a *preprocessed* JSON rather than the raw
GeoJSON because:
  - Raw open-data exports are fat (Socrata GeoJSON for NYC NTAs is
    ~4MB; we ship ~700KB after dropping unused props + rounding
    coords to 5 decimals).
  - The runtime helpers want a flat `Neighborhood[]` shape — no
    GeoJSON parsing, no `properties.NTAName` vs `properties.name`
    case branching at runtime.
  - Lazy-loaded per active city (see `loadCityNeighborhoods` in
    the runtime module), so any one user only ever downloads the
    file for *their* city.

Add a new city by:
  1. Drop a raw GeoJSON file in `/tmp/<city>.geojson` (or wherever).
     The `click_that_hood` mirror is a great public source:
       https://github.com/codeforgermany/click_that_hood/tree/main/public/data
  2. Add a `convert(...)` call below pointing at it and the desired
     output path under `frontend/public/neighborhoods/<slug>.json`.
  3. Run this script. Commit the JSON file alongside the slug entry
     in `lib/neighborhoods.ts`.

Output JSON shape (matches `Neighborhood[]` in the TS module):
  [
    {
      "name": "Mission",
      "slug": "mission",
      "center": {"lat": 37.76, "lng": -122.42},
      "bounds": {"north": ..., "south": ..., "east": ..., "west": ...},
      "polygon": [ [[lng,lat], [lng,lat], ...], ... ]
    },
    ...
  ]

The `polygon` field is an array of *outer* rings — for a
MultiPolygon source, one ring per piece. The runtime
`pointInNeighborhood` test ORs across rings, so a multi-piece
neighborhood like SF's Marina (waterfront + multiple islands) is
treated as the union of its parts.
"""
import json
import re
import sys
from pathlib import Path


def slugify(name: str) -> str:
    s = name.lower().strip()
    s = re.sub(r"[^a-z0-9]+", "-", s)
    return s.strip("-")


def ring_bbox(ring):
    lats = [p[1] for p in ring]
    lngs = [p[0] for p in ring]
    return {
        "north": max(lats),
        "south": min(lats),
        "east": max(lngs),
        "west": min(lngs),
    }


def merge_bbox(a, b):
    return {
        "north": max(a["north"], b["north"]),
        "south": min(a["south"], b["south"]),
        "east": max(a["east"], b["east"]),
        "west": min(a["west"], b["west"]),
    }


def feature_to_neighborhood(feat, prefix=None):
    props = feat.get("properties") or {}
    name = props.get("name") or props.get("Name") or props.get("NAME") or props.get("NTAName")
    if not name:
        return None
    if prefix:
        name = f"{name} ({prefix})"
    geom = feat.get("geometry") or {}
    gtype = geom.get("type")
    coords = geom.get("coordinates")
    if not gtype or not coords:
        return None

    rings = []
    if gtype == "Polygon":
        if coords:
            rings.append(coords[0])
    elif gtype == "MultiPolygon":
        for poly in coords:
            if poly:
                rings.append(poly[0])
    else:
        return None

    if not rings:
        return None

    bbox = ring_bbox(rings[0])
    for r in rings[1:]:
        bbox = merge_bbox(bbox, ring_bbox(r))

    center = {
        "lat": (bbox["north"] + bbox["south"]) / 2,
        "lng": (bbox["east"] + bbox["west"]) / 2,
    }

    rings_rounded = [
        [[round(p[0], 5), round(p[1], 5)] for p in ring] for ring in rings
    ]

    return {
        "name": name,
        "slug": slugify(name),
        "center": {"lat": round(center["lat"], 5), "lng": round(center["lng"], 5)},
        "bounds": {k: round(v, 5) for k, v in bbox.items()},
        "polygon": rings_rounded,
    }


def convert(in_paths, out_path):
    """`in_paths` is a list of (raw_geojson_path, optional_name_prefix)."""
    out = []
    for path, prefix in in_paths:
        with open(path) as f:
            data = json.load(f)
        for feat in data.get("features", []):
            n = feature_to_neighborhood(feat, prefix=prefix)
            if n:
                out.append(n)
    with open(out_path, "w") as f:
        json.dump(out, f, separators=(",", ":"))
    print(f"wrote {len(out)} neighborhoods to {out_path} ({Path(out_path).stat().st_size:,} bytes)")


# --- City builds --------------------------------------------------------------
# Keep these calls reproducible. Each one downloads / converts independently;
# you can comment all but one out while iterating on a single city.

def build_sf():
    convert(
        [("/tmp/sf.geojson", None)],
        "frontend/public/neighborhoods/sf.json",
    )


def build_nyc():
    # click_that_hood splits NYC by borough — we combine them and tag each
    # neighborhood name with its borough since names like "Chinatown" recur.
    convert(
        [
            ("/tmp/manhattan.geojson",     "Manhattan"),
            ("/tmp/brooklyn.geojson",      "Brooklyn"),
            ("/tmp/queens.geojson",        "Queens"),
            ("/tmp/bronx.geojson",         "Bronx"),
            ("/tmp/staten-island.geojson", "Staten Island"),
        ],
        "frontend/public/neighborhoods/nyc.json",
    )


SOURCES = """
Source URLs (download to /tmp/ before running):
  SF:           https://raw.githubusercontent.com/codeforgermany/click_that_hood/main/public/data/san-francisco.geojson
  Manhattan:    https://raw.githubusercontent.com/codeforgermany/click_that_hood/main/public/data/manhattan.geojson
  Brooklyn:     https://raw.githubusercontent.com/codeforgermany/click_that_hood/main/public/data/brooklyn.geojson
  Queens:       https://raw.githubusercontent.com/codeforgermany/click_that_hood/main/public/data/queens.geojson
  Bronx:        https://raw.githubusercontent.com/codeforgermany/click_that_hood/main/public/data/bronx.geojson
  Staten Is.:   https://raw.githubusercontent.com/codeforgermany/click_that_hood/main/public/data/staten-island.geojson

Chattanooga: no clean public neighborhoods polygon source as of writing.
  When one becomes available (e.g. via chattadata.org), add a `build_chattanooga()`
  function above and a CITY_NEIGHBORHOODS["chattanooga"] entry in lib/neighborhoods.ts.
"""


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--sources":
        print(SOURCES)
        sys.exit(0)
    build_sf()
    build_nyc()
