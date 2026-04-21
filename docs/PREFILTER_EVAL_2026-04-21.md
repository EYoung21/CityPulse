# LLM Prefilter Evaluation — 2026-04-21

This file is the durable record of the first production evaluation of the
regex prefilter introduced in commit `bff3c6e` and tuned in commit
`ccbaeac`. Future agents tuning the prefilter should read this first
before touching `philly_pulse/data/prefilter_default.yaml` or any
`cities/<slug>/prefilter.yaml`.

## TL;DR

| | Value |
|---|---|
| Window | last 7 days (2026-04-14 → 2026-04-21) |
| Total extractions evaluated | 197,296 |
| Cities | philly, sf, nyc, chattanooga, dallas, frisco, seattle |
| Overall recall (post-tune) | **99.96 %** |
| Overall drop rate (post-tune) | **5.21 %** |
| Estimated $/mo saved at this drop rate | $11.89 |
| Recall target | ≥99 % ✓ |
| Drop-rate target | ≥30 % ✗ (we are well below — see "Open work") |

## Architecture recap

The prefilter is a **blocklist + universal-incident escape hatch**:

1. If the transcript matches ANY `noise_pattern` AND contains NO
   `keep_keyword`, the prefilter returns `False` → skip the LLM call.
2. In every other case (no noise hit, OR noise hit but a real incident
   keyword is also present), return `True` → pay for the LLM.

Files involved:

- `philly_pulse/prefilter.py` — runtime
- `philly_pulse/data/prefilter_default.yaml` — shared baseline
- `cities/<slug>/prefilter.yaml` — per-city extensions (additive only;
  there is no way to *remove* a default from a city file by design)
- `philly_pulse/server.py` `/api/ingest` — the only caller
- `philly_pulse/firestore_store.py` — writes `prefilter_status` and
  `prefilter_reason` onto every extraction row for postmortem

The eval harness lives at `scripts/eval_prefilter.py`. It re-runs the
*current* prefilter against historical Firestore extractions. Ground
truth is `llm_relevant=True`, which is the LLM's own decision — the
best signal we have without paying a human to label.

## Run command (verbatim)

```bash
GOOGLE_APPLICATION_CREDENTIALS=/Users/eliyoung/PhillyPulse/.secrets/firebase-service-account.json \
  python3 scripts/eval_prefilter.py --days 7 \
  --false-drops-out /tmp/pp_false_drops.jsonl
```

`--days` defaults to 7. Crank to 30 once you have the composite index
on `extractions(reported_at)` warmed up — the paginated streamer in
`scripts/eval_prefilter.py` (added in `ccbaeac`) handles arbitrary
volume, but each Firestore page costs read units.

## First run — pre-tune (commit `bff3c6e`)

```
City              Total  Relevant  WouldSkip   Drop%   Recall   $/mo saved
chattanooga      33,837     3,065        487   1.44%  100.00% $    0.56
dallas            4,521       458         14   0.31%  100.00% $    0.02
frisco            1,902        92         21   1.10%  100.00% $    0.02
nyc               9,937       343        137   1.38%  100.00% $    0.16
philly          124,954     5,745      9,522   7.62%   99.65% $   11.02
seattle           2,593       407         22   0.85%  100.00% $    0.03
sf               19,545     1,973        108   0.55%  100.00% $    0.12
TOTAL           197,290    12,083     10,311   5.23%   99.83% $   11.93
```

20 false drops, all in Philly, all with the same root cause: Whisper
hallucinates the literal string `PPD districts 1-26` at the *start* of
many transcripts and then continues with real dispatch text. The
noise pattern fires correctly; the keyword safety net was missing
common EMS phrasings like "heart problem", "panic attack", "trouble
breathing", "head injury", "fall victim", "battery", "suicide".

## Second run — post-tune (commit `ccbaeac`)

```
City              Total  Relevant  WouldSkip   Drop%   Recall   $/mo saved
chattanooga      33,836     3,063        487   1.44%  100.00% $    0.56
dallas            4,521       458         14   0.31%  100.00% $    0.02
frisco            1,902        92         21   1.10%  100.00% $    0.02
nyc               9,931       343        137   1.38%  100.00% $    0.16
philly          124,962     5,748      9,490   7.59%   99.91% $   10.98
seattle           2,593       407         22   0.85%  100.00% $    0.03
sf               19,550     1,973        108   0.55%  100.00% $    0.12
TOTAL           197,296    12,084     10,279   5.21%   99.96% $   11.89
```

False drops Philly **20 → 5** (then **5 → 2** after appending `pain`,
`argument`, `chasing`). Recall jumped 99.83 → 99.96 %. Drop rate barely
moved (5.23 → 5.21 %) because the new keywords *unblock* lines the
prefilter would otherwise mistakenly skip — they don't add new skips.

## Production verification

Sampled the most recent 500 extractions on 2026-04-21 ~11:15 UTC
(~25 min after the post-tune deploy):

- 22 / 500 had `prefilter_status == "skipped"` → ~4.4 % drop rate,
  matching the eval.
- 26 / 500 had `llm_relevant == True`.
- All 7 cities appear in the live stream:
  philly 351, chattanooga 105, sf 36, nyc 8 (sample window only).

Conclusion: prefilter is live in production for both Lambda live
ingest and any backfill that posts to `/api/ingest`. There is no
separate code path; everything funnels through one endpoint.

## Open work

### 1. Drop rate is far below target (5.2 % vs 30 %+)

The keyword safety net is doing its job — recall is great. The
**bottleneck for cost savings is noise-pattern coverage**, not
keywords. To unlock more savings someone needs to:

- Re-run the eval with `--false-drops-out` *and* an additional
  ad-hoc dump of `prefilter_status="kept"` lines that ended in
  `llm_relevant=False`. Those are the lines we paid for and got
  nothing — every cluster among them is a candidate for a new
  noise pattern.
- Look at the Philly drop rate (7.59 %) vs SF (0.55 %) and Frisco
  (1.10 %). Either the per-city YAMLs for SF/Frisco need more
  patterns, or SF really is that quiet (unlikely — sample by hand
  before assuming).

### 2. Remaining 2 false drops in Philly

After the second tune they are:

1. A `medical_other` whose entire body is "Operating on
   self-medicine. Confirming report." Borderline garbage; LLM also
   barely classified it. Not worth a keyword.
2. A `robbery` that's 99% digit garbage with one "Units on location"
   sentence and zero keywords. Same story — the LLM was guessing.

Leave both alone. Adding keywords to catch these would be
overfitting to noise.

### 3. Re-run cadence

Add to a weekly checklist (or cron, eventually):

```bash
python3 scripts/eval_prefilter.py --days 7 \
  --false-drops-out /tmp/pp_false_drops_$(date +%Y%m%d).jsonl
```

Append a section to this file when recall, drop rate, or false-drop
patterns change materially. Do not rewrite history.

### 4. Composite index for `extractions(city, reported_at)`

The eval harness already paginates `(reported_at)` with
`order_by + start_after`, but per-city deep dives currently fail
without a composite. Create it via the link Firestore prints in the
exception, or via `firestore.indexes.json`. Skipped for this run
because cross-city aggregates were enough.

## What to NOT do

- **Don't remove a default keyword** because it "feels noisy". The
  YAML is additive on purpose. If a default keyword is dropping real
  signal, fix the *noise pattern* it's escaping, not the keyword.
- **Don't tighten a noise pattern in a per-city YAML.** Per-city
  files only extend; tighten in the default and re-eval all cities.
- **Don't believe a one-day eval.** Whisper's hallucination set
  shifts with audio quality and feed switches. Always pull at
  least 7 days.
