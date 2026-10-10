#!/usr/bin/env bash
# Verification for Phase 4 (dashboard, team and keys, audit log), against
# the live k3d cluster. Re-runnable:
#   ./scripts/verify-phase4.sh                # build, deploy, verify
#   SKIP_DEPLOY=1 ./scripts/verify-phase4.sh  # reuse what's already deployed
#   SKIP_TESTS=1 ...                          # skip the repo test suites (cluster checks only)
set -euo pipefail
cd "$(dirname "$0")/.."

NS="${NAMESPACE:-urumi}"
RELEASE=platform
CLUSTER=urumi-mcp
DASH="http://dashboard.local.test"
GW="http://gateway.local.test"
MCP_DEPLOY="$RELEASE-store-woocommerce-mcp"
TEST_DB=postgres://gateway_test:gateway_test@localhost:5433/gateway_test
JAR_ADMIN=$(mktemp) JAR_MEMBER=$(mktemp)

cleanup() {
  rm -f "$JAR_ADMIN" "$JAR_MEMBER"
  kubectl -n "$NS" scale "deployment/$MCP_DEPLOY" --replicas=1 >/dev/null 2>&1 || true
}
trap cleanup EXIT

step() { echo; echo "== $* =="; }
fail() { echo "FAILED: $*"; exit 1; }
secret() { kubectl -n "$NS" get secret "$1" -o jsonpath="{.data.$2}" | base64 -d; }
jsonget() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)"; }
status_of() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
# JSON bodies are built with printf and passed in variables: macOS's bash 3.2
# mis-parses escaped quotes inside a double-quoted "$(...)".
login_body() { printf '{"email":"%s","password":"%s"}' "$1" "$2"; }
# POST a JSON body from the dashboard's origin; prints the HTTP status.
post_status() { curl -s -o /dev/null -w '%{http_code}' -H "Origin: $DASH" -H "Content-Type: application/json" -d "$2" "$1"; }

if [ -z "${SKIP_TESTS:-}" ]; then
  step "Lint, format, unit + integration tests (real Postgres), build"
  docker compose -f docker-compose.test.yml up -d --wait >/dev/null
  npm run lint
  npm run format:check
  TEST_DATABASE_URL="$TEST_DB" npm test
  npm run build

  step "Browser E2E (Playwright): real dashboard build + real gateway app, fake upstreams"
  TEST_DATABASE_URL="$TEST_DB" npm run test:e2e
fi

step "Helm chart lints and renders for both environments"
helm lint helm -f helm/values-local.yaml
helm lint helm -f helm/values-prod.yaml
helm template "$RELEASE" helm -f helm/values-prod.yaml >/dev/null

if [ -z "${SKIP_DEPLOY:-}" ]; then
  step "Build images, import into k3d, deploy"
  for app in woocommerce-mcp gateway dashboard; do
    docker build -q -f "$app/Dockerfile" -t "mcp-gateway/$app:dev" . >/dev/null
    k3d image import "mcp-gateway/$app:dev" -c "$CLUSTER" >/dev/null
  done
  ./scripts/create-secrets.sh
  helm upgrade --install "$RELEASE" helm -n "$NS" -f helm/values-local.yaml --wait --timeout 15m
  # Pick up re-imported :dev images (and the gateway re-reads its Secrets).
  kubectl -n "$NS" rollout restart "deployment/$MCP_DEPLOY" "deployment/$RELEASE-gateway" "deployment/$RELEASE-dashboard"
fi

step "All workloads ready"
for d in "$MCP_DEPLOY" "$RELEASE-gateway" "$RELEASE-dashboard"; do
  kubectl -n "$NS" rollout status "deployment/$d" --timeout=300s
done
kubectl -n "$NS" get pods

