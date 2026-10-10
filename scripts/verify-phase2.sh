#!/usr/bin/env bash
# Verification for Phase 2 (store + WooCommerce MCP server), against the
# live k3d cluster. Re-runnable:
#   ./scripts/verify-phase2.sh            # full run, including a pod-kill persistence test
#   SKIP_DEPLOY=1 ./scripts/verify-phase2.sh   # reuse what's already deployed
set -euo pipefail
cd "$(dirname "$0")/.."

NS="${NAMESPACE:-urumi}"
RELEASE=platform
CLUSTER=urumi-mcp
IMAGE=mcp-gateway/woocommerce-mcp:dev
STORE_HOST=store.local.test
MCP_SVC="$RELEASE-store-woocommerce-mcp"
WP_SVC="$RELEASE-store-wordpress"
PF_PIDS=()

cleanup() {
  for pid in "${PF_PIDS[@]:-}"; do [ -n "$pid" ] && kill "$pid" 2>/dev/null || true; done
  kubectl -n "$NS" delete pod mcp-probe --ignore-not-found --wait=false >/dev/null 2>&1 || true
}
trap cleanup EXIT

step() { echo; echo "== $* =="; }
fail() { echo "FAILED: $*"; exit 1; }
# Fetch first, then grep: with pipefail, `curl | grep -q` can "fail" on a
# match, because grep exits early and curl dies of SIGPIPE.
shop_lists() { local html; html=$(curl -s "http://$STORE_HOST/shop/"); grep -q "$1" <<<"$html"; }
secret() { kubectl -n "$NS" get secret "$1" -o jsonpath="{.data.$2}" | base64 -d; }

step "Lint, format, unit + protocol tests"
npm run lint
npm run format:check
npm test

step "Helm chart lints and renders for both environments"
helm lint helm -f helm/values-local.yaml
helm lint helm -f helm/values-prod.yaml
helm template "$RELEASE" helm -f helm/values-prod.yaml >/dev/null

if [ -z "${SKIP_DEPLOY:-}" ]; then
  step "Build MCP image, import into k3d, deploy"
  docker build -q -f woocommerce-mcp/Dockerfile -t "$IMAGE" .
  k3d image import "$IMAGE" -c "$CLUSTER" >/dev/null
  ./scripts/create-secrets.sh
  helm upgrade --install "$RELEASE" helm -n "$NS" -f helm/values-local.yaml --wait --timeout 15m
  kubectl -n "$NS" rollout restart "deployment/$MCP_SVC" # pick up a re-imported :dev image
  kubectl -n "$NS" rollout status "deployment/$MCP_SVC" --timeout=120s
fi

step "All workloads ready; bootstrap Job succeeded"
kubectl -n "$NS" get pods
# rollout status rather than waiting on pods: it copes with pods that are
# being replaced mid-check (e.g. right after a rollout restart).
rollout() {
  kubectl -n "$NS" rollout status "statefulset/$RELEASE-store-mysql" --timeout=300s
  kubectl -n "$NS" rollout status "deployment/$WP_SVC" --timeout=300s
  kubectl -n "$NS" rollout status "deployment/$MCP_SVC" --timeout=300s
}
rollout
[ "$(kubectl -n "$NS" get job "$RELEASE-store-bootstrap" -o jsonpath='{.status.succeeded}')" = "1" ] ||
  fail "bootstrap Job did not succeed (kubectl -n $NS logs job/$RELEASE-store-bootstrap)"

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

step "Storefront is reachable through Ingress and lists demo products"
code=$(curl -s -o /dev/null -w "%{http_code}" "http://$STORE_HOST/")
[ "$code" = "200" ] || fail "storefront returned HTTP $code"
shop_lists "Urumi Coffee Mug" || fail "demo product not on /shop/"
echo "ok"

step "MCP server is NOT reachable from outside the cluster"
[ "$(kubectl -n "$NS" get svc "$MCP_SVC" -o jsonpath='{.spec.type}')" = "ClusterIP" ] || fail "MCP Service is not ClusterIP"
backends=$(kubectl -n "$NS" get ingress -o jsonpath='{range .items[*]}{.spec.rules[*].http.paths[*].backend.service.name}{"\n"}{end}')
if grep -qx "$MCP_SVC" <<<"$backends"; then
  fail "an Ingress routes to the MCP server"
