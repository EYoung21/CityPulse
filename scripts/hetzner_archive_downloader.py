#!/usr/bin/env python3
"""Hetzner-side Broadcastify downloader for the split-pipeline backfill.

Why this exists:
    The original `backfill_archives.py` does download + Whisper + LLM +
    ingest in one process on Lambda. Broadcastify silently rate-limits the
    Lambda IP (cloud GPU IP ranges are well-known), so the runner spent
    most of its time in 60-1800s 429 backoff loops while the GPU sat
    idle and we burned $1.29/hr. The Hetzner box has a residential-ish
    Hetzner IP that Broadcastify treats normally.

    This script does ONLY the download half. It runs on Hetzner, logs
    into Broadcastify with the Premium account, walks every active city
    /feed/day in cities/<slug>/config.yaml, downloads each 30-minute MP3
    archive segment, and ships it to Lambda over scp into a spool
    directory where `lambda_archive_transcriber.py` picks it up. Whisper
    + LLM + ingest stay on Lambda where the GPU lives.

    Each MP3 is shipped together with a sidecar JSON containing the
    metadata Lambda needs to reconstruct the ingest call (city slug,
    feed_id, feed_label, archive_ts, segment_id). The sidecar is
    uploaded LAST so the transcriber can use its presence as a
    "this MP3 is fully transferred" signal — eliminates the half-file
    race that an inotify watcher on the .mp3 alone would have.

Progress tracking:
    Per-feed JSON files at $PROGRESS_DIR/<feed_id>.json record which
    segment IDs have already been downloaded+shipped. Same schema the
    monolithic backfill used, so if you ever flip a city back to the
    old pipeline the existing progress files Just Work.

Backpressure:
    The transcriber on Lambda runs ~5x slower than this downloader can
    push (Whisper takes ~10-20s per 30-min MP3 chunk). Without
    backpressure, Hetzner would fill /var/spool/citypulse-incoming/
    until the Lambda root partition runs out. We poll the queue depth
    via ssh and pause downloading whenever there are more than
    MAX_QUEUE_DEPTH unprocessed sidecars.

Required env (set in /etc/citypulse-downloader.env on Hetzner):
    BROADCASTIFY_USERNAME / BROADCASTIFY_PASSWORD   premium creds
    LAMBDA_USER                                     usually "ubuntu"
    LAMBDA_HOST                                     150.230.182.19
    LAMBDA_SSH_KEY                                  /root/.ssh/lambda_tunnel_key
    LAMBDA_INCOMING_DIR                             /var/spool/citypulse-incoming
    BACKFILL_CITY_GLOB                              "philly chattanooga nyc sf"
    BACKFILL_DAY_LIMIT                              150
    DOWNLOADER_PROGRESS_DIR                         /var/lib/citypulse-downloader/progress
    DOWNLOADER_MAX_QUEUE_DEPTH                      40
    DOWNLOADER_DELAY_BASE / _JITTER                 same shape as backfill_archives
    DOWNLOADER_BACKOFF_BASE / _MULT / _MAX / _JITTER
    DOWNLOADER_429_ABORT                            consecutive 429s before parking city
    DOWNLOADER_CYCLE_SLEEP_S                        between full passes (default 600)
    DOWNLOADER_HEARTBEAT                            /var/log/citypulse-downloader.heartbeat
"""

from __future__ import annotations

import argparse
import datetime
import json
import os
import random
import re
import signal
import subprocess
import sys
import tempfile
import time
import uuid
from pathlib import Path

import requests
import yaml

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from broadcastify_pacing import (
    day_strings_for_backfill,
    pause_after_list,
    pause_day_transition,
    pause_login,
    pause_session_refresh,
)

# ── Paths / env ─────────────────────────────────────────────────────
REPO_ROOT = Path(__file__).resolve().parent.parent

USERNAME = os.environ.get("BROADCASTIFY_USERNAME", "")
PASSWORD = os.environ.get("BROADCASTIFY_PASSWORD", "")

LAMBDA_USER = os.environ.get("LAMBDA_USER", "ubuntu")
LAMBDA_HOST = os.environ.get("LAMBDA_HOST", "150.230.182.19")
LAMBDA_SSH_KEY = os.environ.get("LAMBDA_SSH_KEY", "/root/.ssh/lambda_tunnel_key")
LAMBDA_INCOMING_DIR = os.environ.get("LAMBDA_INCOMING_DIR", "/var/spool/citypulse-incoming")

