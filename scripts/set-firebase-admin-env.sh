#!/bin/bash
# set-firebase-admin-env.sh — push FIREBASE_ADMIN_KEY to all 4 CityPulse
# Vercel projects.
#
# The Stripe webhook handler (frontend/src/app/api/stripe-webhook/route.ts)
# needs firebase-admin credentials to write tier/proUntil updates back to
# Firestore. On Vercel there's no default credential discovery, so we
# inject the service-account JSON as a single env var named
# FIREBASE_ADMIN_KEY (JSON-stringified).
#
# Prereq — generate the key first:
#   1. https://console.firebase.google.com/ → pick project "phlpulse"
#   2. ⚙️ Project settings → Service accounts tab → "Generate new private key"
#   3. Download the JSON (e.g. phlpulse-firebase-adminsdk-xyz123.json)
#   4. Move it somewhere safe and pass the path to this script:
#        bash scripts/set-firebase-admin-env.sh ~/Downloads/phlpulse-firebase-adminsdk-xyz123.json
#      (the .gitignore pattern `*-firebase-adminsdk-*.json` protects you
#       if you accidentally stash it inside the repo)

set -e

KEYFILE="${1:-}"
if [ -z "$KEYFILE" ] || [ ! -f "$KEYFILE" ]; then
  echo "Usage: $0 /path/to/phlpulse-firebase-adminsdk-*.json"
  echo ""
  echo "Download from Firebase Console → Project settings → Service accounts"
  echo "→ Generate new private key."
  exit 1
fi

# Validate it's a service-account JSON (has the expected shape). Bail
# early if the user pointed at the wrong file — a malformed value here
# would only surface as a runtime 500 in the webhook handler, which is
# much harder to debug.
python3 -c "
import json, sys
d = json.load(open('$KEYFILE'))
missing = [k for k in ('type','project_id','private_key','client_email') if k not in d]
if missing:
    print(f'ERROR: not a Firebase service-account JSON (missing: {missing})', file=sys.stderr)
    sys.exit(1)
if d['type'] != 'service_account':
    print(f'ERROR: type is {d[\"type\"]!r}, expected \"service_account\"', file=sys.stderr)
    sys.exit(1)
print(f'  project_id: {d[\"project_id\"]}')
print(f'  client_email: {d[\"client_email\"]}')
"

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

TEAM_ID=$(curl -s -H "Authorization: Bearer $VERCEL_TOKEN" \
  "https://api.vercel.com/v2/teams" | \
  python3 -c "import json,sys;d=json.load(sys.stdin);print(d['teams'][0]['id'])")

# Stringify the whole JSON (preserves newlines inside private_key).
ADMIN_KEY_VALUE=$(python3 -c "
import json
print(json.dumps(json.load(open('$KEYFILE'))))
")

TARGETS='["production","preview","development"]'

upsert_env() {
  local project="$1"
  local payload
  payload=$(python3 -c "
import json, sys
print(json.dumps({
    'key': 'FIREBASE_ADMIN_KEY',
    'value': sys.argv[1],
    'type': 'encrypted',
    'target': json.loads(sys.argv[2]),
}))
" "$ADMIN_KEY_VALUE" "$TARGETS")

  local response
  response=$(curl -s -X POST \
    -H "Authorization: Bearer $VERCEL_TOKEN" \
    -H "Content-Type: application/json" \
    "https://api.vercel.com/v10/projects/$project/env?upsert=true&teamId=$TEAM_ID" \
    -d "$payload")

  if echo "$response" | python3 -c "import json,sys;d=json.load(sys.stdin);sys.exit(0 if 'created' in d else 1)" 2>/dev/null; then
    echo "  ✓ $project"
  else
    echo "  ✗ $project"
    echo "    $response"
    return 1
  fi
}

echo ""
echo "Pushing FIREBASE_ADMIN_KEY to all 4 projects..."
for project in philly-pulse nyc-pulse sfo-pulse 423-pulse; do
  upsert_env "$project"
done

echo ""
echo "=================================================================="
echo "FIREBASE_ADMIN_KEY written to all 4 projects."
echo ""
echo "Redeploy to pick it up:"
echo ""
echo "  cd ~/CityPulse && \\"
echo "    git commit --allow-empty -m 'redeploy: pick up FIREBASE_ADMIN_KEY' && \\"
echo "    git push"
echo "=================================================================="
