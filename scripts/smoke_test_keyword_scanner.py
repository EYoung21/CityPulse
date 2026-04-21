#!/usr/bin/env python3
"""End-to-end smoke test for the keyword-scanner alert pipeline.

What this script does:

  1. Unit-tests `_keyword_matches` against a battery of inputs to
     catch regressions in the substring vs. quoted-phrase logic.
  2. Connects to Firestore and reports the current state of the
     `keywordWatches` and `pushSubscriptions` collections (counts
     by city, by active flag).
  3. Synthesises a transcript and runs `notify_keyword_watches`
     against the live data — but with `send_to_uid` monkey-patched
     to a *dry-run* that records intent without actually firing a
     push. Reports per-match outcomes (sent / cooldown / quiet /
     snoozed / below_floor).

Run with:
    source .venv/bin/activate
    set -a && source .env && set +a
    export GOOGLE_APPLICATION_CREDENTIALS=$(pwd)/.secrets/firebase-service-account.json
    python3 scripts/smoke_test_keyword_scanner.py

Optional flags:
    --keyword "shooting"   override the synthetic match keyword
    --city philly          limit the live test to one city
    --send                 actually send pushes (default: dry-run)
"""
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

from philly_pulse import push as push_mod  # noqa: E402


# ── 1. Matcher unit checks ─────────────────────────────────────────────

MATCHER_CASES: list[tuple[str, str, bool]] = [
    # (text, keyword, expect_match)
    ("Shots fired at 22nd and Diamond", "shots", True),
    ("Shots fired at 22nd and Diamond", "SHOTS", True),
    ("Shots fired at 22nd and Diamond", '"shots fired"', True),
    ("Shots fired at 22nd and Diamond", '"shot"', False),       # boundary fail
    ("Officer en route to robbery", "robbery", True),
    ("Officer en route to robbery", "burglary", False),
    ("Carjacking on N Broad", "car", True),                     # substring
    ("Carjacking on N Broad", '"car"', False),                  # phrase boundary
    ("Carjacking on N Broad", '"carjacking"', True),
    ("",                       "shooting", False),
    ("anything",               "",         False),
]


def run_matcher_tests() -> int:
    fails = 0
    for text, kw, expected in MATCHER_CASES:
        norm = push_mod._normalize_keyword(kw)
        actual = push_mod._keyword_matches(text.lower(), norm)
        ok = actual == expected
        marker = "OK " if ok else "FAIL"
        if not ok:
            fails += 1
        print(f"  [{marker}] kw={kw!r:25s} text={text[:40]!r:40s} -> {actual} (want {expected})")
    return fails


# ── 2. Firestore inventory ─────────────────────────────────────────────

def inventory_firestore(city_filter: str | None) -> dict:
    """Read counts only — no writes."""
    db = push_mod._db()
    watches = list(db.collection("keywordWatches").stream())
    subs = list(db.collection("pushSubscriptions").stream())
    by_city: dict[str, int] = {}
    by_active: dict[str, int] = {}
    for w in watches:
        d = w.to_dict() or {}
        by_city[d.get("city") or "(any)"] = by_city.get(d.get("city") or "(any)", 0) + 1
        by_active["active" if d.get("active") else "paused"] = (
            by_active.get("active" if d.get("active") else "paused", 0) + 1
        )
    print(f"  keywordWatches:    {len(watches)}")
    for k, v in sorted(by_city.items()):
        print(f"    by city: {k:20s} {v}")
    for k, v in sorted(by_active.items()):
        print(f"    by status: {k:18s} {v}")
    print(f"  pushSubscriptions: {len(subs)}")
    return {"watches": len(watches), "subs": len(subs)}


# ── 3. Live fanout simulation ──────────────────────────────────────────

def simulate_fanout(*, keyword: str, city: str, dry_run: bool) -> None:
    """Synthesise a transcript that should match `keyword` and run the
    real fanout. In dry-run mode we monkey-patch `send_to_uid` to a
    counter so no real pushes are sent — useful when smoke-testing
    against prod without spamming users."""
    sent_calls: list[dict] = []

    if dry_run:
        original_send = push_mod.send_to_uid

        def fake_send(uid, payload, ttl_seconds=None):
            sent_calls.append({"uid": uid, "payload": payload})
            # Pretend exactly one subscription got the push so the
            # caller's "lastFiredMs" / counter logic still exercises.
            return {"sent": 1, "failed": 0, "removed": 0}

        push_mod.send_to_uid = fake_send  # type: ignore[assignment]
    else:
        original_send = None

    try:
        synthetic_text = f"Dispatch to all units, {keyword} reported in the area"
        result = push_mod.notify_keyword_watches(
            incident_id="smoketest-incident-id",
            city=city,
            raw_text=synthetic_text,
            severity_category="violent_no_weapon",
            s_base=0.8,
            location_text="22nd and Diamond",
        )
        print(f"  notify_keyword_watches result: {result}")
        if dry_run:
            print(f"  would-send count:               {len(sent_calls)}")
            for call in sent_calls[:5]:
                p = call["payload"]
                print(
                    f"    -> uid={call['uid'][:10]}…  title={p.get('title')!r}"
                )
            if len(sent_calls) > 5:
                print(f"    ... {len(sent_calls) - 5} more")
    finally:
        if dry_run and original_send is not None:
            push_mod.send_to_uid = original_send  # type: ignore[assignment]


# ── CLI ────────────────────────────────────────────────────────────────


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--keyword", default="shooting", help="Synthetic match keyword")
    parser.add_argument("--city", default="philly", help="City slug to test against")
    parser.add_argument(
        "--send",
        action="store_true",
        help="Actually send pushes (default: dry-run / monkey-patched)",
    )
    args = parser.parse_args()

    print("=== 1. Matcher unit checks ===")
    fails = run_matcher_tests()
    print(f"  ({fails} failures)\n")

    print("=== 2. Firestore inventory ===")
    if not os.environ.get("GOOGLE_APPLICATION_CREDENTIALS"):
        print("  [SKIP] GOOGLE_APPLICATION_CREDENTIALS not set")
        return
    inv = inventory_firestore(args.city)
    print()

    print(f"=== 3. Live fanout simulation (city={args.city}, kw={args.keyword!r}, dry_run={not args.send}) ===")
    if inv["watches"] == 0:
        print("  [SKIP] No keywordWatches exist in Firestore — nothing to fan out to.")
        print("         Create one via PushSettings UI then re-run.")
    else:
        simulate_fanout(keyword=args.keyword, city=args.city, dry_run=not args.send)

    if fails:
        sys.exit(1)


if __name__ == "__main__":
    main()