PROGRESS_DIR = Path(os.environ.get("DOWNLOADER_PROGRESS_DIR", "/var/lib/citypulse-downloader/progress"))
HEARTBEAT_PATH = Path(os.environ.get("DOWNLOADER_HEARTBEAT", "/var/log/citypulse-downloader.heartbeat"))

DAY_LIMIT = int(os.environ.get("BACKFILL_DAY_LIMIT", "150"))
CITY_GLOB = os.environ.get("BACKFILL_CITY_GLOB", "").split()
CYCLE_SLEEP_S = int(os.environ.get("DOWNLOADER_CYCLE_SLEEP_S", "600"))
MAX_QUEUE_DEPTH = int(os.environ.get("DOWNLOADER_MAX_QUEUE_DEPTH", "40"))

# Pacing knobs — still human-paced even on Hetzner's friendlier IP.
DOWNLOAD_DELAY_BASE = float(os.environ.get("DOWNLOADER_DELAY_BASE", "10"))
DOWNLOAD_DELAY_JITTER = float(os.environ.get("DOWNLOADER_DELAY_JITTER", "4"))
BACKOFF_BASE = float(os.environ.get("DOWNLOADER_BACKOFF_BASE", "30"))
BACKOFF_MULT = float(os.environ.get("DOWNLOADER_BACKOFF_MULT", "2"))
BACKOFF_MAX = float(os.environ.get("DOWNLOADER_BACKOFF_MAX", "900"))
BACKOFF_JITTER_FRAC = 0.25
MAX_RETRIES = int(os.environ.get("DOWNLOADER_MAX_RETRIES", "5"))
CONSECUTIVE_429_PARK = int(os.environ.get("DOWNLOADER_429_ABORT", "10"))
COOLDOWN_AFTER_429 = int(os.environ.get("DOWNLOADER_COOLDOWN_AFTER_429", "3600"))

PROGRESS_DIR.mkdir(parents=True, exist_ok=True)

# ── Heartbeat ───────────────────────────────────────────────────────


def _heartbeat(state: dict) -> None:
    try:
        HEARTBEAT_PATH.parent.mkdir(parents=True, exist_ok=True)
        with HEARTBEAT_PATH.open("w") as f:
            json.dump({
                "ts": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                **state,
            }, f)
    except OSError as e:
        print(f"[heartbeat] couldn't write {HEARTBEAT_PATH}: {e}", flush=True)


# ── Pacing / backoff ────────────────────────────────────────────────


_consecutive_429 = 0


class QuotaExhausted(Exception):
    pass


def _jittered_delay(base: float, jitter_frac: float = 0.25) -> float:
    lo = base * (1.0 - jitter_frac)
    hi = base * (1.0 + jitter_frac)
    return random.uniform(lo, hi)


def _backoff(attempt: int) -> float:
    raw = min(BACKOFF_BASE * (BACKOFF_MULT ** attempt), BACKOFF_MAX)
    return _jittered_delay(raw, BACKOFF_JITTER_FRAC)


def _record_429() -> None:
    global _consecutive_429
    _consecutive_429 += 1
    if _consecutive_429 >= CONSECUTIVE_429_PARK:
        raise QuotaExhausted(
            f"{CONSECUTIVE_429_PARK} consecutive 429s — parking this city for "
            f"{COOLDOWN_AFTER_429}s to let the quota reset"
        )


def _record_success() -> None:
    global _consecutive_429
    _consecutive_429 = 0


def _polite_sleep() -> None:
    delay = DOWNLOAD_DELAY_BASE + random.uniform(-DOWNLOAD_DELAY_JITTER, DOWNLOAD_DELAY_JITTER)
    time.sleep(max(6.0, delay))


# ── Broadcastify ────────────────────────────────────────────────────


def get_session() -> requests.Session:
    """Authenticated Broadcastify session. Same flow as backfill_archives.py."""
    session = requests.Session()
    session.headers.update({
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
    })
    login_url = "https://www.broadcastify.com/login/"
    session.get(login_url, timeout=30)
    pause_login()
    session.post(
        login_url,
        data={
            "username": USERNAME,
            "password": PASSWORD,
            "action": "auth",
            "redirect": "https://www.broadcastify.com",
        },
        allow_redirects=True,
        timeout=30,
    ).raise_for_status()
    if "bcfyuser1" not in session.cookies.get_dict():
        print("[WARN] Broadcastify login may have failed (no bcfyuser1 cookie)", flush=True)
    return session


