#!/usr/bin/env python3
"""Generate a VAPID keypair for Web Push.

Run once per deployment, paste the output into your environment, and never
rotate without re-prompting every existing subscriber (browsers tie the
subscription to the public key — change it and every device has to opt in
again).

Output is two `KEY=value` lines plus a sample mailto subject. Pipe straight
into your env file with:

    python scripts/generate_vapid_keys.py >> .env

The `py-vapid` dependency comes from requirements-philly-pulse.txt.
"""

from __future__ import annotations

import sys


def main() -> int:
    try:
        from py_vapid import Vapid
    except ImportError:
        print(
            "py-vapid not installed. Install backend deps first:\n"
            "  pip install -r requirements-philly-pulse.txt",
            file=sys.stderr,
        )
        return 1

    v = Vapid()
    v.generate_keys()

    # py_vapid stores the keys as `cryptography` ec key objects. We
    # serialize to the *raw* bytes the W3C/VAPID spec wants (32-byte
    # private, 65-byte uncompressed public starting with 0x04) and
    # emit hex — push.py auto-detects hex and converts to base64url
    # for the browser. Hex is ugly but it round-trips cleanly through
    # every shell on the planet, which base64url with padding
    # sometimes doesn't.
    pub_hex = v.public_key.public_bytes_raw().hex()
    priv_hex = v.private_key.private_bytes_raw().hex()

    print("# Web Push (VAPID) — paste these into your environment.")
    print("# DO NOT commit the private key.")
    print(f"PHILLY_PULSE_VAPID_PUBLIC_KEY={pub_hex}")
    print(f"PHILLY_PULSE_VAPID_PRIVATE_KEY={priv_hex}")
    print("PHILLY_PULSE_VAPID_SUBJECT=mailto:you@example.com")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
