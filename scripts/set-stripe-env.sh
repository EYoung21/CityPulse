#!/bin/bash
# set-stripe-env.sh — push Stripe env vars to all CityPulse Vercel projects.
#
# Usage:
#   1. Edit the FILL-IN block below with values from your Stripe dashboard.
#      For test mode: toggle Test mode ON in Stripe before grabbing values.
#      For live mode: toggle Test mode OFF.
#   2. Run:    bash scripts/set-stripe-env.sh test    # for test mode
#         or:  bash scripts/set-stripe-env.sh live    # for live mode (later)
#   3. The script redeploys each project automatically at the end. If a
#      redeploy fails (e.g. a build error unrelated to env vars) the env
#      vars still got written — you can redeploy manually from the dashboard.
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

  ENVIRONMENTS=("preview" "development" "production")

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

  ENVIRONMENTS=("production")
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

# Vercel CLI's `env add` is interactive (prompts for value via stdin) and
# also fails if the key already exists in that environment. We work around
# both by piping the value via stdin and removing first (ignoring "not
# found" failures). Each set_env call is per-environment because the
# CLI doesn't accept a multi-env target in one shot.
set_env() {
  local key="$1"
  local value="$2"
  for env in "${ENVIRONMENTS[@]}"; do
    vercel env rm "$key" "$env" --yes >/dev/null 2>&1 || true
    printf '%s' "$value" | vercel env add "$key" "$env" >/dev/null 2>&1
    echo "  ✓ $key → $env"
  done
}

# vercel link writes a .vercel/project.json into the current dir. Using a
# fresh tmpdir per project keeps them isolated so we don't get stuck on
# one project's link state.
link_project() {
  local project="$1"
  local tmp
  tmp=$(mktemp -d)
  cd "$tmp"
  vercel link --project "$project" --yes >/dev/null 2>&1
}

# Loop projects. The `IFS=:` trick lets us pair project names with their
# webhook secrets without juggling parallel arrays.
for pair in \
    "philly-pulse:$WHSEC_PHILLY_PULSE" \
    "nyc-pulse:$WHSEC_NYC_PULSE" \
    "sfo-pulse:$WHSEC_SFO_PULSE" \
    "423-pulse:$WHSEC_423_PULSE"; do
  IFS=':' read -r project whsec <<< "$pair"

  echo ""
  echo "=== $project ==="
  link_project "$project"

  set_env "STRIPE_SECRET_KEY"      "$STRIPE_SECRET_KEY"
  set_env "STRIPE_PUBLISHABLE_KEY" "$STRIPE_PUBLISHABLE_KEY"
  set_env "STRIPE_PRICE_MONTHLY"   "$STRIPE_PRICE_MONTHLY"
  set_env "STRIPE_PRICE_ANNUAL"    "$STRIPE_PRICE_ANNUAL"
  set_env "STRIPE_PRICE_3DAY"      "$STRIPE_PRICE_3DAY"
  set_env "STRIPE_WEBHOOK_SECRET"  "$whsec"
done

echo ""
echo "=================================================================="
echo "Env vars written to all 4 projects in $MODE mode."
echo ""
echo "Now redeploy each project to pick up the new env vars."
echo "Vercel needs a NEW deployment — env-var changes don't apply to"
echo "existing deployments retroactively."
echo ""
echo "Easiest: open each project in vercel.com → Deployments → ⋯ →"
echo "Redeploy on the latest deploy. Or push an empty commit to trigger"
echo "auto-redeploy:"
echo ""
echo "  cd /Users/eliyoung/PhillyPulse && \\"
echo "    git commit --allow-empty -m 'redeploy: pick up Stripe env' && \\"
echo "    git push"
echo "=================================================================="
