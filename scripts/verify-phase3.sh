#!/usr/bin/env bash
# Verification for Phase 3 (gateway core), against the live k3d cluster.
# Re-runnable:
#   ./scripts/verify-phase3.sh                # build, deploy, verify
#   SKIP_DEPLOY=1 ./scripts/verify-phase3.sh  # reuse what's already deployed
set -euo pipefail
cd "$(dirname "$0")/.."
. scripts/lib/probe.sh

NS="${NAMESPACE:-urumi}"
RELEASE=platform
CLUSTER=urumi-mcp
GW="http://gateway.local.test"
GW_DEPLOY="$RELEASE-gateway"
PG="$RELEASE-gateway-postgres"
MCP_DEPLOY="$RELEASE-store-woocommerce-mcp"
TEST_DB=postgres://gateway_test:gateway_test@localhost:5433/gateway_test

cleanup() {
  kubectl -n "$NS" delete pod np-unlabelled np-client-only np-gateway --ignore-not-found --wait=false >/dev/null 2>&1 || true
  # Never leave the store's MCP server scaled down if a check fails midway.
  kubectl -n "$NS" scale "deployment/$MCP_DEPLOY" --replicas=1 >/dev/null 2>&1 || true
}
trap cleanup EXIT

step() { echo; echo "== $* =="; }
fail() { echo "FAILED: $*"; exit 1; }
secret() { kubectl -n "$NS" get secret "$1" -o jsonpath="{.data.$2}" | base64 -d; }
# Reads one expression from JSON on stdin, e.g. jsonget 'd["status"]'.
jsonget() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)"; }

step "Lint, format, unit + integration tests (real Postgres)"
docker compose -f docker-compose.test.yml up -d --wait >/dev/null
npm run lint
npm run format:check
TEST_DATABASE_URL="$TEST_DB" npm test

step "Helm chart lints and renders for both environments"
helm lint helm -f helm/values-local.yaml
helm lint helm -f helm/values-prod.yaml
helm template "$RELEASE" helm -f helm/values-prod.yaml >/dev/null

if [ -z "${SKIP_DEPLOY:-}" ]; then
  step "Build images, import into k3d, deploy"
  for app in woocommerce-mcp gateway; do
    docker build -q -f "$app/Dockerfile" -t "mcp-gateway/$app:dev" . >/dev/null
    k3d image import "mcp-gateway/$app:dev" -c "$CLUSTER" >/dev/null
  done
  ./scripts/create-secrets.sh
  helm upgrade --install "$RELEASE" helm -n "$NS" -f helm/values-local.yaml --wait --timeout 15m
  # Pick up re-imported :dev images.
  kubectl -n "$NS" rollout restart "deployment/$MCP_DEPLOY" "deployment/$GW_DEPLOY"
fi

step "All workloads ready"
kubectl -n "$NS" rollout status "statefulset/$PG" --timeout=300s
kubectl -n "$NS" rollout status "deployment/$MCP_DEPLOY" --timeout=300s
kubectl -n "$NS" rollout status "deployment/$GW_DEPLOY" --timeout=300s
kubectl -n "$NS" get pods

step "Every container has probes and resource requests/limits"
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
echo "ok"

step "Gateway is reachable through Ingress; Postgres data is on a bound PVC"
[ "$(curl -s -o /dev/null -w '%{http_code}' "$GW/healthz")" = "200" ] || fail "gateway /healthz via Ingress"
[ "$(kubectl -n "$NS" get pvc "data-$PG-0" -o jsonpath='{.status.phase}')" = "Bound" ] || fail "Postgres PVC not bound"
echo "ok"

