"""Free, public incident-source ingestion for CityPulse.

This module replaces the retired Broadcastify/Whisper/Lambda path with
structured government data.  It intentionally publishes less detail than the
upstream records: house numbers become block locations, coordinates are
rounded to roughly a city block, sensitive calls are suppressed, and medical
descriptions are generalized.
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import logging
import math
import os
import re
import signal
import xml.etree.ElementTree as ET
from dataclasses import dataclass, replace
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path
from typing import Any, Iterable
from zoneinfo import ZoneInfo

import httpx
from bs4 import BeautifulSoup

from . import city_registry, geocode, persistence as store, weights

logger = logging.getLogger(__name__)

CHATTANOOGA_URL = "https://hc911server.com/api/calls"
SF_POLICE_URL = "https://data.sfgov.org/resource/gnap-fj3t.json"
SF_FIRE_URL = "https://data.sfgov.org/resource/nuek-vuh3.json"
PHILLY_CRIME_URL = "https://phl.carto.com/api/v2/sql"
MONTCO_CAD_URL = "https://webapp07.montcopa.org/eoc/cadinfo/livecadrss.asp"
CHESCO_CAD_URL = "https://webcad.chesco.org/WebCad/"
NOTIFY_NYC_URL = "https://feeds.everbridge.net/feeds/453003085617722/rss/rss.xml"

SOURCE_INTERVAL_SECONDS = {
    "hc911": 60,
    "datasf-police": 600,
    "datasf-fire": 600,
    "phl-police": 900,
    "montco-cad": 120,
    "chesco-cad": 120,
    "notify-nyc": 120,
}

SOURCE_LABELS = {
    "hc911": "Hamilton County 911 CAD",
    "datasf-police": "DataSF Police CAD",
    "datasf-fire": "San Francisco Fire Department Calls",
    "phl-police": "Philadelphia Police Incidents",
    "montco-cad": "Montgomery County Live CAD",
    "chesco-cad": "Chester County Live CAD",
    "notify-nyc": "Notify NYC",
}

_PACIFIC = ZoneInfo("America/Los_Angeles")
_EASTERN = ZoneInfo("America/New_York")
_MAX_SOURCE_AGE = timedelta(hours=72)

_SENSITIVE_RE = re.compile(
    r"\b(?:amber alert|silver alert|missing (?:child|minor|juvenile|person|"
    r"vulnerable|student)|child abduction|juvenile|minor|sexual|rape|domestic|"
    r"suicid(?:e|al)|mental health|emotionally disturbed|well[- ]?being check|"
    r"welfare check|overdose|5150)\b",
    re.IGNORECASE,
)
_ADMIN_RE = re.compile(
    r"\b(?:supplemental reports?|property check|administrative|test call|"
    r"planned flyover|drill|exercise|alarm system - unnecessary)\b",
    re.IGNORECASE,
)
_MEDICAL_RE = re.compile(
    r"\b(?:ems|medical|medic|patient|cardiac|unconscious|respiratory|"
    r"seizure|syncopal|injur(?:y|ies|ed)|fall victim|lift assist)\b",
    re.IGNORECASE,
)


@dataclass(frozen=True)
class PublicIncident:
    source_id: str
    source_key: str
    city: str
    reported_at: str
    event_type: str
    location_text: str | None
    lat: float | None = None
    lng: float | None = None
    status: str | None = None
    severity_category: str | None = None

    @property
    def incident_id(self) -> str:
        digest = hashlib.sha256(
            f"{self.source_id}\x1f{self.source_key}".encode("utf-8")
        ).hexdigest()[:24]
        return f"public-{digest}"


def _utc_iso(value: str, default_zone: ZoneInfo | timezone = timezone.utc) -> str:
    raw = str(value or "").strip()
    if not raw:
        raise ValueError("timestamp is empty")
    if raw.endswith("Z"):
        raw = raw[:-1] + "+00:00"
    parsed = datetime.fromisoformat(raw)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=default_zone)
    return parsed.astimezone(timezone.utc).isoformat()


def _local_utc_iso(value: str, fmt: str, zone: ZoneInfo) -> str:
    parsed = datetime.strptime(value.strip(), fmt).replace(tzinfo=zone)
    return parsed.astimezone(timezone.utc).isoformat()


def _safe_float(value: Any) -> float | None:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    return parsed if math.isfinite(parsed) and -180 <= parsed <= 180 else None


def public_coordinates(lat: Any, lng: Any) -> tuple[float | None, float | None]:
    """Round coordinates to approximately 80–110 metres in supported cities."""
    parsed_lat = _safe_float(lat)
    parsed_lng = _safe_float(lng)
    if parsed_lat is None or parsed_lng is None:
        return None, None
    if not (-90 <= parsed_lat <= 90):
        return None, None
    return round(parsed_lat, 3), round(parsed_lng, 3)


def public_location(value: Any) -> str | None:
    """Remove unit details and reduce a street address to a hundred block."""
    if not isinstance(value, str):
        return None
    text = " ".join(value.replace("\\", " & ").replace("/", " & ").split())
    text = re.sub(
        r"\s+(?:APT|APARTMENT|UNIT|SUITE|RM|ROOM|#)\s*[A-Z0-9-]+\b.*$",
        "",
        text,
        flags=re.IGNORECASE,
    )
    if not text:
        return None
    if re.match(r"^\d+\s+BLOCK\b", text, re.IGNORECASE):
        return text[:180]
    match = re.match(r"^(\d{1,6})\s+(.+)$", text)
    if match:
        number = int(match.group(1))
        block = "unit block" if number < 100 else f"{number // 100 * 100} block"
        text = f"{block} {match.group(2)}"
    return text[:180]


def _is_sensitive(text: str) -> bool:
    return bool(_SENSITIVE_RE.search(text or ""))


def classify_event(event_type: str) -> str | None:
    """Map public-source event labels onto CityPulse's fixed severity enum."""
    text = " ".join((event_type or "").split()).lower()
    if not text or _is_sensitive(text) or _ADMIN_RE.search(text):
        return None
    if "no weapon" in text and any(word in text for word in ("assault", "fight")):
        return "violent_no_weapon"
    if any(word in text for word in ("shoot", "shots", "firearm", "weapon", "stab", "homicide")):
        return "violent_weapon"
    if "robbery" in text:
        return "robbery"
    if any(word in text for word in ("burglary", "breaking and entering")):
        return "burglary_in_progress"
    if any(word in text for word in ("assault", "fight")):
        return "violent_no_weapon"
    if any(word in text for word in ("fire", "hazmat", "gas leak", "explosion", "smoke")):
        return "fire_hazmat"
    if any(word in text for word in ("vehicle accident", "collision", "traffic crash", "mva")):
        return "traffic_crash_injury" if "injur" in text else "traffic_crash_no_injury"
    if _MEDICAL_RE.search(text):
        if any(word in text for word in ("cardiac", "unconscious", "respiratory", "priority 1")):
            return "medical_priority"
        return "medical_other"
    if any(
        word in text
        for word in (
            "police activity",
            "disorder",
            "theft",
            "vandal",
            "trespass",
            "disturbance",
            "suspicious",
        )
    ):
        return "disorder"
    if any(word in text for word in ("structural incident", "building collapse")):
        return "fire_hazmat"
    return None