def list_archives(session: requests.Session, feed_id: str, day: str) -> list[dict]:
    """Fetch archive segment list for a feed/day. Backs off on 429."""
    url = f"https://www.broadcastify.com/archives/api/archives.php?feedId={feed_id}&date={day}"
    for attempt in range(MAX_RETRIES + 1):
        try:
            resp = session.get(url, timeout=30)
            if resp.status_code == 429:
                _record_429()
                if attempt < MAX_RETRIES:
                    wait = _backoff(attempt)
                    print(f"  [429 list] backoff {wait:.0f}s ({attempt+1}/{MAX_RETRIES})", flush=True)
                    time.sleep(wait)
                    continue
                return []
            if resp.status_code != 200:
                return []
            _record_success()
            data = resp.json()
            pause_after_list()
            break
        except QuotaExhausted:
            raise
        except Exception as e:
            print(f"  [list error] {e}", flush=True)
            if attempt < MAX_RETRIES:
                time.sleep(_backoff(attempt))
                continue
            return []
    out: list[dict] = []
    for item in data.get("archives", []):
        aid = item.get("id", "")
        out.append({
            "id": aid,
            "url": f"https://www.broadcastify.com/archives/download/{aid}",
            "time_label": item.get("start", "00:00"),
            "startTs": item.get("startTs", 0),
        })
    return out


def download_mp3(session: requests.Session, url: str, dest: str) -> bool:
    """Stream a single MP3 to disk. Returns True on success."""
    for attempt in range(MAX_RETRIES + 1):
        try:
            resp = session.get(url, stream=True, timeout=120)
            if resp.status_code == 429:
                _record_429()
                if attempt < MAX_RETRIES:
                    wait = _backoff(attempt)
                    print(f"    [429 dl] backoff {wait:.0f}s ({attempt+1}/{MAX_RETRIES})", flush=True)
                    time.sleep(wait)
                    continue
                return False
            resp.raise_for_status()
            with open(dest, "wb") as f:
                for chunk in resp.iter_content(chunk_size=8192):
                    f.write(chunk)
            _record_success()
            return True
        except QuotaExhausted:
            raise
        except requests.exceptions.HTTPError as e:
            if "429" in str(e):
                _record_429()
                if attempt < MAX_RETRIES:
                    time.sleep(_backoff(attempt))
                    continue
            print(f"    [dl http err] {e}", flush=True)
            return False
        except Exception as e:
            print(f"    [dl error] {e}", flush=True)
            if attempt < MAX_RETRIES:
                time.sleep(_backoff(attempt))
                continue
            return False
    return False


# ── SCP / Lambda transport ──────────────────────────────────────────


_ssh_base = [
    "-i", LAMBDA_SSH_KEY,
    "-o", "BatchMode=yes",
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", "ServerAliveInterval=15",
    "-o", "ServerAliveCountMax=3",
    "-o", "ConnectTimeout=15",
]


def _ssh(cmd: str, *, timeout: int = 30) -> tuple[int, str, str]:
    """Run a remote command on Lambda. Returns (rc, stdout, stderr)."""
    args = ["ssh", *_ssh_base, f"{LAMBDA_USER}@{LAMBDA_HOST}", cmd]
    try:
        r = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
        return r.returncode, r.stdout, r.stderr
    except subprocess.TimeoutExpired:
        return 124, "", "ssh timeout"
    except Exception as e:
        return 1, "", str(e)


def _scp_to_lambda(local: str, remote_basename: str, *, timeout: int = 120) -> bool:
    """Atomically transfer a file: scp to .tmp suffix then ssh-rename to final.

    The transcriber uses the .json sidecar as the "go" signal, but we still
    do .tmp+rename so a partial scp (network drop mid-transfer) can never
    surface as a complete file.
    """
    remote_tmp = f"{LAMBDA_INCOMING_DIR}/{remote_basename}.partial"
    remote_final = f"{LAMBDA_INCOMING_DIR}/{remote_basename}"
    args = ["scp", *_ssh_base, local, f"{LAMBDA_USER}@{LAMBDA_HOST}:{remote_tmp}"]
    try:
        r = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        print(f"    [scp timeout] {remote_basename}", flush=True)
        return False
    if r.returncode != 0:
        print(f"    [scp rc={r.returncode}] {r.stderr.strip()[:160]}", flush=True)
        return False
    rc, _, err = _ssh(f"mv -f {remote_tmp!s} {remote_final!s}")
    if rc != 0:
        print(f"    [ssh mv rc={rc}] {err.strip()[:160]}", flush=True)
        return False
    return True


