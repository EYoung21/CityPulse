"""Non-blocking bridge from radiotranscriber.py to the PhillyPulse ingest API."""

import json
import logging
import threading
from urllib.request import Request, urlopen
from urllib.error import URLError

logger = logging.getLogger(__name__)


def post_transcript(bridge_url: str, text: str, timestamp: str | None = None, feed_id: str | None = None, audio_clip: str | None = None):
    """Fire-and-forget POST of a transcript line to the ingest endpoint.

    Runs in a daemon thread so it never blocks the transcriber main loop.
    """
    def _send():
        payload = {"text": text}
        if timestamp:
            payload["timestamp"] = timestamp
        if feed_id:
            payload["feed_id"] = feed_id
        if audio_clip:
            payload["audio_clip"] = audio_clip
        body = json.dumps(payload).encode("utf-8")
        req = Request(
            bridge_url,
            data=body,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urlopen(req, timeout=10) as resp:
                logger.info("Bridge POST %d: %s", resp.status, text[:60])
        except URLError as e:
            logger.warning("Bridge POST failed: %s", e)
        except Exception as e:
            logger.warning("Bridge POST error: %s", e)

    t = threading.Thread(target=_send, daemon=True)
    t.start()