def public_description(event_type: str, category: str) -> str:
    if category in {"medical_priority", "medical_other"}:
        return "Medical response"
    return " ".join((event_type or "").split())[:180]


def _incident(
    *,
    source_id: str,
    source_key: Any,
    city: str,
    reported_at: str,
    event_type: str,
    location_text: Any,
    lat: Any = None,
    lng: Any = None,
    status: Any = None,
    classification_text: str | None = None,
) -> PublicIncident | None:
    normalized_key = str(source_key).strip() if source_key is not None else ""
    if not normalized_key:
        return None
    combined = classification_text or f"{event_type} {status or ''}"
    category = classify_event(combined)
    if category is None:
        return None
    rounded_lat, rounded_lng = public_coordinates(lat, lng)
    return PublicIncident(
        source_id=source_id,
        source_key=normalized_key,
        city=city,
        reported_at=reported_at,
        event_type=public_description(event_type, category),
        location_text=public_location(location_text),
        lat=rounded_lat,
        lng=rounded_lng,
        status=str(status).strip()[:80] if status else None,
        severity_category=category,
    )


def parse_chattanooga(rows: Iterable[dict[str, Any]]) -> list[PublicIncident]:
    incidents: list[PublicIncident] = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        event_type = str(row.get("type_description") or row.get("type") or "")
        if row.get("agency_type") == "EMS":
            event_type = f"Medical response {event_type}"
        try:
            # Hamilton County emits local wall-clock values with a misleading
            # trailing "Z". Strip it and apply the source's Eastern zone.
            raw_time = str(row.get("creation") or "").removesuffix("Z")
            reported_at = _utc_iso(raw_time, _EASTERN)
        except ValueError:
            continue
        parsed = _incident(
            source_id="hc911",
            source_key=row.get("master_incident_id") or row.get("sequencenumber") or row.get("id"),
            city="chattanooga",
            reported_at=reported_at,
            event_type=event_type,
            location_text=row.get("location"),
            lat=row.get("latitude"),
            lng=row.get("longitude"),
            status=row.get("status"),
        )
        if parsed:
            incidents.append(parsed)
    return incidents


