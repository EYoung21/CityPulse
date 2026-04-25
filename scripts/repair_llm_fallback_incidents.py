#!/usr/bin/env python3
"""Repair incidents whose location was hallucinated by the old LLM-coord fallback.

Background: prior to the `incident_geocode_hallucination` fix, when Nominatim
failed to resolve an extracted address, the pipeline would fall back to the
LLM's predicted lat/lng. The LLM, prompted for coordinates it couldn't really
know, would hallucinate the city center — causing thousands of unrelated
incidents (status `llm_fallback_*`) to pile up at one point on the map.

This one-shot script:

  1. Queries Firestore for incidents with `geocode_status` starting with
     `llm_fallback`.
  2. Re-fetches the original transcript + feed_id + reported_at from the
     extractions collection (or, as a fallback, uses the incident's own
     stored `raw_text`).
  3. Pulls the same adjacent-radio prior context the live ingest path now
     uses (`adjacent_radio_context`), then re-runs `llm.extract_incident`.
  4. If a `location_text` comes back, retries Nominatim through the live
     `geocode.geocode()` helper.
       - Success → updates lat/lng + sets `geocode_status='success_repaired_*'`.
       - Failure → soft-hide path.
  5. Soft-hide path: sets `hidden=true` + `geocode_status='unmapped_repaired'`
     on the original incident, AND mirrors a row into a new
     `unmapped_incidents` admin queue for review. Stable IDs are preserved.

Usage (dry-run by default):

    python3 scripts/repair_llm_fallback_incidents.py
    python3 scripts/repair_llm_fallback_incidents.py --execute
    python3 scripts/repair_llm_fallback_incidents.py --execute --city philly
    python3 scripts/repair_llm_fallback_incidents.py --execute --limit 200

Idempotent: keyed by incident ID. Safe to re-run after a partial run.
Requires GOOGLE_APPLICATION_CREDENTIALS or FIREBASE_SERVICE_ACCOUNT_JSON
in the environment, and OPENAI_API_KEY.
"""

from __future__ import annotations

import argparse
import asyncio
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

from philly_pulse import geocode, llm  # noqa: E402
from philly_pulse import persistence as store  # noqa: E402
from philly_pulse.city_registry import CITY_REGISTRY, FEED_LABELS, load_city_registry  # noqa: E402


def _feed_label(feed_id: str | None) -> str | None:
    if not feed_id:
        return None
    return FEED_LABELS.get(str(feed_id).strip())


def _llm_ctx(city: str | None) -> dict | None:
    if not city:
        return None
    return CITY_REGISTRY.get(city)


def _geo_ctx(city: str | None) -> dict | None:
    if not city:
        return None
    entry = CITY_REGISTRY.get(city)
    if not entry:
        return None
    return {
        "viewbox": entry["viewbox"],
        "bounds": entry["bounds"],
        "suffix": entry["geocode_suffix"],
    }


# ── Firestore queries ─────────────────────────────────────────────────


def _get_db():
    """Reuse the same client the rest of the app uses."""
    from philly_pulse.firestore_store import _ensure_client
    return _ensure_client()


def _iter_llm_fallback_incidents(city: str | None, limit: int | None):
    """Stream incidents needing repair.

    `geocode_status` is a flat string, so we use a range query
    [llm_fallback, llm_fallback~) which catches `llm_fallback`,
    `llm_fallback_direct`, `llm_fallback_context`, `llm_fallback_none`,
    and any future `llm_fallback_*` variant. The ~ char sorts after _.
    """
    from google.cloud import firestore as gcf  # type: ignore

    db = _get_db()
    q = (
        db.collection("incidents")
        .where("geocode_status", ">=", "llm_fallback")
        .where("geocode_status", "<", "llm_fallback~")
        .order_by("geocode_status")
        .order_by("__name__")
    )
    if city:
        # Keep the range filter on geocode_status; chain a city equality.
        # Firestore allows multiple equality filters alongside one range.
        q = q.where("city", "==", city)
    if limit:
        q = q.limit(int(limit))

    for snap in q.stream():
        data = snap.to_dict() or {}
        yield snap.id, snap.reference, data


