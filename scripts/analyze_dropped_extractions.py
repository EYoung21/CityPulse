#!/usr/bin/env python3
"""Sample unpromoted LLM-relevant extractions and emit lexicon candidates."""

from __future__ import annotations

import argparse
import os
import re
import sys
from collections import Counter
from datetime import datetime, timedelta, timezone
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
if str(REPO) not in sys.path:
    sys.path.insert(0, str(REPO))

import firebase_admin
from firebase_admin import credentials, firestore


def _client() -> firestore.Client:
    if firebase_admin._apps:
        return firestore.client()
    cred_path = os.environ.get("GOOGLE_APPLICATION_CREDENTIALS")
    if not cred_path:
        raise RuntimeError("GOOGLE_APPLICATION_CREDENTIALS required")
    firebase_admin.initialize_app(credentials.Certificate(cred_path))
    return firestore.client()


def _tokens(text: str) -> list[str]:
    return [t.lower() for t in re.findall(r"[A-Za-z0-9']{3,}", text or "")]


def mine_city(db: firestore.Client, slug: str, hours: int, limit: int) -> Counter[str]:
    floor = (datetime.now(timezone.utc) - timedelta(hours=hours)).isoformat()
    q = (
        db.collection("extractions")
        .where("city", "==", slug)
        .where("reported_at", ">=", floor)
        .limit(limit)
    )
    counts: Counter[str] = Counter()
    for snap in q.stream():
        data = snap.to_dict() or {}
        if not data.get("llm_relevant"):
            continue
        if data.get("incident_id"):
            continue
        status = str(data.get("geocode_status") or "")
        if status.startswith("success"):
            continue
        blob = " ".join(
            [
                str(data.get("raw_text") or ""),
                str(data.get("llm_location_text") or ""),
            ]
        )
        counts.update(_tokens(blob))
    return counts


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--city", required=True)
    parser.add_argument("--hours", type=int, default=24)
    parser.add_argument("--limit", type=int, default=2000)
    parser.add_argument("--top", type=int, default=40)
    args = parser.parse_args()

    db = _client()
    counts = mine_city(db, args.city, args.hours, args.limit)
    out_path = REPO / "cities" / args.city / "location_lexicon.yaml"
    print(f"# Review and merge into {out_path}")
    for token, n in counts.most_common(args.top):
        print(f"{token}: {n}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