def parse_sf_police(rows: Iterable[dict[str, Any]]) -> list[PublicIncident]:
    incidents: list[PublicIncident] = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        sensitive = row.get("sensitive_call")
        if sensitive is True or str(sensitive).lower() == "true":
            continue
        point = row.get("intersection_point") or {}
        coords = point.get("coordinates") if isinstance(point, dict) else None
        try:
            reported_at = _utc_iso(str(row.get("received_datetime") or ""), _PACIFIC)
        except ValueError:
            continue
        parsed = _incident(
            source_id="datasf-police",
            source_key=row.get("id") or row.get("cad_number"),
            city="sf",
            reported_at=reported_at,
            event_type=str(row.get("call_type_final_desc") or row.get("call_type_original_desc") or ""),
            location_text=row.get("intersection_name"),
            lat=coords[1] if isinstance(coords, list) and len(coords) == 2 else None,
            lng=coords[0] if isinstance(coords, list) and len(coords) == 2 else None,
            status=row.get("disposition"),
        )
        if parsed:
            incidents.append(parsed)
    return incidents


def parse_sf_fire(rows: Iterable[dict[str, Any]]) -> list[PublicIncident]:
    incidents: list[PublicIncident] = []
    seen: set[str] = set()
    for row in rows:
        if not isinstance(row, dict):
            continue
        source_key = str(row.get("incident_number") or row.get("call_number") or "")
        if not source_key or source_key in seen:
            continue
        seen.add(source_key)
        point = row.get("case_location") or {}
        coords = point.get("coordinates") if isinstance(point, dict) else None
        try:
            reported_at = _utc_iso(str(row.get("received_dttm") or ""), _PACIFIC)
        except ValueError:
            continue
        parsed = _incident(
            source_id="datasf-fire",
            source_key=source_key,
            city="sf",
            reported_at=reported_at,
            event_type=str(row.get("call_type") or ""),
            location_text=row.get("address"),
            lat=coords[1] if isinstance(coords, list) and len(coords) == 2 else None,
            lng=coords[0] if isinstance(coords, list) and len(coords) == 2 else None,
            status=row.get("call_final_disposition"),
        )
        if parsed:
            incidents.append(parsed)
    return incidents


def parse_philly(rows: Iterable[dict[str, Any]]) -> list[PublicIncident]:
    incidents: list[PublicIncident] = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        try:
            reported_at = _utc_iso(str(row.get("dispatch_date_time") or ""))
        except ValueError:
            continue
        parsed = _incident(
            source_id="phl-police",
            source_key=row.get("dc_key") or row.get("objectid"),
            city="philly",
            reported_at=reported_at,
            event_type=str(row.get("text_general_code") or ""),
            location_text=row.get("location_block"),
            lat=row.get("point_y"),
            lng=row.get("point_x"),
        )
        if parsed:
            incidents.append(parsed)
    return incidents


