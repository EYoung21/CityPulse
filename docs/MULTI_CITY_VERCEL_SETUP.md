# Multi-City Vercel + Domain Setup Guide

This document covers the complete setup for deploying CityPulse to three new domains:

| Project Name | Domain | City Slug | City Name |
|---|---|---|---|
| `sfopulse` | `sfopulse.com` | `sf` | San Francisco |
| `nycpulse` | `newyorkcitypulse.com` | `nyc` | New York City |
| `423pulse` | `423pulse.com` | `chattanooga` | Chattanooga |

All three share the same GitHub repo (`EYoung21/PhillyPulse`), the same Firebase project (`phlpulse`), and the same backend API (`api.phlpulse.com`). The only differences are the city-specific environment variables that control data filtering and branding.

---

## Prerequisites

- GoDaddy account with DNS access for all three domains
- Vercel account connected to the `EYoung21/PhillyPulse` GitHub repo
- The existing `phlpulse` Firebase project (no new Firebase setup needed)

---

## Part 1: Create Vercel Projects

Repeat these steps three times — once for each city.

### 1.1 Go to [vercel.com/new](https://vercel.com/new)

- Select **Import Git Repository**
- Choose **EYoung21/PhillyPulse** from the repo list
- Branch: **main**

### 1.2 Configure the project

| Setting | Value |
|---|---|
| **Project Name** | See table below |
| **Framework Preset** | Next.js (should auto-detect) |
| **Root Directory** | Click **Edit**, change `./` to **`frontend`** |

> **Important:** You must change the Root Directory to `frontend`. The Next.js app is in `frontend/`, not the repo root. If you skip this, the build will fail.

### 1.3 Set Environment Variables

Expand the **Environment Variables** section and add all of the following.

#### Shared variables (same for all three projects)

These are identical across all city deployments:

```
# Required: Next rewrites /api/* → this origin. No trailing slash. Without it, /api/incidents 404s on the Vercel domain.
BACKEND_URL                              = https://api.phlpulse.com
NEXT_PUBLIC_API_URL                      = https://api.phlpulse.com
NEXT_PUBLIC_FIREBASE_API_KEY             = AIzaSyAu3krAALwmLhvIzmSal8ZVoydzBy2kRXs
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN         = phlpulse.firebaseapp.com
NEXT_PUBLIC_FIREBASE_PROJECT_ID          = phlpulse
NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET      = phlpulse.firebasestorage.app
NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID = 609403849368
NEXT_PUBLIC_FIREBASE_APP_ID              = 1:609403849368:web:b0a6871aed39203685deed
```

**If the map never loads and the browser shows `GET https://www…/api/incidents` → 404:** `BACKEND_URL` is missing or still points at localhost. Redeploy after fixing.

**If `https://api.phlpulse.com` returns 502:** the FastAPI process or reverse proxy on the Hetzner box is down — fix the server; “CORS blocked” in the console when calling `api.*` from `www` is often from 502/edge error pages lacking `Access-Control-Allow-Origin`, not a misconfigured CORS middleware.

#### City-specific variables

##### sfopulse

```
NEXT_PUBLIC_CITY_SLUG = sf
NEXT_PUBLIC_CITY_NAME = San Francisco
NEXT_PUBLIC_SITE_NAME = SFOPulse
```

##### nycpulse

```
NEXT_PUBLIC_CITY_SLUG = nyc
NEXT_PUBLIC_CITY_NAME = New York City
NEXT_PUBLIC_SITE_NAME = NYCPulse
```

##### 423pulse

```
NEXT_PUBLIC_CITY_SLUG = chattanooga
NEXT_PUBLIC_CITY_NAME = Chattanooga
NEXT_PUBLIC_SITE_NAME = 423Pulse
```

### 1.4 Deploy

Click **Deploy**. Wait for the build to complete. Vercel will assign a temporary `.vercel.app` URL. Verify the site loads and shows the correct city name before proceeding.

---

## Part 2: Add Custom Domains in Vercel

For each project, after the initial deploy succeeds:

1. Go to **Project Settings** (gear icon)
2. Click **Domains** in the left sidebar
3. Add your custom domain(s):

| Project | Domains to add |
|---|---|
| `sfopulse` | `sfopulse.com`, `www.sfopulse.com` |
| `nycpulse` | `newyorkcitypulse.com`, `www.newyorkcitypulse.com` |
| `423pulse` | `423pulse.com`, `www.423pulse.com` |

Vercel will show a warning that the domain isn't configured yet — that's expected. It will display the DNS records you need to set. They should match what's below, but always use the values Vercel shows you.

**Recommended:** Set `www` to redirect to the apex domain (e.g., `www.sfopulse.com` → `sfopulse.com`). Vercel gives you this option when adding the `www` variant.

---

## Part 3: Configure DNS in GoDaddy

