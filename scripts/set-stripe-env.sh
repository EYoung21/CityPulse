#!/bin/bash
# set-stripe-env.sh — push Stripe env vars to all CityPulse Vercel projects.
#
# Usage:
#   1. Edit the FILL-IN block below with values from your Stripe dashboard.
#      For test mode: toggle Test mode ON in Stripe before grabbing values.
#      For live mode: toggle Test mode OFF.
#   2. Run:    bash scripts/set-stripe-env.sh test    # for test mode
#         or:  bash scripts/set-stripe-env.sh live    # for live mode (later)
#   3. After the script completes, redeploy each project (env-var changes
#      don't apply to existing deployments). Easiest way: push an empty
#      commit — the script prints the exact command at the end.
#
# Why REST API and not `vercel env add`?
#   Vercel CLI 50.44.0 has a bug where `vercel env add KEY preview --value V
#   --yes` still errors with "git_branch_required" despite the help text
#   saying --yes skips the prompt. The REST API with ?upsert=true handles
#   create-or-overwrite across all 3 environments in a single POST per
#   env var, which is cleaner anyway (6 calls per project instead of 18).
#
# Env target rules:
#   - test mode → writes to preview + development + production. The reason
#     prod gets test keys is so you can test against the real
#     phlpulse.com / nypulse.com / etc URLs (which is required for Stripe
#     webhooks to reach your code). The "TEST MODE" yellow banner on
#     Stripe Checkout makes it obvious to any stray visitor that this
#     isn't a real charge — and you're not announcing yet anyway.
#   - live mode → writes to production only. Preview + dev keep the test
#     keys so contributors / preview deploys don't accidentally process
#     live transactions during development.

set -e

MODE="${1:-}"
if [ "$MODE" != "test" ] && [ "$MODE" != "live" ]; then
  echo "Usage: $0 {test|live}"
  exit 1
fi

# ============================================================================
# FILL IN YOUR STRIPE VALUES BELOW
# ============================================================================

if [ "$MODE" = "test" ]; then
  # --- TEST MODE values (Stripe dashboard with Test mode toggle ON) -----------
  STRIPE_SECRET_KEY="sk_test_REPLACE_ME"
  STRIPE_PUBLISHABLE_KEY="pk_test_REPLACE_ME"
  # The three Price IDs from Step 3 of the walkthrough (in TEST MODE)
  STRIPE_PRICE_MONTHLY="price_REPLACE_ME"   # $7.99/mo recurring
  STRIPE_PRICE_ANNUAL="price_REPLACE_ME"    # $59.99/yr recurring
  STRIPE_PRICE_3DAY="price_REPLACE_ME"      # $5.99 one-time

  # Per-project test webhook secret. Each Stripe webhook endpoint gets
  # its own whsec_ — paste them here keyed by Vercel project name.
  WHSEC_PHILLY_PULSE="whsec_REPLACE_ME"
  WHSEC_NYC_PULSE="whsec_REPLACE_ME"
  WHSEC_SFO_PULSE="whsec_REPLACE_ME"
  WHSEC_423_PULSE="whsec_REPLACE_ME"

  TARGETS='["production","preview","development"]'

elif [ "$MODE" = "live" ]; then
  # --- LIVE MODE values (Stripe dashboard with Test mode toggle OFF) ----------
  STRIPE_SECRET_KEY="sk_live_REPLACE_ME"
  STRIPE_PUBLISHABLE_KEY="pk_live_REPLACE_ME"
  STRIPE_PRICE_MONTHLY="price_REPLACE_ME"   # LIVE $7.99/mo recurring
  STRIPE_PRICE_ANNUAL="price_REPLACE_ME"    # LIVE $59.99/yr recurring
  STRIPE_PRICE_3DAY="price_REPLACE_ME"      # LIVE $5.99 one-time

  WHSEC_PHILLY_PULSE="whsec_REPLACE_ME"
  WHSEC_NYC_PULSE="whsec_REPLACE_ME"
  WHSEC_SFO_PULSE="whsec_REPLACE_ME"
  WHSEC_423_PULSE="whsec_REPLACE_ME"

  TARGETS='["production"]'
fi

# ============================================================================
# DO NOT EDIT BELOW
# ============================================================================

