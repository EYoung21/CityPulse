# Transcript relaunch policy

Status: approved launch baseline, version `2026-07-27`. The audio/transcript
pipeline remains retired. CityPulse currently imports structured government
incident sources and does not need scanner audio or public transcripts.

The legacy `/api/ingest` and `/api/audio/upload` endpoints fail closed unless a
future deployment explicitly sets both:

- `PHILLY_PULSE_AUDIO_INGEST_ENABLED=1`
- `PHILLY_PULSE_TRANSCRIPT_POLICY_ACCEPTED_VERSION=2026-07-27`

Changing the version below intentionally requires a new deployment
acknowledgement.

## Publication rules

Raw transcripts and raw audio are private source material and must never be
returned by a public API, rendered in a public page, indexed, included in a
social preview, or placed in a client-readable Firestore document. Public
output may contain only a newly generated, policy-filtered incident summary.

Before publication, remove:

- names, initials when identifying, dates of birth, phone numbers, email
  addresses, usernames, and government or medical identifiers;
- exact house or apartment numbers, room numbers, access codes, vehicle plates,
  and other details that identify a home, person, patient, victim, witness, or
  caller;
- medical diagnoses, medications, symptoms, reproductive or sexual details,
  immigration information, and details of domestic or family relationships;
- race, ethnicity, nationality, religion, disability, sex, sexual orientation,
  gender identity, and other sensitive personal traits when tied to a person.

Do not merely replace a name if the remaining combination of details could
still identify the person. Suppress the entire incident instead.

## Minors and sensitive incidents

Suppress the entire public incident when the source indicates:

- a child, minor, juvenile, student, or otherwise age-identifiable young person;
- domestic or sexual violence, abuse, stalking, trafficking, or exploitation;
- suicide, self-harm, mental-health crisis, overdose, welfare check, or a
  missing, endangered, or otherwise vulnerable person;
- a victim, patient, witness, or caller whose identity could be inferred after
  redaction.

There is no public-interest exception in the automated pipeline. Any future
exception requires documented human editorial review before publication.

## Public location precision

Public text may name only an intersection, landmark, road segment, or hundred
block. Remove exact street and unit numbers. Public coordinates must be rounded
to three decimal places (roughly 80–110 metres in supported cities), and must
be omitted or coarsened further when the context could still identify a home,
patient, victim, witness, caller, or minor.

## Required launch checks

Before audio ingestion is enabled in any environment that can publish:

1. Run synthetic redaction tests for every field above, including combinations
   that become identifying only when joined.
2. Prove that raw transcripts/audio are inaccessible through public APIs,
   browser-readable Firestore rules, storage rules, search, exports, and social
   previews.
3. Test false negatives for minors and every sensitive-incident category.
4. Verify that any policy failure, unavailable classifier, malformed output, or
   low-confidence result fails closed and publishes nothing.
5. Review a representative sample manually and record the approval and policy
   version in the release checklist.

Processed public audio is out of scope for this version and remains disabled.