def _ensure_remote_dir() -> bool:
    rc, _, err = _ssh(f"mkdir -p {LAMBDA_INCOMING_DIR!s}")
    if rc != 0:
        print(f"[FATAL] cannot mkdir on Lambda: {err}", flush=True)
        return False
    return True


def _queue_depth() -> int:
    """Sidecars sitting in incoming/ tell us how many Whisper jobs are
    pending. We use sidecars instead of MP3s so .partial uploads don't
    inflate the depth and starve us into a permanent backpressure stall.
    Returns -1 on ssh error so the caller can decide whether to keep
    going (we treat it as 0 and proceed)."""
    rc, out, _ = _ssh(f"ls -1 {LAMBDA_INCOMING_DIR}/*.json 2>/dev/null | wc -l")
    if rc != 0:
        return -1
    try:
        return int(out.strip() or "0")
    except ValueError:
        return -1


def _wait_for_queue_room(state: dict) -> None:
    """Block while Lambda's incoming queue has too many pending sidecars."""
    while True:
        depth = _queue_depth()
        if depth < 0:
            # ssh broken → don't loop tight, but don't assume infinite room
            time.sleep(5)
            return
        if depth < MAX_QUEUE_DEPTH:
            return
        state["phase"] = f"backpressure (queue={depth}/{MAX_QUEUE_DEPTH})"
        _heartbeat(state)
        print(f"  [backpressure] {depth} sidecars pending on Lambda; sleeping 30s", flush=True)
        time.sleep(30)


# ── Progress ────────────────────────────────────────────────────────


def _progress_path(feed_id: str) -> Path:
    return PROGRESS_DIR / f"{feed_id}.json"


def load_progress(feed_id: str) -> dict:
    p = _progress_path(feed_id)
    if not p.exists():
        return {}
    try:
        return json.loads(p.read_text())
    except Exception:
        return {}


def save_progress(feed_id: str, prog: dict) -> None:
    tmp = _progress_path(feed_id).with_suffix(".tmp")
    tmp.write_text(json.dumps(prog, indent=2))
    tmp.replace(_progress_path(feed_id))


# ── City discovery ──────────────────────────────────────────────────


def discover_cities() -> list[Path]:
    cfgs = sorted(REPO_ROOT.glob("cities/*/config.yaml"))
    if CITY_GLOB:
        keep = set(CITY_GLOB)
        cfgs = [c for c in cfgs if c.parent.name in keep]
    return cfgs


def days_back(n: int) -> list[str]:
    return day_strings_for_backfill(n)


# ── Per-segment ship ────────────────────────────────────────────────