# Bail loudly if any value is still a placeholder — saves an hour of
# debugging "why is my checkout 500ing" caused by a literal "REPLACE_ME"
# in production.
for var in STRIPE_SECRET_KEY STRIPE_PUBLISHABLE_KEY STRIPE_PRICE_MONTHLY \
           STRIPE_PRICE_ANNUAL STRIPE_PRICE_3DAY \
           WHSEC_PHILLY_PULSE WHSEC_NYC_PULSE WHSEC_SFO_PULSE WHSEC_423_PULSE; do
  if [[ "${!var}" == *"REPLACE_ME"* ]]; then
    echo "ERROR: $var is still a placeholder. Edit $0 and fill it in."
    exit 1
  fi
done

# Read Vercel auth from the CLI's own auth.json so we don't hardcode a
# token in the script. Falls back to VERCEL_TOKEN env var if set.
AUTH_JSON="$HOME/Library/Application Support/com.vercel.cli/auth.json"
if [ -z "${VERCEL_TOKEN:-}" ]; then
  if [ ! -f "$AUTH_JSON" ]; then
    echo "ERROR: cannot find $AUTH_JSON — run 'vercel login' first."
    exit 1
  fi
  VERCEL_TOKEN=$(python3 -c "import json;print(json.load(open('$AUTH_JSON'))['token'])")
fi

# Find the team ID (all CityPulse projects live under eliyoung4now-2897's team).
TEAM_ID=$(curl -s -H "Authorization: Bearer $VERCEL_TOKEN" \
  "https://api.vercel.com/v2/teams" | \
  python3 -c "import json,sys;d=json.load(sys.stdin);print(d['teams'][0]['id'])")

if [ -z "$TEAM_ID" ]; then
  echo "ERROR: could not resolve Vercel team ID."
  exit 1
fi

echo "Using team: $TEAM_ID"
echo "Mode: $MODE"
echo "Targets: $TARGETS"
echo ""

# Upsert one env var on one project. Uses ?upsert=true so we don't have
# to delete-then-create — Vercel overwrites the existing value if the key
# already exists for any of the listed targets.
set_env() {
  local project="$1"
  local key="$2"
  local value="$3"
  local payload
  payload=$(python3 -c "
import json, sys
print(json.dumps({
    'key': sys.argv[1],
    'value': sys.argv[2],
    'type': 'encrypted',
    'target': json.loads(sys.argv[3]),
}))
" "$key" "$value" "$TARGETS")

  local response
  response=$(curl -s -X POST \
    -H "Authorization: Bearer $VERCEL_TOKEN" \
    -H "Content-Type: application/json" \
    "https://api.vercel.com/v10/projects/$project/env?upsert=true&teamId=$TEAM_ID" \
    -d "$payload")

  # `created` key present on success, `error` key present on failure.
  if echo "$response" | python3 -c "import json,sys;d=json.load(sys.stdin);sys.exit(0 if 'created' in d else 1)" 2>/dev/null; then
    echo "  ✓ $key"
  else
    echo "  ✗ $key"
    echo "    $response"
    return 1
  fi
}

for pair in \
    "philly-pulse:$WHSEC_PHILLY_PULSE" \
    "nyc-pulse:$WHSEC_NYC_PULSE" \
    "sfo-pulse:$WHSEC_SFO_PULSE" \
    "423-pulse:$WHSEC_423_PULSE"; do
  IFS=':' read -r project whsec <<< "$pair"

  echo "=== $project ==="
  set_env "$project" "STRIPE_SECRET_KEY"      "$STRIPE_SECRET_KEY"
  set_env "$project" "STRIPE_PUBLISHABLE_KEY" "$STRIPE_PUBLISHABLE_KEY"
  set_env "$project" "STRIPE_PRICE_MONTHLY"   "$STRIPE_PRICE_MONTHLY"
  set_env "$project" "STRIPE_PRICE_ANNUAL"    "$STRIPE_PRICE_ANNUAL"
  set_env "$project" "STRIPE_PRICE_3DAY"      "$STRIPE_PRICE_3DAY"
  set_env "$project" "STRIPE_WEBHOOK_SECRET"  "$whsec"
  echo ""
done

echo "=================================================================="
echo "Env vars written to all 4 projects in $MODE mode."
echo ""
echo "Now redeploy each project to pick up the new env vars."
echo "Vercel needs a NEW deployment — env-var changes don't apply to"
echo "existing deployments retroactively."
echo ""
echo "Easiest: push an empty commit to trigger auto-redeploy on every"
echo "project that tracks this repo:"
echo ""
echo "  cd /Users/eliyoung/PhillyPulse && \\"
echo "    git commit --allow-empty -m 'redeploy: pick up Stripe env' && \\"
echo "    git push"
echo "=================================================================="