step "Every container has probes and resource requests/limits; the dashboard runs non-root, read-only"
missing=$(kubectl -n "$NS" get deploy,statefulset -o json | python3 -c '
import json, sys
for item in json.load(sys.stdin)["items"]:
    for c in item["spec"]["template"]["spec"]["containers"]:
        for field in ("readinessProbe", "livenessProbe"):
            if field not in c: print(item["metadata"]["name"], c["name"], "missing", field)
        r = c.get("resources", {})
        for k in ("requests", "limits"):
            if not r.get(k): print(item["metadata"]["name"], c["name"], "missing resources", k)
')
[ -z "$missing" ] || fail "$missing"
dash_sc=$(kubectl -n "$NS" get deploy "$RELEASE-dashboard" -o json | jsonget '
(d["spec"]["template"]["spec"]["securityContext"]["runAsNonRoot"],
 d["spec"]["template"]["spec"]["containers"][0]["securityContext"]["readOnlyRootFilesystem"],
 d["spec"]["template"]["spec"]["automountServiceAccountToken"])')
[ "$dash_sc" = "(True, True, False)" ] || fail "dashboard security context: $dash_sc"
echo "ok"

step "Dashboard through Ingress: SPA routes, security headers, caching, /api goes to the gateway"
[ "$(status_of "$DASH/healthz")" = "200" ] || fail "dashboard /healthz"
for path in / /servers /team /invite/whatever; do
  body=$(curl -s "$DASH$path")
  grep -q '<div id="root">' <<<"$body" || fail "$path didn't serve the SPA"
done
headers=$(curl -sI "$DASH/servers")
for h in "Content-Security-Policy: default-src 'self'" "X-Frame-Options: DENY" \
  "X-Content-Type-Options: nosniff" "Referrer-Policy: no-referrer" "Cache-Control: no-cache"; do
  grep -qiF "$h" <<<"$headers" || fail "missing header: $h"
done
asset=$(curl -s "$DASH/" | grep -o '/assets/[^"]*\.js' | head -1)
curl -sI "$DASH$asset" | grep -qi "immutable" || fail "hashed asset $asset not cached as immutable"
# A 401 *from the gateway* (JSON, WWW-Authenticate) proves /api is routed past nginx.
me=$(curl -s -i "$DASH/api/me")
grep -q "^HTTP/1.1 401" <<<"$me" && grep -qi "www-authenticate: Bearer" <<<"$me" ||
  fail "/api on the dashboard host isn't the gateway"
echo "ok"

ADMIN_EMAIL=$(secret gateway-bootstrap-admin email)
ADMIN_PASSWORD=$(secret gateway-bootstrap-admin password)
[ -n "$ADMIN_PASSWORD" ] || fail "gateway-bootstrap-admin has no password key (run create-secrets.sh)"
# Requests as the dashboard page makes them: same origin, session cookie, Origin header.
as_admin() { curl -s -b "$JAR_ADMIN" -c "$JAR_ADMIN" -H "Origin: $DASH" -H "Content-Type: application/json" "$DASH/api$1" "${@:2}"; }
as_member() { curl -s -b "$JAR_MEMBER" -c "$JAR_MEMBER" -H "Origin: $DASH" -H "Content-Type: application/json" "$DASH/api$1" "${@:2}"; }
# tools/list with an API key: prints the HTTP status, writes the body to file $2.
mcp_with() {
  curl -s -o "$2" -w '%{http_code}' -X POST "$GW/mcp" -H "Authorization: Bearer $1" \
    -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
    -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
}

step "Admin logs in with the bootstrap password: HttpOnly, SameSite=Strict cookie on /api"
login_headers=$(curl -s -D - -o /dev/null -c "$JAR_ADMIN" -H "Origin: $DASH" -H "Content-Type: application/json" \
  -d "$(login_body "$ADMIN_EMAIL" "$ADMIN_PASSWORD")" "$DASH/api/auth/login")
grep -q "^HTTP/1.1 200" <<<"$login_headers" || fail "admin login: $(head -1 <<<"$login_headers")"
cookie=$(grep -i "^set-cookie: mgw_session=" <<<"$login_headers")
for flag in "HttpOnly" "SameSite=Strict" "Path=/api"; do grep -qi "$flag" <<<"$cookie" || fail "cookie lacks $flag"; done
grep -qi "secure" <<<"$cookie" && fail "Secure flag set on plain-http local install"
[ "$(as_admin /me | jsonget 'd["role"]')" = "admin" ] || fail "/api/me with the session"
[ "$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR_ADMIN" -H "Content-Type: application/json" \
  -d '{"name":"x"}' "$DASH/api/users/me/keys")" = "403" ] || fail "cookie POST without Origin wasn't rejected"
code=$(post_status "$DASH/api/auth/login" "$(login_body "$ADMIN_EMAIL" wrong-password-1)")
[ "$code" = "401" ] || fail "wrong password got HTTP $code, not 401"
echo "ok (cookie: $(sed 's/mgw_session=[^;]*/mgw_session=<token>/' <<<"$cookie" | tr -d '\r'))"

step "Invite a member -> member sets a password via the link -> logs in"
MEMBER_EMAIL="verify-$(date +%s)@example.com"
MEMBER_PASSWORD="member-$(openssl rand -hex 8)"
invite=$(as_admin /users -d "$(printf '{"email":"%s","name":"Verify Member"}' "$MEMBER_EMAIL")")
invite_url=$(jsonget 'd["inviteUrl"]' <<<"$invite")
grep -q "^$DASH/invite/" <<<"$invite_url" || fail "invite URL: $invite_url"
token=${invite_url##*/}
[ "$(curl -s "$DASH/api/auth/invites/$token" | jsonget 'd["email"]')" = "$MEMBER_EMAIL" ] || fail "invite lookup"
accepted=$(curl -s -c "$JAR_MEMBER" -H "Origin: $DASH" -H "Content-Type: application/json" \
  -d "$(printf '{"password":"%s"}' "$MEMBER_PASSWORD")" "$DASH/api/auth/invites/$token/accept")
[ "$(jsonget 'd["email"]' <<<"$accepted")" = "$MEMBER_EMAIL" ] || fail "accept invite: $accepted"
code=$(post_status "$DASH/api/auth/invites/$token/accept" "$(printf '{"password":"%s"}' "$MEMBER_PASSWORD")")
[ "$code" = "404" ] || fail "invite link worked twice (HTTP $code)"
[ "$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR_MEMBER" "$DASH/api/users")" = "403" ] || fail "member listed users"
[ "$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR_MEMBER" "$DASH/api/audit")" = "403" ] || fail "member read audit"
as_member /servers | grep -q '"url"' && fail "member sees upstream URLs"
MEMBER_ID=$(jsonget 'd["id"]' <<<"$accepted")
echo "ok ($MEMBER_EMAIL)"

step "WooCommerce is Connected before the member checks (the health loop runs every 15s)"
for _ in $(seq 1 60); do
  [ "$(as_admin /servers | jsonget 'next((s["status"] for s in d if s["slug"] == "woocommerce"), "missing")')" = "connected" ] && break
  sleep 1
done
[ "$(as_admin /servers | jsonget 'next((s["status"] for s in d if s["slug"] == "woocommerce"), "missing")')" = "connected" ] ||
  fail "woocommerce not connected within 60s"
echo "ok"

step "Member generates their own key; it works on /mcp (user story: one URL + one key)"
key_json=$(as_member /users/me/keys -d '{"name":"verify"}')
MEMBER_KEY=$(jsonget 'd["key"]' <<<"$key_json")
MEMBER_KEY_ID=$(jsonget 'd["id"]' <<<"$key_json")
tools_file=$(mktemp)
[ "$(mcp_with "$MEMBER_KEY" "$tools_file")" = "200" ] || fail "member key rejected on /mcp"
grep -q "woocommerce__list_orders" "$tools_file" || fail "member doesn't see the WooCommerce tools"
curl -s -X POST "$GW/mcp" -H "Authorization: Bearer $MEMBER_KEY" -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"woocommerce__list_products","arguments":{}}}' |
  jsonget 'd["result"].get("isError", False)' | grep -q False || fail "member's tool call failed"
echo "ok"

step "Admin disables WooCommerce: its tools vanish for the member at once; re-enable brings them back"
WOO_ID=$(as_admin /servers | jsonget 'next(s["id"] for s in d if s["slug"] == "woocommerce")')
[ "$(as_admin "/servers/$WOO_ID" -X PATCH -d '{"enabled":false}' | jsonget 'd["status"]')" = "disabled" ] || fail "disable"
mcp_with "$MEMBER_KEY" "$tools_file" >/dev/null
grep -q "woocommerce__" "$tools_file" && fail "disabled server's tools still listed"
[ "$(as_member /tools | jsonget 'len([t for t in d if t["name"].startswith("woocommerce__")])')" = "0" ] ||
  fail "/api/tools still has them"
[ "$(as_admin "/servers/$WOO_ID" -X PATCH -d '{"enabled":true}' | jsonget 'd["status"]')" = "connected" ] || fail "re-enable"
mcp_with "$MEMBER_KEY" "$tools_file" >/dev/null
grep -q "woocommerce__list_orders" "$tools_file" || fail "tools didn't come back"
echo "ok"

step "Audit log: the member's call is there, attributed to them"
as_admin "/audit?userId=$MEMBER_ID&limit=50" | python3 -c '
import json, sys
rows = json.load(sys.stdin)
ok = [r for r in rows if r["tool"] == "woocommerce__list_products" and r["outcome"] == "success" and r["source"] == "mcp"]
if not ok: sys.exit(f"no successful list_products row for the member: {rows}")
r = ok[0]
print("ok (%d rows for the member, e.g. %s %s %sms)" % (len(rows), r["userEmail"], r["tool"], r["durationMs"]))
' || fail "audit"

step "Admin revokes the member's key: the next call is rejected"
as_admin "/keys/$MEMBER_KEY_ID" -X DELETE >/dev/null
[ "$(mcp_with "$MEMBER_KEY" "$tools_file")" = "401" ] || fail "revoked key still works"
echo "ok"

step "Admin disables the member: their dashboard session ends on the next request"
[ "$(as_member /me | jsonget 'd["email"]')" = "$MEMBER_EMAIL" ] || fail "member session before disable"
as_admin "/users/$MEMBER_ID" -X PATCH -d '{"disabled":true}' >/dev/null
[ "$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR_MEMBER" "$DASH/api/me")" = "401" ] || fail "disabled member still logged in"
code=$(post_status "$DASH/api/auth/login" "$(login_body "$MEMBER_EMAIL" "$MEMBER_PASSWORD")")
[ "$code" = "401" ] || fail "disabled member can log in (HTTP $code)"
echo "ok"

step "Live browser smoke test: WooCommerce Connected with 5 tools; kill its MCP pod -> Unreachable -> recovers"
E2E_BASE_URL="$DASH" E2E_ADMIN_EMAIL="$ADMIN_EMAIL" E2E_ADMIN_PASSWORD="$ADMIN_PASSWORD" NAMESPACE="$NS" \
  MCP_DEPLOYMENT="$MCP_DEPLOY" npm run test:live -w e2e

step "No secret values in the Helm release"
manifest=$(helm get manifest "$RELEASE" -n "$NS")
for value in "$ADMIN_PASSWORD" "$(secret gateway-bootstrap-admin api-key)" "$(secret woocommerce-mcp-auth token)" \
  "$(secret gateway-encryption-key key)"; do
  grep -qF "$value" <<<"$manifest" && fail "a secret value appears in the Helm release"
done
echo "ok"

as_admin /auth/logout -X POST >/dev/null
echo
echo "All Phase 4 checks passed."
