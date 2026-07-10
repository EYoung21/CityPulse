# Rebuild the "Lambda" live-transcription GPU host from scratch

Runbook for safely terminating the Lambda Labs A10 GPU box (`ubuntu@150.230.182.19`)
and redeploying later. Nothing unrecoverable is lost on terminate — see §1.

## Architecture recap (it does TWO jobs)
1. **Live transcription** — `pulse-live@<city>` runs `multi_transcriber.py` (Whisper on
   GPU) → `philly_pulse/bridge.py` → `POST https://api.phlpulse.com/api/ingest` on Hetzner.
2. **Ingest LLM extraction** — Hetzner API uses an LLM at `localhost:11435` → **reverse SSH
   tunnel** (`lambda-ollama-tunnel.service`) → **Ollama on the Lambda** (`:11434`, model
   `qwen2.5:7b-instruct-q5_K_M`). Ingest must stay on local Ollama (never Bedrock/DeepSeek).

Terminating kills both. NOTE: if cities move to **CAD/structured feeds**, transcription +
Ollama are unnecessary for those cities — you may not need this GPU at all.

## 1. What lives ONLY on the box (recreate on rebuild)
- `/opt/citypulse-backfill/config.yaml` — Broadcastify creds (banned now), VAD/tuning,
  model_size. On laptop `config.yaml` + Hetzner `/root/config.yaml`. Not at risk.
- `/etc/systemd/system/pulse-live@.service.d/ingest-secret.conf` — `PULSE_INGEST_SECRET`.
  Also on Hetzner `/etc/philly-pulse.env` and GH secret `PULSE_INGEST_SECRET`. Not at risk.
- Ollama + model `qwen2.5:7b-instruct-q5_K_M` — reinstall via `lambda_grab_gpu.py` bootstrap.
- `/etc/citypulse-backfill.env`, `.secrets/firebase-service-account.json` — backfill only.
- SSH trust: Hetzner `/root/.ssh/lambda_tunnel_key` pubkey must be in new box
  `authorized_keys`. Private key = GH secret `LAMBDA_TUNNEL_KEY`.
- GPU/CUDA (preinstalled on Lambda images), cuDNN pip-installed by the install script.
- Ops timers: `citypulse-clip-prune.timer` (or disk fills → crash loop),
  `citypulse-ollama-watchdog.timer`, `pulse-live.logrotate`.

## 2. Pre-terminate capture
1. `PULSE_INGEST_SECRET` also lives on Hetzner + GH secret — safe. (Optional belt-and-braces:
   `ssh -i .secrets/prod_lambda_tunnel_key ubuntu@150.230.182.19 'sudo cat /etc/systemd/system/pulse-live@.service.d/ingest-secret.conf'`)
2. `gh secret list` shows: `PULSE_INGEST_SECRET`, `LAMBDA_TUNNEL_KEY`, `LAMBDA_OLLAMA_IP`,
   `BROADCASTIFY_*`, `DEPLOY_HOST`, `DEPLOY_SSH_KEY` — all present. ✅
3. Laptop has `config.yaml`, `.secrets/prod_lambda_tunnel_key`, firebase SA.
4. Instance ID for termination (Lambda dashboard). Need `LAMBDA_CLOUD_API_KEY` to
   terminate via `scripts/lambda_grab_gpu.py --terminate` — **NOT currently in GH secrets**,
   so terminate from the Lambda Labs dashboard (or add the key).
5. **The IP changes on rebuild.** Hardcoded in ~20 files; the load-bearing one is
   `scripts/sync_lambda_live_transcribers.sh:9` (runs on every backend deploy, silently).
   Also `scripts/prod_setup_lambda_ollama.sh:36` + GH secret `LAMBDA_OLLAMA_IP`.

## 3. Rebuild (order)
1. `LAMBDA_CLOUD_API_KEY=… python scripts/lambda_grab_gpu.py --ssh-key-name <k> --ssh-key-path ~/.ssh/id_ed25519`
   — provisions `gpu_1x_a10`, installs Ollama + pulls the model, prints NEW_IP.
2. Add the Hetzner tunnel pubkey to the new box's `authorized_keys`.
3. `gh workflow run server-migrate-live-to-lambda.yml -f lambda_ip=NEW_IP -f active_cities="sf nyc philly philly2 chattanooga"`
   — rsyncs code + config from Hetzner and runs `install_lambda_live_transcribers.sh`.
4. Verify `/opt/citypulse-backfill/config.yaml` has real creds + `bridge_url=…/api/ingest`.
5. Recreate the `PULSE_INGEST_SECRET` drop-in (nothing else does).
6. Re-point the ingest-LLM tunnel: `gh secret set LAMBDA_OLLAMA_IP=NEW_IP` +
   `gh workflow run server-install-llm-tunnel.yml`; verify the unit's ExecStart uses NEW_IP.
7. Update the hardcoded IP in `sync_lambda_live_transcribers.sh:9` + friends; commit.
8. Install ops timers (clip-prune, ollama-watchdog, logrotate).
9. `restart pulse-live@*`; watch `/var/log/pulse-live.log` for "Bridge POST 200";
   `curl /api/city-stats/philly` — `newest_extraction_at` (transcription) AND
   `newest_incident_at` (Ollama+tunnel) should advance.
10. Leave backfill DISABLED (realtime priority).

## 4. Gotchas
- **Broadcastify account is BANNED** — live streaming reads the same creds; no audio until
  a new source is wired. Rebuild is moot until then.
- Terminating also kills the ingest LLM (Ollama) — incidents won't promote without it.
- `sync_lambda_live_transcribers.sh:9` runs on every deploy and swallows errors — stale IP =
  silent dead-host syncs.
- Live transcribers are synced FROM Hetzner (`git reset --hard` + `rsync --delete`); edit via
  git → Hetzner → Lambda, never in place.
- Don't use the in-git `systemd/pulse-live@.service` (that's the old Hetzner unit); the Lambda
  unit is generated inline by `install_lambda_live_transcribers.sh`.
- cuDNN `LD_LIBRARY_PATH` hardcodes `python3.10` — match the venv Python.
- `lambda_auto_terminate.py` defaults to the old IP — don't let a stray terminator hit the new box.
