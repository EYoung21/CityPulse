"""Generate the day list used by the archive backfill.

By default emits **every** date going back `--days` (default 150 = ~5 months),
sorted most-recent-first so the backfill prioritizes recent dispatches.
Pass `--decay` to fall back to the original exponential-decay sampling
(~50 dates over 150 days, with recent days dense and older days sparse).

Usage:
    python generate_day_list.py                # 150 dates, recent-first
    python generate_day_list.py --days 30      # 30 dates, recent-first
    python generate_day_list.py --decay        # legacy ~50-date sampling
    python generate_day_list.py -o days.txt    # write to file
"""

from __future__ import annotations

import argparse
import datetime


def all_dates_recent_first(total_days: int = 150) -> list[str]:
    """Every date from yesterday back `total_days` days, most-recent-first."""
    today = datetime.date.today()
    return [
        (today - datetime.timedelta(days=d)).isoformat()
        for d in range(1, total_days + 1)
    ]


def exponential_decay_dates(total_days: int = 150) -> list[str]:
    today = datetime.date.today()
    dates: list[str] = []

    for d in range(1, min(total_days, 14) + 1):
        dates.append((today - datetime.timedelta(days=d)).isoformat())

    for d in range(15, min(total_days, 30) + 1, 2):
        dates.append((today - datetime.timedelta(days=d)).isoformat())

    for d in range(31, min(total_days, 60) + 1, 3):
        dates.append((today - datetime.timedelta(days=d)).isoformat())

    for d in range(61, min(total_days, 150) + 1, 5):
        dates.append((today - datetime.timedelta(days=d)).isoformat())

    return dates


def main():
    parser = argparse.ArgumentParser(description="Generate backfill day list")
    parser.add_argument("-o", "--output", type=str, default=None, help="Output file (default: stdout)")
    parser.add_argument("--days", type=int, default=150, help="Max days back (default: 150)")
    parser.add_argument(
        "--decay",
        action="store_true",
        help="Use legacy exponential-decay sampling (~50 dates) instead of full coverage",
    )
    args = parser.parse_args()

    if args.decay:
        dates = exponential_decay_dates(args.days)
        header = f"# Exponential decay day list: {len(dates)} dates over {args.days} days"
    else:
        dates = all_dates_recent_first(args.days)
        header = f"# Full day list (recent-first): {len(dates)} dates over {args.days} days"

    lines = [header] + dates

    if args.output:
        with open(args.output, "w") as f:
            f.write("\n".join(lines) + "\n")
        print(f"Wrote {len(dates)} dates to {args.output}")
    else:
        for line in lines:
            print(line)


if __name__ == "__main__":
    main()
