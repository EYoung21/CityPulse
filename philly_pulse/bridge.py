"""Non-blocking bridge from radiotranscriber.py to the CityPulse ingest API.

Sends transcripts + audio clip data to the ingest endpoint. Audio files
are base64-encoded and included in the JSON payload so they arrive on the
API server even when the transcriber runs on a different machine.
"""

import base64
import json
import logging
import os
import threading
from urllib.request import Request, urlopen
from urllib.error import URLError

logger = logging.getLogger(__name__)

AUDIO_CLIPS_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "audio_clips")
RAW_CLIPS_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "audio_clips_raw")
BRIDGE_POST_TIMEOUT_SEC = float(os.environ.get("BRIDGE_POST_TIMEOUT_SEC", "180"))


def _read_clip_b64(clip_id: str, folder: str) -> str | None:
    """Read a WAV clip from disk and return base64-encoded bytes."""
    if not clip_id:
        return None
    path = os.path.join(folder, f"{clip_id}.wav")
    try:
        with open(path, "rb") as f:
            return base64.b64encode(f.read()).decode("ascii")
    except FileNotFoundError:
        return None
    except Exception as e:
        logger.warning("Failed to read clip %s: %s", path, e)
        return None


def post_transcript(
    bridge_url,
    text,
    timestamp=None,
    feed_id=None,
    feed_label=None,
    audio_clip=None,
    raw_audio_clip=None,
    preprocess_meta=None,
    variants=None,
    city=None,
    segment_start_utc=None,
):
    """Fire-and-forget POST of a transcript line to the ingest endpoint.

    Includes base64-encoded audio clips so they're saved on the API server.
    Runs in a daemon thread so it never blocks the transcriber main loop.
    """
    def _send():
        payload: dict = {"text": text}
        if timestamp:
            payload["timestamp"] = timestamp
        if segment_start_utc:
            payload["segment_start_utc"] = segment_start_utc
        if feed_id:
            payload["feed_id"] = feed_id
        if feed_label:
            payload["feed_label"] = feed_label
        if audio_clip:
            payload["audio_clip"] = audio_clip
        if raw_audio_clip:
            payload["raw_audio_clip"] = raw_audio_clip
        if preprocess_meta:
            payload["preprocess_meta"] = preprocess_meta
        if variants is not None:
            payload["variants"] = variants
        if city:
            payload["city"] = city

        # Collect audio clips to upload alongside metadata
        audio_data: dict[str, str] = {}
        if raw_audio_clip:
            b64 = _read_clip_b64(raw_audio_clip, RAW_CLIPS_DIR)
            if b64:
                audio_data[f"{raw_audio_clip}_raw"] = b64
        if variants:
            for v in variants:
                cid = v.get("audio_clip")
                if cid:
                    b64 = _read_clip_b64(cid, AUDIO_CLIPS_DIR)
                    if b64:
                        audio_data[cid] = b64
        elif audio_clip:
            b64 = _read_clip_b64(audio_clip, AUDIO_CLIPS_DIR)
            if b64:
                audio_data[audio_clip] = b64

        if audio_data:
            payload["audio_data"] = audio_data

        body = json.dumps(payload).encode("utf-8")
        req = Request(
            bridge_url,
            data=body,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urlopen(req, timeout=BRIDGE_POST_TIMEOUT_SEC) as resp:
                logger.info("Bridge POST %d (%d clips): %s",
                            resp.status, len(audio_data), text[:60])
        except URLError as e:
            logger.warning("Bridge POST failed: %s", e)
        except Exception as e:
            logger.warning("Bridge POST error: %s", e)

    t = threading.Thread(target=_send, daemon=True)
    t.start()