def _find_extraction_for_incident(incident_id: str) -> dict | None:
    """Best-effort: extractions track `incident_id` for non-blocked rows."""
    db = _get_db()
    try:
        snap_iter = (
            db.collection("extractions")
            .where("incident_id", "==", incident_id)
            .limit(1)
            .stream()
        )
        for snap in snap_iter:
            data = snap.to_dict() or {}
            return {"id": snap.id, **data}
    except Exception:
        pass
    return None


# ── Repair logic ──────────────────────────────────────────────────────


async def _repair_one(incident_id: str, ref, data: dict, *, dry_run: bool) -> str:
    """Repair a single incident. Returns a short outcome string."""
    city = data.get("city")
    raw_text = data.get("raw_text") or ""
    feed_id = data.get("feed_id") or ""
    reported_at = data.get("reported_at") or ""

    extraction = _find_extraction_for_incident(incident_id)
    if extraction:
        raw_text = extraction.get("raw_text") or raw_text
        feed_id = extraction.get("feed_id") or feed_id
        reported_at = extraction.get("reported_at") or reported_at
        city = extraction.get("city") or city

    if not raw_text.strip():
        return "skip_no_transcript"

    prior_context: list[str] = []
    if feed_id and reported_at:
        try:
            recent = store.get_recent_extractions(
                feed_id=feed_id,
                before_iso=reported_at,
                within_seconds=60,
                limit=3,
            )
            prior_context = [
                r.get("raw_text", "")
                for r in recent
                if r.get("raw_text") and r.get("incident_id") != incident_id
            ]
        except Exception:
            prior_context = []

    try:
        result = await llm.extract_incident(
            raw_text,
            city_context=_llm_ctx(city),
            prior_context=prior_context or None,
            feed_label=_feed_label(feed_id),
        )
    except llm.LLMError as e:
        print(f"  [{incident_id}] LLM error: {e}")
        return "llm_error"

    if result is None:
        outcome_status = "unmapped_repaired"
        soft_hide_payload = {
            "hidden": True,
            "geocode_status": outcome_status,
            "repair_reason": "llm_marked_not_relevant",
            "repaired_at": datetime.now(timezone.utc).isoformat(),
        }
        if not dry_run:
            ref.update(soft_hide_payload)
            _write_unmapped_row(
                incident_id=incident_id,
                feed_id=feed_id,
                reported_at=reported_at,
                raw_text=raw_text,
                city=city,
                original_location_text=data.get("location_text"),
                why_unmapped="llm_marked_not_relevant",
            )
        return "soft_hidden_not_relevant"

    new_location_text = result.get("location_text")
    new_loc_confidence = result.get("location_confidence", "none")
    gctx = _geo_ctx(city)
    suf = (gctx or {}).get("suffix") or (_llm_ctx(city) or {}).get("geocode_suffix") or ""
    if new_location_text and suf:
        norm = geocode.normalize_location_text_for_geocode(str(new_location_text).strip(), suffix=suf)
        if norm:
            new_location_text = norm

    new_lat = None
    new_lng = None
    if new_location_text:
        coords = await geocode.geocode(new_location_text, geo_ctx=gctx)
        if coords:
            new_lat, new_lng = coords

    if new_lat is not None and new_lng is not None:
        update_payload = {
            "lat": new_lat,
            "lng": new_lng,
            "location_text": new_location_text,
            "location_confidence": new_loc_confidence,
            "geocode_status": f"success_repaired_{new_loc_confidence}",
            "hidden": False,
            "repaired_at": datetime.now(timezone.utc).isoformat(),
            "severity_category": result.get("severity_category", data.get("severity_category")),
            "confidence": float(result.get("confidence", data.get("confidence", 0.7))),
            "description": result.get("description") or data.get("description"),
        }
        if not dry_run:
            ref.update(update_payload)
        return "repaired"

    soft_hide_payload = {
        "hidden": True,
        "geocode_status": "unmapped_repaired",
        "location_confidence": new_loc_confidence,
        "repair_reason": "geocode_failed_after_repair"
        if new_location_text
        else "no_location_after_repair",
        "repaired_at": datetime.now(timezone.utc).isoformat(),
    }
    if new_location_text:
        soft_hide_payload["location_text"] = new_location_text

    if not dry_run:
        ref.update(soft_hide_payload)
        _write_unmapped_row(
            incident_id=incident_id,
            feed_id=feed_id,
            reported_at=reported_at,
            raw_text=raw_text,
            city=city,
            original_location_text=data.get("location_text"),
            why_unmapped=soft_hide_payload["repair_reason"],
            attempted_location_text=new_location_text,
        )
    return "soft_hidden_unmapped"


