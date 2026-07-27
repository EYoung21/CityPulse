# CityPulse

**Google Maps tells you the fastest way. PhillyPulse tells you the safest.**

CityPulse is a safety-aware navigation tool for Philadelphia, New York City,
San Francisco, and Chattanooga. It imports free public incident data, applies
privacy filters, plots incidents on an interactive map, and routes users around
recent hazards while walking, biking, or driving.

The former Broadcastify audio and Lambda GPU pipeline is retired. The old
transcriber and archive utilities remain in the repository only as historical
reference and are not started by the production deployment.

**Live demo:** [https://phlpulse.com](https://phlpulse.com)

---

## Team

- **Team name:** PhillyPulse
- **Team members:** Eli Young, Kethan Umanarayanan, Harsh Mahani

## Challenges Implemented

- **Challenge 1 — Trust Accelerator Campaign:** PhillyPulse itself is a public-facing demonstration of Inhibitor in production. Every incident on the map passed through Inhibitor's guardrails, and the app surfaces full transparency stats (processed / passed / blocked counts) so users can see the trust layer working in real time.
- **Challenge 2 — Inhibitor Innovation (Track A — Build with Inhibitor):** PhillyPulse is an original agent-powered system where Inhibitor serves as the critical safety gate between AI-extracted scanner data and public-facing map pins. Every LLM extraction is validated through Inhibitor before it can appear on the map — blocking PII, hallucinations, and harmful content.
- **Challenge 3 — Glass Box (Audit Dashboard):** The admin panel provides full pipeline visibility: every extraction shows its LLM prediction, confidence score, Inhibitor status (passed/blocked with reason), and geocode result. Admins can filter to only map-published incidents, toggle visibility, delete, and re-run predictions.

## How It Works

1. **Import** — Official public-data adapters poll each city's incident or
   alert source. Vercel refreshes a source on demand under a Firestore lease;
   the optional `citypulse-public-sources` systemd service can poll continuously.
2. **Protect** — The importer removes exact street numbers, rounds public
   coordinates, and suppresses calls involving minors or sensitive personal
   circumstances.
3. **Classify** — Source-specific adapters normalize categories, severity,
   time, and location into one CityPulse incident schema.
4. **Store** — Incidents are persisted to Firebase Firestore. Browser access to
   incident documents is denied; entitlement-aware server APIs enforce the
   free-history window.
5. **Display** — The Next.js frontend renders incidents on a Leaflet map with
   severity-coded markers, heatmaps, time decay, category filters, and a ticker.
6. **Route** — OpenRouteService builds direct and safer route alternatives
   around active high-severity incidents.
7. **Score** — Users can tap the map for a location safety score based on
   nearby incident density and severity.

Every pin on the map is labeled **UNVERIFIED**. PhillyPulse is a situational awareness tool, not a source of truth.

## Architecture

| Layer | Tech |
|-------|------|
| Incident sources | Hamilton County 911, DataSF, Philadelphia/Montgomery/Chester County open data, Notify NYC |
| Privacy processing | Source-specific suppression, block-level addresses, rounded public coordinates |
| Backend API | Python, FastAPI, uvicorn |
| Database | Firebase Firestore (prod) / SQLite (dev) |
| Frontend | Next.js 16, React 19, TypeScript, Tailwind CSS 4 |
| UI components | shadcn/ui, Leaflet, Framer Motion, Lucide React |
| Routing engine | OpenRouteService API |
| Hosting | Vercel (frontend; set `BACKEND_URL` to the FastAPI origin so `/api/*` rewrites work), dedicated server (backend) |
| Domain | phlpulse.com (GoDaddy) |

## Run Instructions

### Prerequisites

- Python 3.10+
- Node.js 18+
- Firebase service-account credentials
- API keys for the optional AI features and OpenRouteService

### Backend

```bash
git clone https://github.com/EYoung21/PhillyPulse.git
cd PhillyPulse

python -m venv venv
source venv/bin/activate

pip install -r requirements-philly-pulse.txt
# Configure environment
cp .env.example .env
# Edit .env with Firebase and optional feature credentials

# Start the API server
python -m uvicorn philly_pulse.server:app --host 0.0.0.0 --port 8000

# Optional: continuously refresh the public sources. The frontend API also
# refreshes them on demand, so this is not required for local UI development.
python -m philly_pulse.public_sources
```

### Frontend

```bash
cd frontend

npm install

# Configure environment
cp .env.local.example .env.local
# Edit .env.local with your Firebase config and API URL

npm run dev
```

The frontend will be available at `http://localhost:3000`.

### Web Push (optional)

Closed-tab notifications use VAPID Web Push. The backend signs every
push with a keypair you generate once per deployment.

```bash
# 1. Generate a VAPID keypair (writes three KEY=value lines to stdout)
python scripts/generate_vapid_keys.py

# 2. Paste them into your env file and edit the SUBJECT email
# 3. Restart the backend
```

When the env vars are missing the `/api/push/*` endpoints stay live
but report `configured: false`, and the in-app push toggle surfaces a
"server isn't configured yet" hint instead of crashing. Browsers can
still subscribe in that state — they just won't receive anything
until the server side comes online.

The frontend service worker only registers in production builds, so
local push testing requires `npm run build && npm start` rather than
`npm run dev`.

#### Closed-tab commute predictions (optional)

When a signed-in user with push enabled has a recurring commute
pattern, the client uploads a tiny `commuteSchedules` document to
Firestore. To fire the actual notification when the tab is closed,
point an external scheduler at `POST /api/push/tick-commutes` every
1–2 minutes:

```bash
# Set a long random secret on the backend
PHILLY_PULSE_COMMUTE_TICK_SECRET="<long random string>"

# Then call from cron / GH Actions / Cloud Scheduler:
curl -X POST https://api.phlpulse.com/api/push/tick-commutes \
  -H "Authorization: Bearer $PHILLY_PULSE_COMMUTE_TICK_SECRET"
```

The endpoint is a no-op (`503`) when the secret env var isn't set,
so leaving it unconfigured in dev is safe. The same scheduler can
drive future server-fired triggers; the response includes `scanned`
/ `fired` / `skipped` counts for monitoring.

### Production

- **Frontend** is deployed on Vercel at [phlpulse.com](https://phlpulse.com)
- **Vercel env:** set `BACKEND_URL=https://api.phlpulse.com` (no trailing slash) in the Vercel project so Next.js rewrites `https://www.phlpulse.com/api/*` to the Python API. Without it, `/api/incidents` and similar paths return 404. See `docs/MULTI_CITY_VERCEL_SETUP.md` for multi-city projects.
- **Backend API** runs on a dedicated server at `api.phlpulse.com` — if you see 502, fix the process/reverse proxy there; CORS console noise on `api.*` is often a side effect of error responses, not a separate CORS bug.
- **Transcriber** runs continuously on the same server, ingesting live scanner audio 24/7

## Key Features

- **Real-time incident mapping** — Live police scanner → AI pipeline → map pins in seconds
- **Safe routing** — Walk, bike, or drive routes that avoid active incident zones with clear time tradeoff
- **Safety scoring** — Tap anywhere for a 0–100 safety score based on nearby activity
- **Inhibitor guardrails** — Every extraction validated; PII, hallucinations, and harmful content blocked
- **Transparency dashboard** — Full visibility into Inhibitor pass/block stats
- **Admin panel** — Pipeline audit trail, re-transcription, prediction re-runs, visibility toggles, "On Map" filter
- **Cluster list view** — Overlapping incidents at the same location expand into a scrollable list
- **Heatmap overlay** — Density visualization with vivid gradients
- **District breakdown** — Neighborhood-level incident analysis
- **Time decay** — Older incidents fade; configurable time filters (1h to 30d)
- **Category filters** — Filter by violent, medical, fire, vehicle, property, disorder
- **AI neighborhood summaries** — GPT-generated plain-English safety briefings
- **Dark/light theme** — Full theme support
- **Mobile responsive** — Works on phone, tablet, and desktop

## Assumptions and Limitations

- Scanner audio quality varies; transcription accuracy depends on signal clarity and dispatcher speaking patterns
- Geocoding relies on location text extracted by the LLM, which may be incomplete or ambiguous — the LLM fallback helps but is not perfect
- All incidents are labeled **UNVERIFIED** — this is a situational awareness tool, not a verified crime database
- The Inhibitor API blocks content that could cause harm, which means some real incidents may be filtered out (this is by design)
- Safe routing adds avoid zones around incidents but cannot guarantee safety — it reduces exposure to known reported activity
- Currently covers the **Greater Philadelphia metro** — Philadelphia plus **Delaware County, Chester County, Montgomery County, and Bucks County** (including citywide + sector feeds, plus Fire/EMS and transit where available).

## License and Copyright

Copyright (c) 2026 PhillyPulse Team (Eli Young, Kethan Umanarayanan, Harsh Mahani)

This team's submission is provided under the MIT License.

SPDX-License-Identifier: MIT
