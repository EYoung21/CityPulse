# Audio Re-transcription Backlog

All audio clips created **before** commit `df32128` (Apr 14, 2026) lack
word-level timing data (`word_timings`). The frontend falls back to a
linear estimate for these clips, so word highlighting won't match the
actual audio.

## Scope

| Item | Count |
|------|-------|
| Processed clips (`audio_clips/`) | 28,302 |
| Raw clips (`audio_clips_raw/`) | 28,835 |
| Location | Hetzner server `87.99.157.115:/root/PhillyPulse/audio_clips/` |

All clips are WAV files (16 kHz mono PCM) ready for re-transcription.

## What needs to happen

1. **Re-transcribe** each `.wav` in `audio_clips/` using faster-whisper
   with `word_timestamps=True`
2. **Match** each clip ID to its Firestore incident document (the
   `audio_clip` field on the incident stores the clip ID)
3. **Update** the Firestore document with the new `word_timings` array

## Recommended approach

```bash
# On a Lambda GPU instance (A10 or better):
# 1. Copy clips from Hetzner
rsync -avz root@87.99.157.115:/root/PhillyPulse/audio_clips/ ./audio_clips/

# 2. Run batch re-transcription script (to be written)
python3 retranscribe_backlog.py --clips-dir ./audio_clips/ --model large-v3

# 3. Script should:
#    - Load each .wav
#    - Run model.transcribe(audio, word_timestamps=True)
#    - Extract word timings [{word, start, end}, ...]
#    - Update Firestore: db.collection("incidents")
#        .where("audio_clip", "==", clip_id)
#        .update({"word_timings": timings})
```

## Prerequisites

- [ ] Lambda GPU credits approved ($10K grant)
- [ ] Firebase service account key on the Lambda instance
- [ ] `retranscribe_backlog.py` script written
- [ ] Hetzner SSH access to rsync clips

## Priority

Low — existing incidents still play audio with approximate highlighting.
New incidents (after the transcriber restart) will have accurate
word-level sync automatically.
