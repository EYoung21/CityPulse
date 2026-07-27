# CityPulse

**Google Maps tells you the fastest way. PhillyPulse tells you the safest.**

CityPulse is a safety-aware navigation tool for Philadelphia, New York City,
San Francisco, and Chattanooga. It imports free public incident data, applies
privacy filters, plots incidents on an interactive map, and routes users around
recent hazards while walking, biking, or driving.

The former Broadcastify audio and Lambda GPU pipeline is retired. The old
transcriber and archive utilities remain in the repository only as historical
reference and are not started by the production deployment. Any future audio
relaunch is blocked by the versioned
[transcript relaunch policy](docs/TRANSCRIPT-RELAUNCH-POLICY.md).

**Live demo:** [https://phlpulse.com](https://phlpulse.com)

---

## Team

- **Team name:** PhillyPulse
- **Team members:** Eli Young, Kethan Umanarayanan, Harsh Mahani

## Challenges Implemented

The challenge descriptions below document the original scanner-era submission.
The current production importer uses the structured-source privacy pipeline
described in **How It Works** and does not claim that every new source row is an
LLM/Inhibitor extraction.

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
| Public API | Next.js route handlers on Vercel |
| Legacy/admin API | Python, FastAPI, uvicorn (not required for the public map) |
| Database | Firebase Firestore (prod) / SQLite (dev) |
| Frontend | Next.js 16, React 19, TypeScript, Tailwind CSS 4 |
| UI components | shadcn/ui, Leaflet, Framer Motion, Lucide React |
| Routing engine | TomTom when configured, with Valhalla/OpenStreetMap fallbacks |
| Hosting | Vercel (app + public API), Firebase Firestore |
| Domain | phlpulse.com (GoDaddy) |

## Run Instructions

### Prerequisites

- Python 3.10+
- Node.js 20+
- Firebase service-account credentials
- API keys for the optional AI features and OpenRouteService

### Legacy/admin backend (optional)

```bash
git clone https://github.com/EYoung21/PhillyPulse.git
cd PhillyPulse

python -m venv venv
source venv/bin/activate

pip install -r requirements-philly-pulse.txt
# Configure Firebase and optional legacy/admin credentials in your shell.
# Copy the checked-in non-secret tuning template only if you need it:
cp config.yaml.example config.yaml

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
cp .env.example .env.local
# Edit .env.local with your Firebase config and API URL

npm run dev
```

The frontend will be available at `http://localhost:3000`.

### Web Push

Closed-tab Web Push, keyword watches, and commute pushes are temporarily
paused while the retired Python/audio backend is replaced. The same-origin
`/api/push/public-key` capability probe deliberately reports
`configured: false`; the settings UI keeps in-app alerts available and does
not attempt to create a server subscription.

### Production

- **Frontend** is deployed on Vercel at [phlpulse.com](https://phlpulse.com)
- **Public APIs** run as same-origin Next.js routes on Vercel and read
  entitlement-aware data from Firestore.
- **Ingestion** polls structured public sources under Firestore leases; no
  Broadcastify, scanner transcriber, or Lambda GPU instance is required.
- `BACKEND_URL` remains only as a fallback rewrite for dormant legacy/admin
  routes and must not be treated as a dependency of the public map.

## Key Features

- **Recent incident mapping** — Structured public sources → privacy reduction → map pins
- **Safe routing** — Walk, bike, or drive routes that avoid active incident zones with clear time tradeoff
- **Safety scoring** — Tap anywhere for a 0–100 safety score based on nearby activity
- **Privacy guardrails** — Sensitive calls suppressed, exact addresses reduced, and public coordinates rounded
- **Transparency dashboard** — Aggregate public-source and community-moderation health
- **Moderation panel** — Admin review tools for user-submitted reports
- **Legacy admin source** — Historical audio/transcript pipeline UI retained in source but hidden while that backend is retired
- **Cluster list view** — Overlapping incidents at the same location expand into a scrollable list
- **Heatmap overlay** — Density visualization with vivid gradients
- **District breakdown** — Neighborhood-level incident analysis
- **Time decay** — Older incidents fade; configurable time filters (1h to 30d)
- **Category filters** — Filter by violent, medical, fire, vehicle, property, disorder
- **City activity summaries** — Deterministic recent-activity briefings
- **Dark/light theme** — Full theme support
- **Mobile responsive** — Works on phone, tablet, and desktop

## Assumptions and Limitations

- Public-source timeliness and detail vary by city; NYC coverage can be quiet
  when Notify NYC has no active alert.
- Source coordinates and location text may be incomplete, and are intentionally
  reduced further before publication.
- All incidents are labeled **UNVERIFIED** — this is a situational awareness tool, not a verified crime database
- The Inhibitor API blocks content that could cause harm, which means some real incidents may be filtered out (this is by design)
- Safe routing adds avoid zones around incidents but cannot guarantee safety — it reduces exposure to known reported activity
- Covers **Philadelphia**, **San Francisco**, **New York City**, and
  **Chattanooga**, with source availability varying by city.

## License and Copyright

Copyright (c) 2026 PhillyPulse Team (Eli Young, Kethan Umanarayanan, Harsh Mahani)

This team's submission is provided under the MIT License.

SPDX-License-Identifier: MIT
