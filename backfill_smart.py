"""Smart backfill wrapper for cron.

Runs backfill for one city per invocation, rotating through cities.
Stops quickly on quota exhaustion so the next cron slot picks up the next city.

Cron: 0 */2 * * * cd /home/ubuntu/PhillyPulse && python3 -u backfill_smart.py >> logs/backfill_smart.log 2>&1
"""
import os
import subprocess
import sys
import time

CITIES = [
    ("sf", "San Francisco"),
    ("nyc", "New York City"),
    ("philly", "Philadelphia"),
    ("chattanooga", "Chattanooga"),
    ("seattle", "Seattle"),
    ("dallas", "Dallas"),
    ("frisco", "Frisco"),
]

STATE_FILE = os.path.expanduser("~/PhillyPulse/backfill_progress/smart_state.txt")


def get_next_city():
    try:
        with open(STATE_FILE) as f:
            idx = int(f.read().strip())
    except Exception:
        idx = 0
    return idx % len(CITIES)


def save_next_city(idx):
    os.makedirs(os.path.dirname(STATE_FILE), exist_ok=True)
    with open(STATE_FILE, "w") as f:
        f.write(str((idx + 1) % len(CITIES)))


def main():
    idx = get_next_city()
    slug, name = CITIES[idx]
    config = f"cities/{slug}/config.yaml"

    sep = "=" * 60
    now = time.strftime("%Y-%m-%d %H:%M:%S")
    print(f"\n{sep}")
    print(f"  Smart Backfill: {name} ({now})")
    print(sep)

    result = subprocess.run(
        [sys.executable, "-u", "backfill_archives.py", "--config", config, "--days", "150"],
        cwd=os.path.expanduser("~/PhillyPulse"),
        timeout=7000,
    )

    save_next_city(idx)
    print(f"Exit code: {result.returncode}")
    next_name = CITIES[(idx + 1) % len(CITIES)][1]
    print(f"Next run: {next_name}")
    print(f"Done at {time.strftime('%Y-%m-%d %H:%M:%S')}")


if __name__ == "__main__":
    main()