def _write_unmapped_row(
    *,
    incident_id: str,
    feed_id: str | None,
    reported_at: str | None,
    raw_text: str,
    city: str | None,
    original_location_text: str | None,
    why_unmapped: str,
    attempted_location_text: str | None = None,
) -> None:
    """Mirror the soft-hidden incident into the admin review queue."""
    db = _get_db()
    payload = {
        "incident_id": incident_id,
        "feed_id": feed_id,
        "reported_at": reported_at,
        "raw_text": raw_text,
        "city": city,
        "original_location_text": original_location_text,
        "attempted_location_text": attempted_location_text,
        "why_unmapped": why_unmapped,
        "queued_at": datetime.now(timezone.utc).isoformat(),
    }
    try:
        db.collection("unmapped_incidents").document(incident_id).set(payload)
    except Exception as e:
        print(f"  [{incident_id}] WARN: failed to write unmapped queue row: {e}")


# ── CLI ───────────────────────────────────────────────────────────────


async def _run(args: argparse.Namespace) -> None:
    from philly_pulse import llm_client

    if not llm_client.is_configured():
        print(
            "[FATAL] No LLM provider configured. Set LAMBDA_API_KEY (preferred) "
            "or OPENAI_API_KEY in the environment.",
            file=sys.stderr,
        )
        sys.exit(2)
    print(
        f"[INFO] LLM provider: {llm_client.active_provider_name()} "
        f"(model: {llm_client.active_model()})"
    )

    load_city_registry()
    if not CITY_REGISTRY:
        print("[WARN] No city registry loaded; geocode/LLM will use defaults.", file=sys.stderr)

    counts: dict[str, int] = {}
    processed = 0
    started = time.time()

    for incident_id, ref, data in _iter_llm_fallback_incidents(args.city, args.limit):
        outcome = await _repair_one(incident_id, ref, data, dry_run=args.dry_run)
        counts[outcome] = counts.get(outcome, 0) + 1
        processed += 1

        if processed % 25 == 0:
            elapsed = time.time() - started
            print(
                f"  ... {processed} processed in {elapsed:.0f}s "
                f"(counts: {counts})"
            )

        # Mild pacing so we don't blow through OpenAI rate limits or
        # Firestore write quotas mid-run.
        await asyncio.sleep(args.sleep)

    print()
    print("=== Repair run complete ===")
    print(f"Mode:       {'DRY-RUN' if args.dry_run else 'EXECUTED'}")
    print(f"City:       {args.city or '(all)'}")
    print(f"Processed:  {processed}")
    for outcome, n in sorted(counts.items()):
        print(f"  {outcome}: {n}")
    print(f"Elapsed:    {time.time() - started:.0f}s")


def main() -> None:
    parser = argparse.ArgumentParser(
        description=(
            "Repair incidents stuck at hallucinated LLM-fallback coords by "
            "re-running them through the new geocode pipeline."
        )
    )
    parser.add_argument(
        "--execute",
        action="store_true",
        help="Actually write updates (default: dry-run).",
    )
    parser.add_argument(
        "--city",
        default=None,
        help="Restrict to a single city slug (e.g. philly, chattanooga).",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=None,
        help="Cap on number of incidents to process.",
    )
    parser.add_argument(
        "--sleep",
        type=float,
        default=0.25,
        help="Seconds between incidents (rate-limit pacing).",
    )
    args = parser.parse_args()
    args.dry_run = not args.execute

    if args.dry_run:
        print("=== DRY-RUN MODE (use --execute to write) ===\n")
    else:
        print("=== EXECUTING repair writes ===\n")

    asyncio.run(_run(args))


if __name__ == "__main__":
    main()