fi
code=$(curl -s -o /dev/null -w "%{http_code}" -H "Host: woocommerce-mcp.local.test" http://127.0.0.1/mcp -X POST)
[ "$code" = "404" ] || fail "Traefik answered $code for an unknown host"
echo "ok (ClusterIP, no Ingress, Traefik 404s unknown hosts)"

step "MCP server IS reachable from inside the cluster, with the token only"
TOKEN=$(secret woocommerce-mcp-auth token)
URL="http://$MCP_SVC.$NS.svc.cluster.local:3000/mcp"
INIT='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"probe","version":"1"}}}'
LIST='{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
kubectl -n "$NS" run mcp-probe --rm -i --restart=Never --quiet --image=curlimages/curl:8.11.1 \
  --env="TOKEN=$TOKEN" --command -- sh -c "
    h='-H content-type:application/json -H accept:application/json,text/event-stream'
    noauth=\$(curl -s -o /dev/null -w '%{http_code}' \$h -X POST '$URL' -d '$INIT')
    echo \"without token: HTTP \$noauth\"
    [ \"\$noauth\" = 401 ] || exit 1
    curl -sf \$h -H \"authorization: Bearer \$TOKEN\" -X POST '$URL' -d '$INIT' >/dev/null || exit 1
    tools=\$(curl -sf \$h -H \"authorization: Bearer \$TOKEN\" -X POST '$URL' -d '$LIST')
    for t in list_products create_product list_orders get_order update_order_status; do
      echo \"\$tools\" | grep -q \"\\\"\$t\\\"\" || { echo \"missing tool \$t\"; exit 1; }
    done
    echo 'with token: all 5 tools listed'
  " || fail "in-cluster MCP probe"

port_forward() { # service local:remote
  kubectl -n "$NS" port-forward "svc/$1" "$2" >/dev/null 2>&1 &
  PF_PIDS+=($!)
}
wait_port() { for _ in $(seq 1 30); do curl -s -o /dev/null "http://127.0.0.1:$1" && return 0; sleep 1; done; fail "port-forward on $1"; }

step "Live integration tests: deployed MCP server against the real store"
port_forward "$MCP_SVC" 13000:3000
port_forward "$WP_SVC" 18080:80
wait_port 13000
wait_port 18080
MCP_LIVE_URL=http://127.0.0.1:13000/mcp \
MCP_LIVE_TOKEN="$TOKEN" \
WC_LIVE_URL=http://127.0.0.1:18080 \
WC_LIVE_SIGNING_URL="http://$STORE_HOST" \
WC_LIVE_KEY="$(secret store-wc-api consumer-key)" \
WC_LIVE_SECRET="$(secret store-wc-api consumer-secret)" \
  npx vitest run woocommerce-mcp/src/live.integration.test.ts

step "Persistence: data survives deleting the MySQL and WordPress pods"
kubectl -n "$NS" delete pod -l "app.kubernetes.io/component in (mysql,wordpress)" --wait=true
rollout
# MySQL replays its redo log on restart; give the pair up to 3 minutes.
for _ in $(seq 1 90); do
  shop_lists "Urumi Coffee Mug" && break
  sleep 2
done
shop_lists "Urumi Coffee Mug" || fail "products gone after pod restart"
echo "ok"

step "Bootstrap is idempotent: a second upgrade re-runs it cleanly"
helm upgrade "$RELEASE" helm -n "$NS" -f helm/values-local.yaml --wait --timeout 10m >/dev/null
[ "$(kubectl -n "$NS" get job "$RELEASE-store-bootstrap" -o jsonpath='{.status.succeeded}')" = "1" ] ||
  fail "bootstrap failed on re-run"
html=$(curl -s "http://$STORE_HOST/shop/")
count=$(grep -o "Urumi Coffee Mug</a>" <<<"$html" | wc -l | tr -d ' ')
[ "$count" = "1" ] || fail "expected the demo product once on /shop/, found $count"
echo "ok"

echo
echo "All Phase 2 checks passed."