def _ship_segment(
    session: requests.Session,
    *,
    city_slug: str,
    feed_id: str,
    feed_label: str,
    archive: dict,
    state: dict,
) -> bool:
    """Download a single segment + ship to Lambda. Returns True on success."""
    seg_id = archive["id"]
    archive_url = archive["url"]
    time_label = archive["time_label"]
    start_ts = archive.get("startTs", 0)
    if start_ts:
        archive_ts = datetime.datetime.fromtimestamp(
            start_ts, tz=datetime.timezone.utc
        ).isoformat()
    else:
        archive_ts = state.get("day", "")  # caller supplies a YYYY-MM-DD fallback

    job_uuid = uuid.uuid4().hex[:16]
    # Naming: <city>__<feed_id>__<seg_id>__<uuid>.mp3 — debugging on Lambda
    # is way easier when the filename tells you the provenance at a glance.
    safe_seg = re.sub(r"[^A-Za-z0-9_-]", "_", str(seg_id))[:40] or "noid"
    base = f"{city_slug}__{feed_id}__{safe_seg}__{job_uuid}"

    with tempfile.TemporaryDirectory(prefix="cp-dl-") as tmpdir:
        local_mp3 = os.path.join(tmpdir, f"{base}.mp3")
        local_json = os.path.join(tmpdir, f"{base}.json")

        try:
            ok = download_mp3(session, archive_url, local_mp3)
        except QuotaExhausted:
            raise
        if not ok:
            return False
        try:
            size = os.path.getsize(local_mp3)
        except OSError:
            size = 0
        if size < 1024:
            print(f"    [tiny mp3 {size}B] dropping {seg_id}", flush=True)
            return False

        # Sidecar metadata. The transcriber uses every key here when
        # constructing the /api/ingest payload, so any new field added on
        # the server side has to land in this dict too.
        meta = {
            "schema": 1,
            "city": city_slug,
            "feed_id": feed_id,
            "feed_label": feed_label,
            "segment_id": seg_id,
            "archive_ts": archive_ts,
            "time_label": time_label,
            "downloaded_at": datetime.datetime.now(
                datetime.timezone.utc
            ).isoformat(),
            "source": "broadcastify-archive",
            "downloader": "hetzner",
        }
        with open(local_json, "w") as f:
            json.dump(meta, f)

        # Ship MP3 first, then sidecar — the transcriber treats sidecar
        # presence as the "transfer complete" signal.
        if not _scp_to_lambda(local_mp3, f"{base}.mp3"):
            return False
        if not _scp_to_lambda(local_json, f"{base}.json"):
            # MP3 made it across but sidecar didn't → orphan; transcriber
            # will sweep it on its janitor pass. Still consider this a
            # ship failure so we don't mark progress.
            return False
    return True


# ── Per-city loop ───────────────────────────────────────────────────


_quota_park_until: dict[str, float] = {}


def run_one_city(cfg: Path, session: requests.Session, state: dict) -> int:
    """Process every feed in this city's config. Returns segments shipped."""
    city = yaml.safe_load(cfg.read_text()) or {}
    slug = city.get("city", {}).get("slug") or cfg.parent.name
    feeds = city.get("feeds") or []
    if not feeds:
        print(f"[{slug}] no feeds in config, skipping", flush=True)
        return 0

    state["city"] = slug
    state["phase"] = "starting"
    _heartbeat(state)

    days = days_back(DAY_LIMIT)
    shipped_this_city = 0
    print(f"\n=== {slug}: {len(feeds)} feeds × {len(days)} days ===", flush=True)

    for feed in feeds:
        if _quota_park_until.get(slug, 0) > time.time():
            wait = int(_quota_park_until[slug] - time.time())
            print(f"  [{slug}] in quota cooldown for {wait}s more, breaking", flush=True)
            return shipped_this_city

        feed_id = str(feed.get("feed_id") or "")
        feed_label = feed.get("label") or feed_id
        if not feed_id:
            continue

        progress = load_progress(feed_id)
        state["feed"] = f"{feed_id} ({feed_label})"

        for day in days:
            if _quota_park_until.get(slug, 0) > time.time():
                return shipped_this_city

            day_state = progress.get(day)
            # Schemas in the wild:
            #   missing → never tried
            #   "no_archives" → list returned empty
            #   "done_<n>" → fully shipped (legacy from monolith too)
            #   {"done_segments": [...], "shipped": int} → partial
            if isinstance(day_state, str) and (
                day_state == "no_archives" or day_state.startswith("done_")
            ):
                continue

            print(f"\n[{day}] [{slug} / {feed_label}] listing...", flush=True)
            state["day"] = day
            state["phase"] = "listing"
            _heartbeat(state)
            try:
                archives = list_archives(session, feed_id, day)
            except QuotaExhausted as e:
                print(f"[{slug}] quota tripped: {e}", flush=True)
                _quota_park_until[slug] = time.time() + COOLDOWN_AFTER_429
                state["phase"] = "quota_parked"
                _heartbeat(state)
                return shipped_this_city
            if not archives:
                progress[day] = "no_archives"
                save_progress(feed_id, progress)
                continue

            done = set((day_state or {}).get("done_segments", []) if isinstance(day_state, dict) else [])
            print(f"  {len(archives)} segments ({len(done)} already shipped)", flush=True)
            day_shipped = (day_state or {}).get("shipped", 0) if isinstance(day_state, dict) else 0

            for ai, archive in enumerate(archives):
                if archive["id"] in done:
                    continue
                state["phase"] = f"queue-check {ai+1}/{len(archives)}"
                _heartbeat(state)
                _wait_for_queue_room(state)

                state["phase"] = f"download {ai+1}/{len(archives)} {archive['time_label']}"
                _heartbeat(state)
                print(
                    f"  [{ai+1}/{len(archives)}] {archive['time_label']} → ship",
                    flush=True,
                )
                try:
                    ok = _ship_segment(
                        session,
                        city_slug=slug,
                        feed_id=feed_id,
                        feed_label=feed_label,
                        archive=archive,
                        state={**state, "day": day},
                    )
                except QuotaExhausted as e:
                    print(f"[{slug}] quota tripped: {e}", flush=True)
                    _quota_park_until[slug] = time.time() + COOLDOWN_AFTER_429
                    state["phase"] = "quota_parked"
                    _heartbeat(state)
                    return shipped_this_city
                if ok:
                    done.add(archive["id"])
                    day_shipped += 1
                    shipped_this_city += 1
                    progress[day] = {"done_segments": list(done), "shipped": day_shipped}
                    save_progress(feed_id, progress)
                _polite_sleep()

            # If we fully drained the day's segments, collapse to the
            # short "done_<n>" form so the next pass skips the whole
            # day with one dict lookup.
            if all(a["id"] in done for a in archives):
                progress[day] = f"done_{day_shipped}"
                save_progress(feed_id, progress)
                print(f"  --- {day} [{feed_label}]: {day_shipped} shipped ---", flush=True)
                pause_day_transition()

    state["phase"] = "city_done"
    _heartbeat(state)
    return shipped_this_city


