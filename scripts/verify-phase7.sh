#!/usr/bin/env bash
# Verification for Phase 7 (tool permissions) against the live k3d cluster,
# the real Gemini API, DeepWiki and GitHub. It re-runs the whole Phase 6
# definition-of-done suite (which now includes a permissions step), then
# checks the permissions API and audit trail on the live gateway. Re-runnable:
#   ./scripts/verify-phase7.sh                # tests, build, deploy, verify
#   SKIP_DEPLOY=1 ./scripts/verify-phase7.sh  # reuse what's already deployed
#   SKIP_TESTS=1 ...                          # skip the repo test suites
#   SKIP_REGRESSION=1 ...                     # skip re-running the Phase 2-5 scripts
#
# Needs: a Gemini key (see verify-phase5.sh) and a read-only GitHub token in
# $GITHUB_MCP_TOKEN or ~/.config/urumi/github.env. The system suite costs
# roughly 15 Gemini requests; the regression adds about 10 more.
set -euo pipefail
cd "$(dirname "$0")/.."

NS="${NAMESPACE:-urumi}"
RELEASE=platform
CLUSTER=urumi-mcp
GW="http://gateway.local.test"
DASH="http://dashboard.local.test"
STORE="http://store.local.test"
GATEWAY_DEPLOY="$RELEASE-gateway"
TEST_DB=postgres://gateway_test:gateway_test@localhost:5433/gateway_test
OUT=$(mktemp)

step() { echo; echo "== $* =="; }
fail() { echo "FAILED: $*"; exit 1; }
secret() { kubectl -n "$NS" get secret "$1" -o jsonpath="{.data.$2}" | base64 -d; }
trap 'rm -f "$OUT"' EXIT

if [ -z "${GITHUB_MCP_TOKEN:-}" ] && [ -f "$HOME/.config/urumi/github.env" ]; then
  set -a; . "$HOME/.config/urumi/github.env"; set +a
fi
[ -n "${GITHUB_MCP_TOKEN:-}" ] || fail "no GitHub token: set GITHUB_MCP_TOKEN or create ~/.config/urumi/github.env"

if [ -z "${SKIP_TESTS:-}" ]; then
  step "Lint, format, unit + integration tests (real Postgres), build"
  docker compose -f docker-compose.test.yml up -d --wait >/dev/null
  npm run lint
  npm run format:check
  TEST_DATABASE_URL="$TEST_DB" npm test
  npm run build

  step "Browser E2E (Playwright, fake upstreams and model)"
  TEST_DATABASE_URL="$TEST_DB" npm run test:e2e
fi

step "Helm chart lints and renders for both environments"
helm lint helm -f helm/values-local.yaml
helm lint helm -f helm/values-prod.yaml
helm template "$RELEASE" helm -f helm/values-prod.yaml >/dev/null

if [ -z "${SKIP_DEPLOY:-}" ]; then
  step "Build images, import into k3d, deploy"
  [ -f "$HOME/.config/urumi/gemini.env" ] && { set -a; . "$HOME/.config/urumi/gemini.env"; set +a; }
  for app in woocommerce-mcp gateway dashboard; do
    docker build -q -f "$app/Dockerfile" -t "mcp-gateway/$app:dev" . >/dev/null
    k3d image import "mcp-gateway/$app:dev" -c "$CLUSTER" >/dev/null
  done
  ./scripts/create-secrets.sh
  helm upgrade --install "$RELEASE" helm -n "$NS" -f helm/values-local.yaml --wait --timeout 15m
  kubectl -n "$NS" rollout restart "deployment/$RELEASE-store-woocommerce-mcp" "deployment/$GATEWAY_DEPLOY" "deployment/$RELEASE-dashboard"
fi

step "All workloads ready"
for d in "$RELEASE-store-woocommerce-mcp" "$GATEWAY_DEPLOY" "$RELEASE-dashboard"; do
  kubectl -n "$NS" rollout status "deployment/$d" --timeout=300s
done

step "Register DeepWiki and GitHub through the admin API; running it again changes nothing"
./scripts/register-upstreams.sh | tee "$OUT"
grep -q "^github .*connected" "$OUT" || fail "github is not connected"
grep -q "^deepwiki .*connected" "$OUT" || fail "deepwiki is not connected"
again=$(./scripts/register-upstreams.sh)
grep -q "deepwiki: already registered" <<<"$again" || fail "register-upstreams.sh is not idempotent"
ADMIN_KEY=$(secret gateway-bootstrap-admin api-key)
curl -s -H "Authorization: Bearer $ADMIN_KEY" "$GW/api/servers" | python3 -c '
import json, sys
s = {x["slug"]: x for x in json.load(sys.stdin)}
for slug in ("woocommerce", "deepwiki", "github"):
    assert s[slug]["status"] == "connected" and s[slug]["tools"], slug
assert s["github"]["hasCredential"] and not s["deepwiki"]["hasCredential"]
print("ok: 3 upstreams connected (tools: %s)" % ", ".join("%s=%d" % (k, len(s[k]["tools"])) for k in ("woocommerce", "deepwiki", "github")))'

