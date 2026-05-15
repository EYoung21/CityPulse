"""Evaluate the LLM prefilter against historical Firestore extractions.

Pulls every `extractions` row for one or more cities (default: all),
re-runs the current prefilter against each `raw_text`, and reports
per-city:

  - Recall: % of LLM-relevant lines the prefilter would still pass to
    the LLM. Target ≥99%. Anything below means we're dropping real
    incidents — tighten or remove a noise pattern.

  - Drop rate: % of all lines the prefilter would skip. Target ≥30%.
    Bigger = more $ saved on OpenAI.

  - Estimated monthly $ saved: assumes the same 30-day call volume
    continues and gpt-4o-mini's $0.00027/call blended cost (250 input
    + 100 output tokens). Tweak --cost-per-call to adjust.

  - False-drop list: every LLM-relevant extraction the prefilter would
    have skipped. Manual review these — each one is either a missing
    keep_keyword (fix) or a real edge case the prefilter shouldn't try
    to handle.

Ground truth: an extraction is "LLM-relevant" if `llm_relevant=True`.
That's the LLM's own decision, which is the best ground truth we have
without paying a human to label.

Usage::

    # All cities, last 7 days
    python scripts/eval_prefilter.py

    # One city, last 30 days, dump false-drops to a file
    python scripts/eval_prefilter.py --city philly --days 30 \\
        --false-drops-out /tmp/philly_false_drops.txt

    # Four cities only (uses Firestore ``city`` + ``reported_at`` index per city)
    python scripts/eval_prefilter.py --days 30 --city philly --city sf \\
        --city nyc --city chattanooga --false-drops-out /tmp/fd.jsonl

    # Override cost per call (e.g. if you switch models)
    python scripts/eval_prefilter.py --cost-per-call 0.0004

Environment::

    GOOGLE_APPLICATION_CREDENTIALS  path to Firebase service-account JSON
    # or
    FIREBASE_SERVICE_ACCOUNT_JSON   inline JSON

Both are read by philly_pulse.firestore_store; the script will fail
loudly if neither is set.
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Iterable, Optional

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

from philly_pulse import prefilter  # noqa: E402
from philly_pulse.firestore_store import _ensure_client  # noqa: E402

DEFAULT_COST_PER_CALL_USD = 0.00027
DEFAULT_DAYS = 7


def _parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument(
        "--city",
        action="append",
        dest="cities",
        help="City slug to evaluate (repeat for multiple). Default: every city seen in the data.",
    )
    p.add_argument(
        "--days",
        type=int,
        default=DEFAULT_DAYS,
        help=f"How many days back to pull extractions for. Default: {DEFAULT_DAYS}.",
    )
    p.add_argument(
        "--cost-per-call",
        type=float,
        default=DEFAULT_COST_PER_CALL_USD,
        help=f"Blended USD cost per LLM call. Default: ${DEFAULT_COST_PER_CALL_USD:.5f} (gpt-4o-mini).",
    )
    p.add_argument(
        "--false-drops-out",
        type=Path,
        default=None,
        help="Optional path to write the full false-drop list (city, ts, text) as JSONL.",
    )
    p.add_argument(
        "--limit",
        type=int,
        default=0,
        help="Max extractions per city (0 = no cap). Useful for quick iterations.",
    )
    return p.parse_args()


def _iter_extractions(days: int, page_size: int = 2000) -> Iterable[dict]:
    """Stream every `extractions` doc from the last N days.

    Uses a server-side `where` on `reported_at` plus `order_by` +
    `start_after` cursoring so we never ask Firestore for more than
    `page_size` rows at a time. The unpaged version blows past the 60s
    server-side execution deadline once the result set is in the
    hundred-thousands.
    """
    db = _ensure_client()
    cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
    base = (
        db.collection("extractions")
        .where("reported_at", ">=", cutoff)
        .order_by("reported_at")
        .limit(page_size)
    )
    last_snap = None
    while True:
        q = base if last_snap is None else base.start_after(last_snap)
        page = list(q.stream())
        if not page:
            return
        for snap in page:
            data = snap.to_dict() or {}
            data["id"] = snap.id
            yield data
        last_snap = page[-1]
        if len(page) < page_size:
            return


def _iter_extractions_for_city(city: str, days: int, page_size: int = 2000) -> Iterable[dict]:
    """Stream `extractions` for one city slug (uses composite city + reported_at).

    Prefer this when ``--city`` is passed so we do not read unrelated cities
    from Firestore for multi-week windows.
    """
    db = _ensure_client()
    cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
    base = (
        db.collection("extractions")
        .where("city", "==", city)
        .where("reported_at", ">=", cutoff)
        .order_by("reported_at")
        .limit(page_size)
    )
    last_snap = None
    while True:
        q = base if last_snap is None else base.start_after(last_snap)
        page = list(q.stream())
        if not page:
            return
        for snap in page:
            data = snap.to_dict() or {}
            data["id"] = snap.id
            yield data
        last_snap = page[-1]
        if len(page) < page_size:
            return


def _format_pct(num: int, denom: int) -> str:
    if denom == 0:
        return "  n/a"
    return f"{100 * num / denom:6.2f}%"


def main() -> int:
    args = _parse_args()

    by_city: dict[str, list[dict]] = defaultdict(list)

    if args.cities:
        wanted = sorted({c.lower().strip() for c in args.cities if c and c.strip()})
        if not wanted:
            print("No city slugs after parsing --city.", file=sys.stderr)
            return 2
        print(
            f"Pulling extractions (per-city index) for {', '.join(wanted)} — last {args.days} days …",
            flush=True,
        )
        for city in wanted:
            n = 0
            for r in _iter_extractions_for_city(city, args.days):
                by_city[city].append(r)
                n += 1
                if args.limit and len(by_city[city]) >= args.limit:
                    break
                if n % 5000 == 0:
                    print(f"  {city}: {n:,}", flush=True)
            print(f"  {city}: done ({len(by_city[city]):,} rows)", flush=True)
    else:
        print(f"Pulling extractions from last {args.days} days (all cities) …", flush=True)
        rows: list[dict] = []
        for r in _iter_extractions(args.days):
            rows.append(r)
            if len(rows) % 5000 == 0:
                print(f"  loaded {len(rows):,}", flush=True)
        print(f"Loaded {len(rows):,} total extractions.\n", flush=True)
        for r in rows:
            city = (r.get("city") or "philly").strip().lower()
            by_city[city].append(r)

    if not args.cities and args.limit:
        for k in list(by_city.keys()):
            if len(by_city[k]) > args.limit:
                by_city[k] = by_city[k][: args.limit]

    total_loaded = sum(len(v) for v in by_city.values())
    print(f"Evaluating {total_loaded:,} extractions across {len(by_city)} city bucket(s).\n", flush=True)

    false_drops_fp = None
    if args.false_drops_out:
        args.false_drops_out.parent.mkdir(parents=True, exist_ok=True)
        false_drops_fp = args.false_drops_out.open("w", encoding="utf-8")

    grand_total_calls = 0
    grand_total_skipped = 0
    grand_total_relevant = 0
    grand_total_false_drops = 0

    print(
        f"{'City':<14} {'Total':>8} {'Relevant':>9} {'WouldSkip':>10} "
        f"{'Drop%':>7} {'Recall':>8} {'$/mo saved':>12}"
    )
    print("-" * 76)

    for city in sorted(by_city.keys()):
        extracts = by_city[city]
        if args.limit and len(extracts) > args.limit:
            extracts = extracts[: args.limit]

        total = len(extracts)
        relevant = sum(1 for r in extracts if r.get("llm_relevant") is True)
        skipped = 0
        false_drops = 0

        prefilter.reset_metrics()
        for r in extracts:
            text = r.get("raw_text") or ""
            keep, reason = prefilter.is_dispatch_likely(text, city=city)
            if keep:
                continue
            skipped += 1
            if r.get("llm_relevant") is True:
                false_drops += 1
                if false_drops_fp is not None:
                    false_drops_fp.write(
                        json.dumps(
                            {
                                "city": city,
                                "id": r.get("id"),
                                "reported_at": r.get("reported_at"),
                                "category": r.get("llm_category"),
                                "text": text,
                                "skipped_by_pattern": reason,
                            }
                        )
                        + "\n"
                    )

        # Recall = (relevant lines that the prefilter would still pass) / total relevant
        passed_relevant = relevant - false_drops
        recall_pct = _format_pct(passed_relevant, relevant)
        drop_pct = _format_pct(skipped, total)

        # Project savings to a 30-day window using the historical rate.
        per_day_skipped = skipped / max(args.days, 1)
        monthly_saved_usd = per_day_skipped * 30 * args.cost_per_call

        print(
            f"{city:<14} {total:>8,} {relevant:>9,} {skipped:>10,} "
            f"{drop_pct:>7} {recall_pct:>8} ${monthly_saved_usd:>10.2f}"
        )

        grand_total_calls += total
        grand_total_skipped += skipped
        grand_total_relevant += relevant
        grand_total_false_drops += false_drops

    print("-" * 76)
    grand_recall = _format_pct(grand_total_relevant - grand_total_false_drops, grand_total_relevant)
    grand_drop = _format_pct(grand_total_skipped, grand_total_calls)
    grand_monthly = (grand_total_skipped / max(args.days, 1)) * 30 * args.cost_per_call
    print(
        f"{'TOTAL':<14} {grand_total_calls:>8,} {grand_total_relevant:>9,} "
        f"{grand_total_skipped:>10,} {grand_drop:>7} {grand_recall:>8} ${grand_monthly:>10.2f}"
    )

    if false_drops_fp is not None:
        false_drops_fp.close()
        print(f"\nFalse drops written to {args.false_drops_out}")
        print(
            "Each line is one LLM-relevant extraction the prefilter would have skipped. "
            "Review and either:"
        )
        print("  - add a missing keep_keyword to cities/<slug>/prefilter.yaml, OR")
        print("  - tighten the noise_pattern in philly_pulse/data/prefilter_default.yaml.")

    print()
    if grand_total_relevant > 0 and grand_total_false_drops / grand_total_relevant > 0.01:
        print("WARN: overall recall is below 99%. Tighten patterns before deploying.", file=sys.stderr)
        return 1

    print("OK: recall ≥99%. Safe to deploy.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