def parse_montco(xml_text: str) -> list[PublicIncident]:
    incidents: list[PublicIncident] = []
    root = ET.fromstring(xml_text)
    for item in root.findall("./channel/item"):
        title = (item.findtext("title") or "").strip()
        description = (item.findtext("description") or "").strip()
        parts = [part.strip() for part in description.split(";") if part.strip()]
        if len(parts) < 3:
            continue
        time_match = re.search(r"\d{4}-\d{2}-\d{2}\s+@\s+\d{2}:\d{2}:\d{2}", description)
        if not time_match:
            continue
        try:
            reported_at = _local_utc_iso(time_match.group(), "%Y-%m-%d @ %H:%M:%S", _EASTERN)
        except ValueError:
            continue
        event_type = title.replace("EMS:", "Medical response:", 1)
        parsed = _incident(
            source_id="montco-cad",
            source_key=f"{title}|{parts[0]}|{time_match.group()}",
            city="philly",
            reported_at=reported_at,
            event_type=event_type,
            location_text=f"{parts[0]}, {parts[1]}",
        )
        if parsed:
            incidents.append(parsed)
    return incidents


def parse_chesco(html_text: str) -> list[PublicIncident]:
    incidents: list[PublicIncident] = []
    soup = BeautifulSoup(html_text, "html.parser")
    for table in soup.select("table.main"):
        for row in table.select("tr"):
            cells = [" ".join(cell.get_text(" ", strip=True).split()) for cell in row.select("td")]
            if len(cells) != 6 or cells[0].lower().startswith("incident"):
                continue
            incident_number, event_type, location, municipality, dispatch_time, _unit = cells
            try:
                reported_at = _local_utc_iso(dispatch_time, "%m-%d-%Y %H:%M:%S", _EASTERN)
            except ValueError:
                continue
            parsed = _incident(
                source_id="chesco-cad",
                source_key=incident_number,
                city="philly",
                reported_at=reported_at,
                event_type=event_type,
                location_text=f"{location}, {municipality}",
            )
            if parsed:
                incidents.append(parsed)
    return incidents


_NYC_BOROUGHS = r"(?:Manhattan|Brooklyn|Queens|Bronx|Staten Island)"


def _nyc_location(title: str, description: str) -> str | None:
    for pattern in (
        rf"\bin the area of (.+?) in {_NYC_BOROUGHS}\b",
        rf"\bon (.+?) in {_NYC_BOROUGHS}\b",
        rf"\bnear (.+?) in {_NYC_BOROUGHS}\b",
    ):
        match = re.search(pattern, description, flags=re.IGNORECASE)
        if match:
            return match.group(1).strip(" .")
    parts = [part.strip() for part in title.split(" - ") if part.strip()]
    if len(parts) >= 3:
        return parts[-1]
    return None


def parse_notify_nyc(xml_text: str) -> list[PublicIncident]:
    incidents: list[PublicIncident] = []
    root = ET.fromstring(xml_text)
    for item in root.findall("./channel/item"):
        title = (item.findtext("title") or "").strip()
        description = " ".join((item.findtext("description") or "").split())
        combined = f"{title} {description}"
        if _is_sensitive(combined):
            continue
        pub_date = item.findtext("pubDate")
        try:
            reported_at = (
                parsedate_to_datetime(pub_date).astimezone(timezone.utc).isoformat()
                if pub_date
                else _utc_iso(datetime.now(timezone.utc).isoformat())
            )
        except (TypeError, ValueError):
            continue
        event_type = title.removeprefix("Notify NYC - ").split(" - ", 1)[0]
        parsed = _incident(
            source_id="notify-nyc",
            source_key=item.findtext("guid") or item.findtext("link") or f"{title}|{reported_at}",
            city="nyc",
            reported_at=reported_at,
            event_type=event_type,
            location_text=_nyc_location(title, description),
            classification_text=combined,
        )
        if parsed:
            incidents.append(parsed)
    return incidents