step "The read-only GitHub token cannot write (defence in depth: Phase 7 permissions hide write tools from members too)"
ADMIN_KEY="$ADMIN_KEY" node --input-type=module -e '
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const c = new Client({ name: "verify6", version: "1" });
await c.connect(new StreamableHTTPClientTransport(new URL(process.argv[1] + "/mcp"), { requestInit: { headers: { Authorization: "Bearer " + process.env.ADMIN_KEY } } }));
const r = await c.callTool({ name: "github__create_repository", arguments: { name: "verify6-must-not-exist" } });
await c.close();
if (!r.isError) { console.error("create_repository SUCCEEDED: the token is not read-only"); process.exit(1); }
console.log("ok: write rejected by GitHub:", r.content[0].text.slice(0, 90));' "$GW" 2>&1 | grep -v ExperimentalWarning ||
  fail "the GitHub token is not read-only; create a token with read permissions only"

step "System suite: the full definition of done, scripted (storefront, chat as A, client as B, revoke, disable, kill, audit)"
SYSTEM_GATEWAY_URL="$GW" SYSTEM_DASHBOARD_URL="$DASH" SYSTEM_STORE_URL="$STORE" \
SYSTEM_ADMIN_KEY="$ADMIN_KEY" \
SYSTEM_STORE_ADMIN_USER="$(secret store-admin username)" \
SYSTEM_STORE_ADMIN_PASSWORD="$(secret store-admin password)" \
NAMESPACE="$NS" GITHUB_MCP_TOKEN="$GITHUB_MCP_TOKEN" \
  npx vitest run --project system --reporter=verbose

step "Permissions on the live gateway: admin-only API, no leftover rules, denied attempts audited"
MEMBER_EMAIL="verify7-$(date +%s)@example.com"
INVITE=$(curl -s -X POST -H "Authorization: Bearer $ADMIN_KEY" -H "Content-Type: application/json" \
  -d "{\"email\":\"$MEMBER_EMAIL\",\"name\":\"Verify 7\"}" "$GW/api/users")
MEMBER_ID=$(python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])' <<<"$INVITE")
MEMBER_KEY=$(curl -s -X POST -H "Authorization: Bearer $ADMIN_KEY" -H "Content-Type: application/json" \
  -d '{"name":"verify7"}' "$GW/api/users/$MEMBER_ID/keys" | python3 -c 'import json,sys; print(json.load(sys.stdin)["key"])')
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
[ "$(code -H "Authorization: Bearer $MEMBER_KEY" "$GW/api/permissions")" = 403 ] || fail "a member can read /api/permissions"
[ "$(code -X PUT -H "Authorization: Bearer $MEMBER_KEY" -H 'Content-Type: application/json' \
  -d '{"role":"member","serverSlug":"woocommerce","toolName":null,"effect":"allow"}' "$GW/api/permissions")" = 403 ] ||
  fail "a member can write /api/permissions"
[ "$(code "$GW/api/permissions")" = 401 ] || fail "/api/permissions is reachable without a key"
RULES=$(curl -s -H "Authorization: Bearer $ADMIN_KEY" "$GW/api/permissions")
[ "$RULES" = "[]" ] || fail "the system suite left permission rules behind: $RULES"
curl -s -H "Authorization: Bearer $ADMIN_KEY" "$GW/api/audit?outcome=denied&limit=50" | python3 -c '
import json, sys
rows = json.load(sys.stdin)
assert any(r["tool"] == "woocommerce__update_order_status" for r in rows), rows
assert all(r["outcome"] == "denied" for r in rows)
print("ok: %d denied attempt(s) in the audit log, e.g. %s by %s" % (len(rows), rows[0]["tool"], rows[0]["userEmail"]))'
curl -s -X PATCH -H "Authorization: Bearer $ADMIN_KEY" -H "Content-Type: application/json" \
  -d '{"disabled":true}' "$GW/api/users/$MEMBER_ID" >/dev/null || true

step "The GitHub token is nowhere it shouldn't be: Helm release, pod specs, logs, API responses"
leak=""
helm get all "$RELEASE" -n "$NS" 2>/dev/null | grep -qF "$GITHUB_MCP_TOKEN" && leak="helm release"
kubectl -n "$NS" get deploy,pod,cm,secret -o yaml 2>/dev/null | grep -qF "$GITHUB_MCP_TOKEN" && leak="$leak k8s objects"
kubectl -n "$NS" logs "deployment/$GATEWAY_DEPLOY" --tail=2000 | grep -qF "$GITHUB_MCP_TOKEN" && leak="$leak gateway logs"
{ for p in /servers /tools /meta "/audit?limit=500" /users; do curl -s -H "Authorization: Bearer $ADMIN_KEY" "$GW/api$p"; done; } |
  grep -qF "$GITHUB_MCP_TOKEN" && leak="$leak API responses"
[ -z "$leak" ] || fail "GitHub token found in:$leak"
echo "ok (it exists only encrypted in the gateway's Postgres)"

if [ -z "${SKIP_REGRESSION:-}" ]; then
  step "Regression: Phase 2, 3, 4 and 5 checks against the same deployment"
  for n in 2 3 4 5; do
    echo "--- verify-phase$n"
    SKIP_DEPLOY=1 SKIP_TESTS=1 SKIP_REGRESSION=1 ./scripts/verify-phase$n.sh >"$OUT" 2>&1 || { tail -40 "$OUT"; fail "verify-phase$n.sh"; }
    tail -1 "$OUT"
  done
fi

echo
echo "All Phase 7 checks passed."