# ── Main loop ───────────────────────────────────────────────────────


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--once", action="store_true",
                   help="One pass over all cities and exit (default: loop forever)")
    args = p.parse_args()

    if not USERNAME or not PASSWORD:
        print("[FATAL] BROADCASTIFY_USERNAME / _PASSWORD must be set", file=sys.stderr)
        return 2

    if not Path(LAMBDA_SSH_KEY).exists():
        print(f"[FATAL] Lambda SSH key missing at {LAMBDA_SSH_KEY}", file=sys.stderr)
        return 2

    if not _ensure_remote_dir():
        return 3

    cities = discover_cities()
    if not cities:
        print("[FATAL] no cities/<slug>/config.yaml matched BACKFILL_CITY_GLOB", file=sys.stderr)
        return 4

    print(
        f"Hetzner downloader: {len(cities)} cities, day-limit={DAY_LIMIT}, "
        f"queue-cap={MAX_QUEUE_DEPTH}, target={LAMBDA_USER}@{LAMBDA_HOST}:{LAMBDA_INCOMING_DIR}",
        flush=True,
    )
    print(f"  Cities: {', '.join(c.parent.name for c in cities)}", flush=True)
    _heartbeat({"phase": "boot", "cities": [c.parent.name for c in cities]})

    def _on_term(_sig, _frm):
        _heartbeat({"phase": "shutdown_clean"})
        sys.exit(0)
    signal.signal(signal.SIGTERM, _on_term)
    signal.signal(signal.SIGINT, _on_term)

    cycle = 0
    while True:
        cycle += 1
        print(f"\n###### DOWNLOADER CYCLE {cycle} ######", flush=True)
        session = get_session()
        session_age = time.time()
        cycle_total = 0
        for cfg in cities:
            if time.time() - session_age > 1800:
                print("  [session] refreshing Broadcastify login", flush=True)
                try:
                    pause_session_refresh()
                    session = get_session()
                    session_age = time.time()
                except Exception as e:
                    print(f"  [session error] {e}", flush=True)
            state = {"cycle": cycle, "city": cfg.parent.name, "feed": None,
                     "day": None, "phase": "init"}
            try:
                cycle_total += run_one_city(cfg, session, state)
            except KeyboardInterrupt:
                _heartbeat({"phase": "shutdown_clean"})
                return 130
            except Exception as e:
                print(f"  [city {cfg.parent.name}] WRAPPER ERROR: {e}", flush=True)
                time.sleep(30)
        print(f"###### CYCLE {cycle} done, {cycle_total} segments shipped ######", flush=True)
        if args.once:
            return 0
        _heartbeat({"phase": "cycle_sleep", "cycle": cycle, "shipped": cycle_total})
        time.sleep(CYCLE_SLEEP_S)


if __name__ == "__main__":
    sys.exit(main())
