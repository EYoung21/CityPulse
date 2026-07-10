# CityPulse feed-source options after the Broadcastify ban (2026-07)

Broadcastify banned the PhillyPulse account for automated access (ToS). This
summarizes the free/legit replacement options researched 2026-07-10.

## Headline
- **Chattanooga can come back RIGHT NOW, free, with NO audio + NO GPU** via the
  Hamilton County 911 CAD JSON API — police+fire+EMS, exact lat/lng, 60s refresh.
- CAD feeds return *structured* incidents (type/location/coords/time), so cities
  on CAD need no Whisper transcription and no Ollama LLM extraction — i.e. no GPU.

## Best official CAD / active-incident feeds (remote-pullable, no hardware)
| Metro | Endpoint | Coverage | Geo | Cadence | Verdict |
|---|---|---|---|---|---|
| **Chattanooga / Hamilton Co TN** | `https://hc911server.com/api/calls` (header `X-Frontend-Auth: my-secure-token`) | Police+Fire+EMS | exact lat/lng | 60s JSON | ✅✅ full replacement |
| **SF – police** | `https://data.sfgov.org/resource/gnap-fj3t.json` (SODA) | Police | intersection lat/lng | ~10min, 48h retention | ✅ live police |
| **SF – fire/EMS** | `data.sfgov.org/resource/nuek-vuh3.json` | Fire+EMS | intersection | daily batch | 🔶 not live |
| **Montgomery Co PA** | `https://webapp07.montcopa.org/eoc/cadinfo/livecadrss.asp` (RSS) | Fire/EMS/Traffic | cross-streets+muni | ~5min | ✅ (no police) |
| **Chester Co PA** | `https://webcad.chesco.org/WebCad/` (HTML) | Fire/EMS/Traffic | addr+muni | 60s | ✅ (no police) |
| **Philadelphia city** | `phl.carto.com/api/v2/sql … incidents_part1_part2` | Police reports | lat/lng | daily | 🔶 not live dispatch |
| **Delaware Co PA** | none official | — | — | — | ❌ |
| **NYC (NYPD/FDNY/EMS)** | NYC Open Data sets | all | mixed | batch, weeks–1yr stale | ❌ audio-only |

## Audio (OpenMHz / self-host SDR) — for where CAD has gaps
- OpenMHz is behind Cloudflare (server polling blocked) + volunteer-dependent; not a clean drop-in.
- Encryption is a hard ceiling everywhere: SFPD, NYPD precincts, MontCo police — gone from every source.
- Free audio coverage: Chattanooga ~85-90%, Philadelphia ~75-85% (phillytrs), NYC ~55-65% (FDNY), SF ~15%.
- Legit paid audio: Broadcastify **Calls API** (metered/prepaid, apply via bcfy.io/dev — self-serve on approval) or Live Audio Catalog ($2,500/mo).

## Recommended direction
1. **Chattanooga → Hamilton Co 911 CAD API now** (free, structured, no GPU). This is also the dad's-newsroom city.
2. **SF → DataSF police CAD** (live) + accept/gap fire-EMS (or Calls API).
3. **Philly → suburbs on MontCo/Chester CAD** (fire/EMS) + city audio via Calls API or OpenMHz.
4. **NYC → hardest**; audio-only, mostly encrypted; deprioritize or Calls-API FDNY.
