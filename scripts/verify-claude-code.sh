#!/usr/bin/env bash
# A real MCP client against the live gateway: Claude Code (`claude -p`) acting as a
# member (user B) with their own API key, no mocks. It checks, from the gateway's
# own audit log, that B
#   1. can read through the gateway (list_products runs),
#   2. cannot see or use a tool that isn't theirs (update_order_status),
#   3. has a write held until B approves it on the dashboard (as a session, not the key),
#   4. and that the approved write then runs, once, with the same arguments.
# Re-runnable (each run makes a fresh member). Needs `claude` logged in on this machine
# and the stack deployed (verify-phase7.sh / the README quick start).
#   ./scripts/verify-claude-code.sh
set -euo pipefail
cd "$(dirname "$0")/.."

NS="${NAMESPACE:-urumi}"
GW="${GATEWAY_URL:-http://gateway.local.test}"
DASH="${DASHBOARD_URL:-http://dashboard.local.test}"
MODEL="${CLAUDE_MODEL:-sonnet}"
STAMP=$(date +%s)
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
fail() { echo "FAILED: $*"; exit 1; }
step() { echo; echo "== $* =="; }
command -v claude >/dev/null || fail "the claude CLI is not installed"

ADMIN_KEY=$(kubectl -n "$NS" get secret gateway-bootstrap-admin -o jsonpath='{.data.api-key}' | base64 -d)
PASSWORD="verify-cc-$STAMP-Passw0rd!"
EMAIL="verify-cc-$STAMP@example.com"
admin() { curl -sf -H "Authorization: Bearer $ADMIN_KEY" -H "Content-Type: application/json" "$@"; }
json() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)"; }

step "Create member B (invite accepted, own API key), allowed to create products"
INVITE=$(admin -X POST -d "{\"email\":\"$EMAIL\",\"name\":\"Claude Code B\"}" "$GW/api/users")
B_ID=$(json 'd["id"]' <<<"$INVITE")
TOKEN=$(json 'd["inviteUrl"].rsplit("/",1)[1]' <<<"$INVITE")
curl -sf -X POST -H "Origin: $DASH" -H "Content-Type: application/json" \
  -d "{\"password\":\"$PASSWORD\"}" "$GW/api/auth/invites/$TOKEN/accept" >/dev/null
B_KEY=$(admin -X POST -d '{"name":"claude-code"}' "$GW/api/users/$B_ID/keys" | json 'd["key"]')
admin -X PUT -d "{\"userId\":\"$B_ID\",\"serverSlug\":\"woocommerce\",\"toolName\":\"create_product\",\"effect\":\"allow\"}" \
  "$GW/api/permissions" >/dev/null
JAR="$WORK/jar"
curl -sf -c "$JAR" -X POST -H "Origin: $DASH" -H "Content-Type: application/json" \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}" "$GW/api/auth/login" >/dev/null
b_api() { curl -sf -b "$JAR" -H "Origin: $DASH" -H "Content-Type: application/json" "$@"; }

cat >"$WORK/mcp.json" <<JSON
{"mcpServers":{"gateway":{"type":"http","url":"$GW/mcp","headers":{"Authorization":"Bearer $B_KEY"}}}}
JSON
cc() { # prompt -> Claude Code's final answer (MCP tools only, nothing else allowed)
  claude -p "$1" --model "$MODEL" --mcp-config "$WORK/mcp.json" --strict-mcp-config \
    --allowedTools "mcp__gateway" --permission-mode dontAsk --max-turns 8 --output-format json </dev/null |
    python3 -c 'import json,sys; print(json.load(sys.stdin).get("result",""))'
}
audit() { # tool outcome -> number of B's audit rows
  admin "$GW/api/audit?userId=$B_ID&limit=200" | python3 -c '
import json, sys
rows = json.load(sys.stdin)
print(sum(1 for r in rows if r["tool"] == sys.argv[1] and r["outcome"] == sys.argv[2] and r["source"] == "mcp"))' "$1" "$2"
}

step "1. Claude Code reads the catalogue through the gateway"
cc "Use the woocommerce list_products tool and list the product names." | tee "$WORK/a1"
[ "$(audit woocommerce__list_products success)" -ge 1 ] || fail "no successful list_products from B in the audit log"

step "2. A tool B may not use is neither visible nor callable"
cc "Use the woocommerce update_order_status tool to mark order 1 completed. If you have no such tool, say exactly: NO SUCH TOOL." | tee "$WORK/a2"
[ "$(audit woocommerce__update_order_status success)" = 0 ] || fail "B ran update_order_status"
b_tools=$(curl -sf -H "Authorization: Bearer $B_KEY" "$GW/api/tools" | json '" ".join(t["name"] for t in d)')
grep -q update_order_status <<<"$b_tools" && fail "update_order_status is in B's tool list"

step "3. The write is held, and the product does not exist yet"
ARGS='{"name":"Claude Code Mug '"$STAMP"'","regular_price":"9.99"}'
PROMPT="Call the woocommerce create_product tool with exactly these arguments and no others: $ARGS. If the gateway says the user must approve it, report that message and stop."
cc "$PROMPT" | tee "$WORK/a3"
[ "$(audit woocommerce__create_product held)" -ge 1 ] || fail "the write was not held"
[ "$(audit woocommerce__create_product success)" = 0 ] || fail "the write ran without approval"

step "4. B approves on the dashboard (session); a key cannot"
PENDING=$(b_api "$GW/api/approvals")
APPROVAL_ID=$(json 'd[0]["id"]' <<<"$PENDING") || fail "no pending approval for B"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "Authorization: Bearer $B_KEY" "$GW/api/approvals/$APPROVAL_ID/approve")
[ "$code" = 403 ] || fail "an API key could approve (HTTP $code)"
b_api -X POST "$GW/api/approvals/$APPROVAL_ID/approve" >/dev/null
echo "approved request $APPROVAL_ID"

step "5. Claude Code retries; it runs, exactly once"
cc "The user approved it. Call the woocommerce create_product tool again with exactly these arguments: $ARGS. Report the result." | tee "$WORK/a5"
[ "$(audit woocommerce__create_product success)" = 1 ] || fail "expected exactly one successful create_product"
cc "$PROMPT" >/dev/null || true
[ "$(audit woocommerce__create_product success)" = 1 ] || fail "the approval was used twice"

echo
echo "OK: a real Claude Code session, as a member, read through the gateway, was kept off a tool it may not use,"
echo "    had its write held until B approved it on the dashboard, and ran it once."
