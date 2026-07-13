"""Human-like pacing for Broadcastify web/archive requests.

Broadcastify's archive API and login flow are not documented rate limits,
but burst traffic (list → download → list with no pause, simultaneous
live connects) reads as automation. These helpers add jittered delays
that mimic a person clicking through the site.

All delays are env-overridable so ops can tune without redeploying code.
"""

from __future__ import annotations

import datetime
import os
import random
import time


def _env_range(name: str, default_lo: float, default_hi: float) -> tuple[float, float]:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return (default_lo, default_hi)
    if ":" in raw:
        lo_s, hi_s = raw.split(":", 1)
        return (float(lo_s), float(hi_s))
    val = float(raw)
    return (val, val)


def human_pause(lo: float, hi: float, *, label: str | None = None) -> float:
    """Sleep a random duration in [lo, hi] seconds. Returns actual delay."""
    delay = random.uniform(lo, hi)
    if label:
        print(f"  [pace] {label} {delay:.1f}s", flush=True)
    time.sleep(delay)
    return delay


# Login page GET → form POST (user reads the page, types creds)
LOGIN_PRE_POST = _env_range("BCFY_LOGIN_DELAY", 1.5, 3.5)

# After a successful archives.php list, before downloading segments
LIST_AFTER_DELAY = _env_range("BCFY_LIST_DELAY", 2.0, 5.0)

# Moving to the next calendar day for the same feed
DAY_TRANSITION_DELAY = _env_range("BCFY_DAY_DELAY", 5.0, 15.0)

# Staggering live ffmpeg connects per feed thread
FEED_START_STAGGER = _env_range("BCFY_FEED_STAGGER", 3.0, 10.0)

# Brief pause before session refresh re-login
SESSION_REFRESH_DELAY = _env_range("BCFY_SESSION_REFRESH_DELAY", 2.0, 6.0)


def pause_login() -> None:
    human_pause(*LOGIN_PRE_POST)


def pause_after_list() -> None:
    human_pause(*LIST_AFTER_DELAY)


def pause_day_transition() -> None:
    human_pause(*DAY_TRANSITION_DELAY, label="day transition")


def pause_session_refresh() -> None:
    human_pause(*SESSION_REFRESH_DELAY, label="session refresh")


def feed_start_stagger() -> None:
    human_pause(*FEED_START_STAGGER)


def day_strings_for_backfill(days: int, order: str | None = None) -> list[str]:
    """Return YYYY-MM-DD strings for the last N days.

    * newest (default): yesterday first — use during catch-up after outages
      when live ingest missed recent archive windows.
    * oldest: deepest day first — use for long historical fills racing the
      365-day Broadcastify deletion cliff.
    """
    order = (order or os.environ.get("BACKFILL_DAY_ORDER", "newest")).lower()
    today = datetime.date.today()
    if order == "oldest":
        return [(today - datetime.timedelta(days=d)).isoformat() for d in range(days, 0, -1)]
    return [(today - datetime.timedelta(days=d)).isoformat() for d in range(1, days + 1)]