async def fetch_source(client: httpx.AsyncClient, source_id: str) -> list[PublicIncident]:
    if source_id == "hc911":
        response = await client.get(
            CHATTANOOGA_URL,
            headers={"X-Frontend-Auth": "my-secure-token"},
        )
        response.raise_for_status()
        return parse_chattanooga(response.json())
    if source_id == "datasf-police":
        response = await client.get(
            SF_POLICE_URL,
            params={"$limit": "500", "$order": "received_datetime DESC"},
        )
        response.raise_for_status()
        return parse_sf_police(response.json())
    if source_id == "datasf-fire":
        response = await client.get(
            SF_FIRE_URL,
            params={"$limit": "500", "$order": "received_dttm DESC"},
        )
        response.raise_for_status()
        return parse_sf_fire(response.json())
    if source_id == "phl-police":
        query = (
            "select dc_key, objectid, dispatch_date_time, location_block, "
            "text_general_code, point_x, point_y from incidents_part1_part2 "
            "where dispatch_date_time is not null and point_x is not null "
            "and point_y is not null order by dispatch_date_time desc limit 500"
        )
        response = await client.get(PHILLY_CRIME_URL, params={"q": query})
        response.raise_for_status()
        return parse_philly(response.json().get("rows", []))
    if source_id == "montco-cad":
        response = await client.get(MONTCO_CAD_URL)
        response.raise_for_status()
        return parse_montco(response.text)
    if source_id == "chesco-cad":
        response = await client.get(CHESCO_CAD_URL)
        response.raise_for_status()
        return parse_chesco(response.text)
    if source_id == "notify-nyc":
        response = await client.get(NOTIFY_NYC_URL)
        response.raise_for_status()
        return parse_notify_nyc(response.text)
    raise ValueError(f"Unknown public source: {source_id}")


class SeenState:
    """Small durable idempotency cache; Firestore create remains the final guard."""

    def __init__(self, path: Path | None):
        self.path = path
        self.ids: set[str] = set()
        if path and path.exists():
            try:
                payload = json.loads(path.read_text(encoding="utf-8"))
                self.ids = {str(value) for value in payload.get("ids", [])}
            except (OSError, ValueError, TypeError):
                logger.warning("Ignoring invalid public-source state file %s", path)

    def __contains__(self, incident_id: str) -> bool:
        return incident_id in self.ids

    def add(self, incident_id: str) -> None:
        self.ids.add(incident_id)

    def save(self) -> None:
        if not self.path:
            return
        self.path.parent.mkdir(parents=True, exist_ok=True)
        values = sorted(self.ids)[-50_000:]
        temp = self.path.with_suffix(".tmp")
        temp.write_text(json.dumps({"ids": values}), encoding="utf-8")
        os.replace(temp, self.path)


async def _geocode_if_needed(incident: PublicIncident) -> PublicIncident:
    if incident.lat is not None and incident.lng is not None:
        return incident
    if not incident.location_text:
        return incident
    registry = city_registry.CITY_REGISTRY.get(incident.city) or {}
    geo_ctx = {
        "suffix": registry.get("geocode_suffix", ""),
        "viewbox": registry.get("viewbox", ""),
        "bounds": registry.get("bounds", {}),
    }
    result = await geocode.geocode(
        incident.location_text,
        geo_ctx=geo_ctx,
        city=incident.city,
    )
    if not result:
        return incident
    lat, lng = public_coordinates(result[0], result[1])
    return replace(incident, lat=lat, lng=lng)


def _is_recent(incident: PublicIncident, now: datetime) -> bool:
    try:
        reported = datetime.fromisoformat(incident.reported_at)
        if reported.tzinfo is None:
            reported = reported.replace(tzinfo=timezone.utc)
    except ValueError:
        return False
    age = now - reported.astimezone(timezone.utc)
    return -timedelta(minutes=10) <= age <= _MAX_SOURCE_AGE