For **each** of the three domains, go to [GoDaddy DNS Management](https://dcc.godaddy.com/manage-dns):

### 3.1 Delete default records

GoDaddy sets default A records that point to their parking page. You'll see records like:

```
A    @    13.248.243.5
A    @    76.223.105.230
```

**Delete all existing A records for `@`** and any existing CNAME for `www`.

### 3.2 Add DNS records — **copy from Vercel, not from this doc**

**Source of truth:** For each domain, open **Vercel → your project → Settings → Domains**, click the domain (apex and `www` are listed separately), and copy the **exact** **Type**, **Name**, and **Value** Vercel shows under “DNS Records”.

- The **apex** (`example.com`) is usually an **A** record for `@` pointing at a Vercel IP (e.g. `216.150.1.1` as of Vercel’s 2026 IP expansion).
- **`www`** is usually a **CNAME** pointing at a **project-specific** hostname like `xxxxxxxx.vercel-dns-016.com.` (the hex string is **different per domain / project**).

**Do not** paste another project’s `www` CNAME into a different domain. **423pulse** and **newyorkcitypulse** will have **different** `www` targets — each must match what **that** project’s Domains page shows.

#### Legacy records (still valid, not recommended)

Vercel has stated that older values still work:

| Type | Name | Value (legacy) |
|---|---|---|
| A | `@` | `76.76.21.21` |
| CNAME | `www` | `cname.vercel-dns.com` |

If your Vercel UI recommends `216.150.1.1` and a `*.vercel-dns-016.com` host, **use those** — they are the current recommendation.

#### What you did in GoDaddy

If you already entered **exactly** what Vercel showed for **423pulse** and **newyorkcitypulse** (e.g. `216.150.1.1` + `b86bb5ac4203f130.vercel-dns-016.com.` / `0ed78ee5bea1bba9.vercel-dns-016.com.`), that is **correct**. You do **not** need to switch back to `76.76.21.21` / `cname.vercel-dns.com` from an older guide.

### 3.3 Per-domain checklist

For **each** of `sfopulse.com`, `newyorkcitypulse.com`, and `423pulse.com`:

1. In GoDaddy DNS: remove **A @** parking / wrong IPs and any **CNAME www** that does not match Vercel.
2. Add the **A @** and **CNAME www** values shown on **that** project’s Vercel Domains page.
3. Leave **NS**, **SOA**, **MX**, **TXT** (e.g. `_dmarc`), and **`_domainconnect`** unless you know you are changing email or another service.

### 3.4 Wait for propagation

DNS changes typically propagate in 5–30 minutes. Verify with `dig` — the apex should match **whatever IP Vercel gave you** for that project:

```bash
dig +short 423pulse.com
dig +short www.423pulse.com
# CNAME should chain to Vercel’s hostnames
```

---

## Part 4: Verify in Vercel

After DNS propagates, go back to each Vercel project's **Domains** settings. The domain status should change from a warning to a green checkmark. Vercel automatically provisions SSL certificates — this may take a few minutes after DNS is confirmed.

If a domain shows "Invalid Configuration", double-check that:
- The old GoDaddy parking A records are deleted
- The **A** record for `@` matches **exactly** what Vercel shows for the **apex** domain (today often `216.150.1.1`; older docs used `76.76.21.21`)
- The **CNAME** for `www` matches **exactly** what Vercel shows for that project (often `*.vercel-dns-016.com.` — **per-project**, not generic `cname.vercel-dns.com`)

---

## Part 5: Firestore Composite Index

The frontend queries Firestore with `where("city", "==", slug).orderBy("reported_at", "desc")`. This requires a composite index.

### Option A: Click the error link (easiest)

1. Open any of the new city sites in your browser
2. Open the browser DevTools console (Cmd+Option+J)
3. You'll see an error with a direct link to create the missing index
4. Click the link — it opens Firebase Console with the index pre-filled
5. Click **Create Index** and wait ~2 minutes

### Option B: Create manually

1. Go to [Firebase Console](https://console.firebase.google.com/) → `phlpulse` project
2. Navigate to **Firestore Database** → **Indexes** tab
3. Click **Create Index**
4. Configure:

| Field | Setting |
|---|---|
| Collection ID | `incidents` |
| Field 1 | `city` — Ascending |
| Field 2 | `reported_at` — Descending |
| Query scope | Collection |

5. Click **Create** and wait for it to build (1-3 minutes)

You only need to create this index once — it applies to all city queries.

---

## Part 5b: Firebase Authentication (required for sign-in on new domains)

Custom hostnames must be allowlisted, and **guest (anonymous) sign-in** must be turned on if you use “Continue as guest.”

### Authorized domains

1. Open [Firebase Console](https://console.firebase.google.com/) → project **phlpulse**
2. **Authentication** → **Settings** → **Authorized domains**
3. Add **each** of (apex + `www` for every Pulse site you use):

   - `phlpulse.com`, `www.phlpulse.com`
   - `sfopulse.com`, `www.sfopulse.com`
   - `newyorkcitypulse.com`, `www.newyorkcitypulse.com`
   - `423pulse.com`, `www.423pulse.com`
   - Your Vercel preview hosts if you use OAuth on previews (optional), e.g. `*.vercel.app`

Without this, **Google sign-in** can fail with an “unauthorized domain” error after the app loads.

### Anonymous (guest) sign-in

1. **Authentication** → **Sign-in method**
2. Enable **Anonymous** and **Save**

If Anonymous is off, the app shows an error when the user taps **Continue as guest**.

---

## Part 6: Verify Everything Works

For each domain, check:

- [ ] **Site loads** at `https://sfopulse.com` (or the respective domain)
- [ ] **SSL is active** (padlock icon in browser, no certificate warnings)
- [ ] **Correct city name** appears in the header/title (e.g., "SFOPulse", not "PHLPulse")
- [ ] **Incidents are city-filtered** — only that city's incidents show on the map
- [ ] **Map is centered** on the correct city (not Philadelphia)
- [ ] **Audio playback** works on incidents that have clips
- [ ] **`www` redirects** to the apex domain (e.g., `www.sfopulse.com` → `sfopulse.com`)

---

## Troubleshooting

### Build fails on Vercel

- **"Module not found"**: Root Directory is probably still `./` — change it to `frontend`
- **Missing env vars**: Make sure all `NEXT_PUBLIC_*` variables are set. The build needs them at build time, not just runtime

### Vercel shows `404: NOT_FOUND` (even when Domains say “Valid Configuration”)

DNS can be correct while **no production deployment** is serving that hostname. Do this in order:

1. **Open the default Vercel URL** for that project (e.g. `423-pulse.vercel.app`, `nyc-pulse-six.vercel.app`).  
   - If **this also 404s**, the project has **no successful Production deployment** — open **Deployments**, fix the failed build, or **Redeploy** the latest `main`.
   - If the `.vercel.app` URL **works** but the custom domain **404s**, continue below.

2. **Confirm the domain is on the same project** as the working deployment: **Settings → Domains** — the custom domain must list that project (not an old or duplicate project).

3. **Try `www` vs apex** in the browser (e.g. `https://www.423pulse.com` vs `https://423pulse.com`).  
   If you configured a **307 redirect** from apex → `www`, both should eventually work; if only one works, compare GoDaddy DNS for **A @** and **CNAME www** to the exact values Vercel shows for **each** row in Domains.

4. **Redeploy after adding domains**: **Deployments → … → Redeploy** (optional: “Clear cache and redeploy”) so Production is rebuilt with the current domain assignment.

5. **Hard refresh / another network** to avoid stale DNS or browser cache.

### Site loads but shows Philadelphia data (map, labels, geocode)

- **Set Vercel env vars** for that project: `NEXT_PUBLIC_CITY_SLUG`, `NEXT_PUBLIC_CITY_NAME`, `NEXT_PUBLIC_SITE_NAME` (see Part 1). They are baked in at build time for metadata and are the most reliable fix.
- The app also **infers the city from the production hostname** (e.g. `sfopulse.com` → San Francisco) for the **map center**, **in-app titles**, and **address search**, so the site can still behave correctly if env vars were omitted—**after** you redeploy with a current `main` build.
- Browser tab **title** / **metadata** still come from `layout.tsx` and **only** use `NEXT_PUBLIC_CITY_NAME` / `NEXT_PUBLIC_SITE_NAME` at build time; add those in Vercel so SEO and the tab title match the city.
- The Firestore composite index must exist (check browser console for the error link).

### HOT SPOTS still list Philadelphia neighborhoods

- The sidebar **HOT SPOTS** list is still backed by Philadelphia polygons in `neighborhoods.ts`. Multi-city neighborhood breakdowns are not wired yet; incident **pins** and **counts** are still correct for your `city` filter.

### Site loads but shows no incidents

- The city may not have enough data yet. Check incident counts:
  - SF: ~113 incidents
  - Chattanooga: ~197 incidents  
  - NYC: ~5 incidents (backfill is running to add more)

### Domain shows "DNS Not Configured" in Vercel

- DNS hasn't propagated yet (wait 15 minutes)
- Old GoDaddy A records are still present (delete them)
- You added the domain to the wrong Vercel project

### SSL certificate not provisioning

- Vercel auto-provisions SSL after DNS is confirmed. If it's been more than 30 minutes, check that no CAA records in GoDaddy are blocking certificate issuance

---

## Reference: Existing Setup (phlpulse.com)

For comparison, here's how the existing Philadelphia deployment is configured:

| Setting | Value |
|---|---|
| Vercel Project | `philly-pulse` (or similar) |
| Domain | `phlpulse.com` |
| Root Directory | `frontend` |
| `NEXT_PUBLIC_CITY_SLUG` | `philly` (default, doesn't need to be set) |
| `NEXT_PUBLIC_CITY_NAME` | `Philadelphia` (default) |
| `NEXT_PUBLIC_SITE_NAME` | `PHLPulse` (default) |
| API subdomain | `api.phlpulse.com` → `87.99.157.115` (Hetzner) |

The new cities use the same API at `api.phlpulse.com` — there is no per-city API subdomain needed.

---

## Adding More Cities in the Future

To add a new city (e.g., `memphispulse.com`):

1. Ensure the city has a config at `cities/<slug>/config.yaml` with feeds
2. Ensure the transcriber is running for that city on Lambda
3. Create a new Vercel project following Parts 1-2 above
4. Set DNS following Part 3
5. The Firestore index from Part 5 already covers all cities
