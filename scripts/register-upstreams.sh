#!/usr/bin/env bash
# Registers the extra upstream MCP servers (DeepWiki, GitHub) through the
# gateway's admin API - the same call the dashboard's "Add server" form makes.
# Idempotent: a slug that already exists is left as is, so an admin's edits
# (a disabled server, a rotated token) are never undone.
#
#   ./scripts/register-upstreams.sh                  # add what's missing
#   ./scripts/register-upstreams.sh --rotate-github  # replace GitHub's token
#
# The GitHub token is read from $GITHUB_MCP_TOKEN or ~/.config/urumi/github.env
# and sent in a JSON body on stdin, never on a command line. Use a read-only
# fine-grained token: the chat agent has no per-tool permissions until Phase 7.
set -euo pipefail

NS="${NAMESPACE:-urumi}"
GW="${GATEWAY_URL:-http://gateway.local.test}"
ROTATE=""
[ "${1:-}" = "--rotate-github" ] && ROTATE=1

if [ -z "${GITHUB_MCP_TOKEN:-}" ] && [ -f "$HOME/.config/urumi/github.env" ]; then
  set -a; . "$HOME/.config/urumi/github.env"; set +a
fi

ADMIN_KEY=$(kubectl -n "$NS" get secret gateway-bootstrap-admin -o jsonpath='{.data.api-key}' | base64 -d)
api() { # method path [json on stdin]; prints "<body>\n<status>"
  curl -s -w '\n%{http_code}' -X "$1" -H "Authorization: Bearer $ADMIN_KEY" \
    -H "Content-Type: application/json" "$GW/api$2" "${@:3}"
}
id_of() { # slug -> id, empty if not registered
  api GET /servers | sed '$d' | python3 -c '
import json,sys
print(next((s["id"] for s in json.load(sys.stdin) if s["slug"] == sys.argv[1]), ""))' "$1"
}
check() { # label expected-status  (reads api output on stdin)
  local out status
  out=$(cat); status=$(tail -1 <<<"$out")
  [ "$status" = "$2" ] || { echo "FAILED: $1: HTTP $status: $(sed '$d' <<<"$out" | head -c 300)"; exit 1; }
}

register() { # slug name url [bearer-token-env-var]
  local slug="$1" name="$2" url="$3" tokenvar="${4:-}" id
  id=$(id_of "$slug")
  if [ -n "$id" ] && { [ "$slug" != github ] || [ -z "$ROTATE" ]; }; then
    echo "$slug: already registered, leaving it as is"
    return
  fi
  local body
  if [ -n "$id" ]; then
    body=$(TOKENVAR="$tokenvar" python3 -c '
import json, os
print(json.dumps({"authType": "bearer", "credential": os.environ[os.environ["TOKENVAR"]]}))')
    api PATCH "/servers/$id" -d @- <<<"$body" | check "update $slug" 200
    echo "$slug: credential replaced"
  else
    body=$(SLUG="$slug" NAME="$name" URL="$url" TOKENVAR="$tokenvar" python3 -c '
import json, os
b = {"slug": os.environ["SLUG"], "name": os.environ["NAME"], "url": os.environ["URL"]}
if os.environ["TOKENVAR"]:
    b.update(authType="bearer", credential=os.environ[os.environ["TOKENVAR"]])
print(json.dumps(b))')
    api POST /servers -d @- <<<"$body" | check "add $slug" 201
    echo "$slug: registered"
  fi
}

register deepwiki DeepWiki https://mcp.deepwiki.com/mcp
if [ -n "${GITHUB_MCP_TOKEN:-}" ]; then
  export GITHUB_MCP_TOKEN
  register github GitHub https://api.githubcopilot.com/mcp/ GITHUB_MCP_TOKEN
else
  echo "github: skipped - set GITHUB_MCP_TOKEN or create ~/.config/urumi/github.env"
fi

# Members are read-only by default (only tools with readOnlyHint), and DeepWiki's
# three tools carry no hint although they only read documentation. Allow the
# server for every member; idempotent (PUT changes the existing rule).
api PUT /permissions -d '{"role":"member","serverSlug":"deepwiki","toolName":null,"effect":"allow"}' |
  check "allow deepwiki for members" 200
echo "deepwiki: allowed for members (its tools carry no readOnlyHint)"

echo "Waiting for the health check to connect them..."
for _ in $(seq 1 40); do
  api GET /servers | sed '$d' | python3 -c '
import json,sys
want = {"woocommerce", "deepwiki"} | ({"github"} if sys.argv[1] else set())
st = {s["slug"]: s["status"] for s in json.load(sys.stdin)}
sys.exit(0 if all(st.get(w) == "connected" for w in want) else 1)' "${GITHUB_MCP_TOKEN:+1}" && break
  sleep 2
done
api GET /servers | sed '$d' | python3 -c '
import json,sys
for s in json.load(sys.stdin):
    print("%-12s %-12s %2d tools  %s" % (s["slug"], s["status"], len(s["tools"]), s["lastError"] or ""))'