async def persist_incidents(
    incidents: Iterable[PublicIncident],
    seen: SeenState,
    *,
    now: datetime | None = None,
) -> tuple[int, int]:
    created = 0
    skipped = 0
    current = now or datetime.now(timezone.utc)
    for original in incidents:
        if original.incident_id in seen or not _is_recent(original, current):
            skipped += 1
            continue
        incident = await _geocode_if_needed(original)
        category = incident.severity_category
        if not category:
            skipped += 1
            seen.add(incident.incident_id)
            continue
        saved = await asyncio.to_thread(
            store.insert_incident,
            incident_id=incident.incident_id,
            raw_text=incident.event_type,
            severity_category=category,
            s_base=weights.get_s_base(category),
            confidence=1.0,
            location_text=incident.location_text,
            lat=incident.lat,
            lng=incident.lng,
            geocode_status="source" if incident.lat is not None else "failed",
            location_confidence="medium" if incident.lat is not None else "none",
            inhibitor_status="passed",
            inhibitor_reason="structured public source; privacy reduced",
            reported_at=incident.reported_at,
            ingested_at=current.isoformat(),
            audio_clip=None,
            feed_id=incident.source_id,
            description=incident.event_type,
            unit_status=incident.status,
            word_timings=None,
            city=incident.city,
            mentions=[],
        )
        seen.add(incident.incident_id)
        if saved.pop("_was_created", True):
            created += 1
        else:
            skipped += 1
    seen.save()
    return created, skipped


async def poll_sources(
    source_ids: Iterable[str],
    *,
    once: bool,
    state_path: Path | None,
) -> None:
    selected = list(dict.fromkeys(source_ids))
    unknown = [source for source in selected if source not in SOURCE_INTERVAL_SECONDS]
    if unknown:
        raise ValueError(f"Unknown public source(s): {', '.join(unknown)}")

    seen = SeenState(state_path)
    due_at = {source: 0.0 for source in selected}
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, stop.set)
        except NotImplementedError:  # pragma: no cover - Windows
            pass

    timeout = httpx.Timeout(connect=15, read=30, write=15, pool=15)
    headers = {"User-Agent": "CityPulse/2.0 (+https://phlpulse.com)"}
    async with httpx.AsyncClient(timeout=timeout, follow_redirects=True, headers=headers) as client:
        while not stop.is_set():
            monotonic_now = loop.time()
            due = [source for source in selected if due_at[source] <= monotonic_now]
            for source in due:
                try:
                    incidents = await fetch_source(client, source)
                    created, skipped = await persist_incidents(incidents, seen)
                    logger.info(
                        "%s: fetched=%d created=%d skipped=%d",
                        source,
                        len(incidents),
                        created,
                        skipped,
                    )
                except Exception:
                    logger.exception("Public source %s poll failed", source)
                finally:
                    due_at[source] = loop.time() + SOURCE_INTERVAL_SECONDS[source]
            if once:
                return
            next_due = min(due_at.values(), default=loop.time() + 60)
            wait_seconds = max(1.0, min(60.0, next_due - loop.time()))
            try:
                await asyncio.wait_for(stop.wait(), timeout=wait_seconds)
            except asyncio.TimeoutError:
                pass


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--sources",
        default="all",
        help="Comma-separated source IDs, or 'all' (default).",
    )
    parser.add_argument("--once", action="store_true", help="Poll each selected source once.")
    parser.add_argument(
        "--state",
        type=Path,
        default=Path(
            os.environ.get(
                "CITYPULSE_PUBLIC_SOURCE_STATE",
                "/var/lib/citypulse-public-sources/state.json",
            )
        ),
    )
    return parser.parse_args()


def main() -> None:
    args = _parse_args()
    logging.basicConfig(
        level=os.environ.get("LOG_LEVEL", "INFO").upper(),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    sources = (
        list(SOURCE_INTERVAL_SECONDS)
        if args.sources.strip().lower() == "all"
        else [value.strip() for value in args.sources.split(",") if value.strip()]
    )
    asyncio.run(poll_sources(sources, once=args.once, state_path=args.state))


if __name__ == "__main__":
    main()