ADMIN_KEY=$(secret gateway-bootstrap-admin api-key)
WC_TOKEN=$(secret woocommerce-mcp-auth token)
api() { curl -s -H "Authorization: Bearer $ADMIN_KEY" -H "Content-Type: application/json" "$GW/api$1" "${@:2}"; }
# Plain JSON-RPC over HTTP, as any MCP client would send it (stateless: no session).
mcp() {
  curl -s -X POST "$GW/mcp" -H "Authorization: Bearer $ADMIN_KEY" \
    -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -d "$1"
}
call_tool() { mcp "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"$1\",\"arguments\":{}}}"; }
list_tools() { mcp '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | jsonget '" ".join(t["name"] for t in d["result"]["tools"])'; }
woo_status() { api /servers | jsonget 'next(s["status"] for s in d if s["slug"] == "woocommerce")'; }
wait_status() { # expected seconds
  for _ in $(seq 1 "$2"); do [ "$(woo_status)" = "$1" ] && return 0; sleep 1; done
  fail "woocommerce status did not become $1 within $2s (is: $(woo_status))"
}

step "Live integration tests: real MCP client against the deployed gateway"
GATEWAY_LIVE_URL="$GW" GATEWAY_LIVE_ADMIN_KEY="$ADMIN_KEY" GATEWAY_LIVE_WC_TOKEN="$WC_TOKEN" \
  npx vitest run gateway/src/live.integration.test.ts

step "Kill the WooCommerce MCP server: gateway stays up, shows it unreachable, recovers"
wait_status connected 30
kubectl -n "$NS" scale "deployment/$MCP_DEPLOY" --replicas=0
kubectl -n "$NS" wait --for=delete pod -l app.kubernetes.io/component=woocommerce-mcp --timeout=60s >/dev/null
# No manual refresh: the background health loop (15s) must notice by itself.
wait_status unreachable 40
reason=$(api /servers | jsonget 'next(s["lastError"] for s in d if s["slug"] == "woocommerce")')
echo "dashboard status: unreachable ($reason)"
result=$(call_tool woocommerce__list_products)
[ "$(jsonget 'd["result"]["isError"]' <<<"$result")" = "True" ] || fail "call to dead upstream didn't return isError"
grep -q "unreachable\|timed out" <<<"$result" || fail "unclear error: $result"
[ "$(curl -s -o /dev/null -w '%{http_code}' "$GW/api/me" -H "Authorization: Bearer $ADMIN_KEY")" = "200" ] ||
  fail "gateway API broken while an upstream is down"
grep -q "woocommerce__" <<<"$(list_tools)" && fail "dead server's tools still listed"
kubectl -n "$NS" scale "deployment/$MCP_DEPLOY" --replicas=1
kubectl -n "$NS" rollout status "deployment/$MCP_DEPLOY" --timeout=120s >/dev/null
wait_status connected 40
[ "$(call_tool woocommerce__list_products | jsonget 'd["result"].get("isError", False)')" = "False" ] ||
  fail "call failed after recovery"
echo "ok (unreachable -> connected again, tools back)"

step "NetworkPolicies: only the gateway reaches Postgres and the WooCommerce MCP server"
MCP_URL="http://$MCP_DEPLOY:3000/healthz"
# curl -v prints "Connected to" only if the TCP handshake succeeded; the short
# sleep lets the NetworkPolicy controller see the new pod first.
probe='sleep 3
  curl -s -o /dev/null --max-time 3 '"$MCP_URL"' && echo "mcp=open" || echo "mcp=blocked"
  curl -sv --max-time 3 telnet://'"$PG"':5432 </dev/null 2>&1 | grep -q "Connected to" && echo "pg=open" || echo "pg=blocked"'
out=$(run_probe np-unlabelled "" "$probe")
echo "unlabelled pod: $(tr '\n' ' ' <<<"$out")"
grep -q "mcp=blocked" <<<"$out" || fail "an unlabelled pod reached the MCP server"
grep -q "pg=blocked" <<<"$out" || fail "an unlabelled pod reached Postgres"
# Carrying only the MCP-client label is not enough any more: with default-deny
# egress (Phase 8) a pod may open connections only if a policy selects it as
# the gateway (scripts/netpol_matrix.py checks every flow).
out=$(run_probe np-client-only "urumi.ai/mcp-client=true" "$probe")
echo "MCP-client label alone: $(tr '\n' ' ' <<<"$out")"
grep -q "mcp=blocked" <<<"$out" || fail "a pod with just the client label reached the MCP server"
grep -q "pg=blocked" <<<"$out" || fail "a pod with just the client label reached Postgres"
out=$(run_probe np-gateway "app.kubernetes.io/instance=platform-gateway,app.kubernetes.io/component=gateway,urumi.ai/mcp-client=true" "$probe")
echo "gateway identity: $(tr '\n' ' ' <<<"$out")"
grep -q "mcp=open" <<<"$out" || fail "the gateway's identity couldn't reach the MCP server"
grep -q "pg=open" <<<"$out" || fail "the gateway's identity couldn't reach Postgres"
echo "gateway pod: Ready (needs Postgres) and woocommerce connected (needs the MCP server)"

step "Audit log recorded the calls above, attributed to the caller"
api "/audit?server=woocommerce&limit=200" | python3 -c '
import json, sys
rows = json.load(sys.stdin)
outcomes = {r["outcome"] for r in rows if r["userEmail"] == "admin@example.com"}
missing = {"success", "unreachable", "rejected"} - outcomes
if missing: sys.exit(f"missing audit outcomes for admin: {missing}")
print(f"ok ({len(rows)} woocommerce rows; outcomes seen: {sorted(outcomes)})")
' || fail "audit log"

step "No secret values in the Helm release or the gateway's API"
manifest=$(helm get manifest "$RELEASE" -n "$NS")
for value in "$WC_TOKEN" "$ADMIN_KEY" "$(secret gateway-db password)"; do
  grep -qF "$value" <<<"$manifest" && fail "a secret value appears in the Helm release"
done
api /servers | grep -qF "$WC_TOKEN" && fail "WooCommerce token returned by /api/servers"
echo "ok"

step "Persistence: gateway data survives deleting the gateway and Postgres pods"
before=$(api "/audit?limit=500" | jsonget 'len(d)')
kubectl -n "$NS" delete pod -l "app.kubernetes.io/instance=$RELEASE-gateway" --wait=true
kubectl -n "$NS" rollout status "statefulset/$PG" --timeout=300s
kubectl -n "$NS" rollout status "deployment/$GW_DEPLOY" --timeout=300s
for _ in $(seq 1 30); do
  [ "$(curl -s -o /dev/null -w '%{http_code}' "$GW/api/me" -H "Authorization: Bearer $ADMIN_KEY")" = "200" ] && break
  sleep 2
done
after=$(api "/audit?limit=500" | jsonget 'len(d)')
[ "$after" -ge "$before" ] || fail "audit rows lost: $before before, $after after"
[ "$(api /servers | jsonget 'any(s["slug"] == "woocommerce" for s in d)')" = "True" ] || fail "servers lost"
echo "ok (admin key still valid, $after audit rows kept, servers kept)"

echo
echo "All Phase 3 checks passed."
