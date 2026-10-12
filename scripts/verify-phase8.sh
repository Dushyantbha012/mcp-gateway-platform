#!/usr/bin/env bash
# Verification for Phase 8 (security hardening) against the live k3d cluster.
# It checks the new controls directly, then re-runs the whole Phase 7 script
# (which re-runs the Phase 6 definition-of-done suite and the Phase 2-5
# checks) to prove nothing broke under deny-by-default networking. Re-runnable:
#   ./scripts/verify-phase8.sh                # tests, build, deploy, verify
#   SKIP_DEPLOY=1 ./scripts/verify-phase8.sh  # reuse what's already deployed
#   SKIP_TESTS=1 ...                          # skip the repo test suites
#   SKIP_REGRESSION=1 ...                     # skip the Phase 2-7 re-run
#
# Needs what verify-phase7.sh needs: a Gemini key and a read-only GitHub token
# in $GITHUB_MCP_TOKEN or ~/.config/urumi/github.env.
set -euo pipefail
cd "$(dirname "$0")/.."
. scripts/lib/probe.sh

NS="${NAMESPACE:-urumi}"
UPSTREAM_NS="${UPSTREAM_NAMESPACE:-urumi-upstreams}"
RELEASE=platform
CLUSTER=urumi-mcp
GW="http://gateway.local.test"
GATEWAY_DEPLOY="$RELEASE-gateway"
GATEWAY_SA="system:serviceaccount:$NS:$RELEASE-gateway"
TEST_DB=postgres://gateway_test:gateway_test@localhost:5433/gateway_test
OUT=$(mktemp)

step() { echo; echo "== $* =="; }
fail() { echo "FAILED: $*"; exit 1; }
secret() { kubectl -n "$NS" get secret "$1" -o jsonpath="{.data.$2}" | base64 -d; }
trap 'rm -f "$OUT"; [ -n "${THROWAWAY:-}" ] && curl -s -X DELETE -H "Authorization: Bearer ${ADMIN_KEY:-}" "$GW/api/servers/$THROWAWAY" >/dev/null || true' EXIT

if [ -z "${GITHUB_MCP_TOKEN:-}" ] && [ -f "$HOME/.config/urumi/github.env" ]; then
  set -a; . "$HOME/.config/urumi/github.env"; set +a
fi
[ -n "${GITHUB_MCP_TOKEN:-}" ] || fail "no GitHub token: set GITHUB_MCP_TOKEN or create ~/.config/urumi/github.env"

if [ -z "${SKIP_TESTS:-}" ]; then
  step "Lint, format, unit + integration tests (SSRF table, credential store, migrations), build"
  docker compose -f docker-compose.test.yml up -d --wait >/dev/null
  npm run lint
  npm run format:check
  TEST_DATABASE_URL="$TEST_DB" npm test
  npm run build

  step "Browser E2E (includes: the dashboard refuses an internal server URL)"
  TEST_DATABASE_URL="$TEST_DB" npm run test:e2e
fi

step "Helm lints and renders for both environments; every rendered pod is hardened"
helm lint helm -f helm/values-local.yaml
helm lint helm -f helm/values-prod.yaml
for env in local prod; do
  helm template "$RELEASE" helm -f "helm/values-$env.yaml" | node scripts/manifests-to-pods.mjs |
    python3 scripts/audit-pods.py --stdin
done

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
for d in "$RELEASE-store-woocommerce-mcp" "$GATEWAY_DEPLOY" "$RELEASE-dashboard" "$RELEASE-store-wordpress"; do
  kubectl -n "$NS" rollout status "deployment/$d" --timeout=300s
done
kubectl -n "$NS" rollout status "statefulset/$RELEASE-store-mysql" --timeout=300s
sleep 5 # the NetworkPolicy controller admits new pods after a moment
ADMIN_KEY=$(secret gateway-bootstrap-admin api-key)
./scripts/register-upstreams.sh >"$OUT" || { cat "$OUT"; fail "register-upstreams.sh"; }

step "Non-root, least privilege: every running pod audited, and the API server refuses a root pod"
python3 scripts/audit-pods.py "$NS"
msg=$(kubectl -n "$NS" run rootpod --image=busybox --restart=Never -- sleep 1 2>&1 || true)
grep -q 'violates PodSecurity "restricted' <<<"$msg" || fail "a pod with no securityContext was admitted: $msg"
echo "ok: admission refused it ($(grep -o 'runAsNonRoot[^,)]*' <<<"$msg" | head -1))"

step "NetworkPolicies: every flow from every workload identity, default deny"
python3 scripts/netpol_matrix.py "$NS" "$RELEASE"
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
for u in "http://store.local.test/" "http://dashboard.local.test/" "$GW/healthz"; do
  [ "$(code "$u")" = 200 ] || fail "$u is not reachable through the ingress under default-deny"
done
echo "ok: storefront, dashboard and gateway still reachable through Traefik"

step "SSRF guard: internal destinations are refused when adding a server"
refused=0
for url in "http://169.254.169.254/latest/meta-data/" "http://localhost:8080/mcp" "http://127.0.0.1:5432/" \
  "http://2130706433/" "http://[::ffff:169.254.169.254]/" "http://kubernetes.default.svc/" \
  "http://$RELEASE-gateway-postgres:5432/" "http://$RELEASE-store-wordpress.$NS.svc.cluster.local/"; do
  body=$(curl -s -w '\n%{http_code}' -X POST -H "Authorization: Bearer $ADMIN_KEY" -H 'Content-Type: application/json' \
    -d "{\"slug\":\"ssrf-probe\",\"name\":\"probe\",\"url\":\"$url\"}" "$GW/api/servers")
  [ "$(tail -1 <<<"$body")" = 400 ] && grep -q '"url_not_allowed"' <<<"$body" || fail "$url was not refused: $body"
  refused=$((refused + 1))
done
curl -s -H "Authorization: Bearer $ADMIN_KEY" "$GW/api/servers" | python3 -c '
import json, sys
s = {x["slug"] for x in json.load(sys.stdin)}
assert "ssrf-probe" not in s, "a refused server was stored"
print("ok: %d internal URLs refused, nothing stored" % '"$refused"')'

step "Upstream credentials live in Kubernetes Secrets, scoped by RBAC, and nowhere else"
n_cred=$(curl -s -H "Authorization: Bearer $ADMIN_KEY" "$GW/api/servers" | python3 -c 'import json,sys; print(sum(1 for s in json.load(sys.stdin) if s["hasCredential"]))')
n_sec=$(kubectl -n "$UPSTREAM_NS" get secrets -l app.kubernetes.io/managed-by=mcp-gateway -o name | wc -l | tr -d ' ')
[ "$n_cred" -ge 2 ] && [ "$n_sec" = "$n_cred" ] || fail "$n_cred servers have credentials but $n_sec Secrets exist in $UPSTREAM_NS"
echo "ok: $n_sec Secret(s) in $UPSTREAM_NS for $n_cred server(s) with a credential"
found=0
for s in $(kubectl -n "$UPSTREAM_NS" get secrets -o name); do
  [ "$(kubectl -n "$UPSTREAM_NS" get "$s" -o jsonpath='{.data.credential}' | base64 -d)" = "$GITHUB_MCP_TOKEN" ] && found=1
done
[ "$found" = 1 ] || fail "the GitHub token is not stored in any Secret in $UPSTREAM_NS"
echo "ok: the GitHub token is in a Secret there"
PGPW=$(secret gateway-db password)
kubectl -n "$NS" exec "$RELEASE-gateway-postgres-0" -- env PGPASSWORD="$PGPW" psql -U gateway -d gateway -tAc \
  "select column_name from information_schema.columns where table_name='mcp_servers' and column_name like 'credential%'" |
  grep -q . && fail "mcp_servers still has a credential column in Postgres"
kubectl -n "$NS" exec "$RELEASE-gateway-postgres-0" -- env PGPASSWORD="$PGPW" pg_dump -U gateway -d gateway 2>/dev/null |
  grep -qF "$GITHUB_MCP_TOKEN" && fail "the GitHub token appears in a Postgres dump"
echo "ok: no credential column, and the token is not in a database dump"
can() { kubectl auth can-i "$1" "$2" -n "$3" --as="$GATEWAY_SA"; }
[ "$(can get secrets "$UPSTREAM_NS")" = yes ] && [ "$(can create secrets "$UPSTREAM_NS")" = yes ] &&
  [ "$(can delete secrets "$UPSTREAM_NS")" = yes ] || fail "the gateway ServiceAccount cannot manage upstream Secrets"
for denied in "get secrets $NS" "list secrets kube-system" "get pods $NS" "create pods $UPSTREAM_NS" "get nodes $NS"; do
  # shellcheck disable=SC2086
  [ "$(can $denied)" = no ] || fail "the gateway ServiceAccount can '$denied'"
done
for sa in default "$RELEASE-store-woocommerce-mcp" "$RELEASE-dashboard"; do
  [ "$(kubectl auth can-i get secrets -n "$UPSTREAM_NS" --as="system:serviceaccount:$NS:$sa")" = no ] ||
    fail "ServiceAccount $sa can read upstream Secrets"
done
echo "ok: the gateway can manage Secrets only in $UPSTREAM_NS; no other ServiceAccount can read them"

step "A server's credential follows its lifecycle: create -> rotate -> delete removes the Secret"
resp=$(curl -s -X POST -H "Authorization: Bearer $ADMIN_KEY" -H 'Content-Type: application/json' \
  -d '{"slug":"verify8-tmp","name":"Verify 8","url":"https://mcp.deepwiki.com/mcp","authType":"bearer","credential":"verify8-first"}' "$GW/api/servers")
THROWAWAY=$(python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])' <<<"$resp") || fail "could not create the throwaway server: $resp"
val() { kubectl -n "$UPSTREAM_NS" get secret "mcp-upstream-$THROWAWAY" -o jsonpath='{.data.credential}' 2>/dev/null | base64 -d; }
[ "$(val)" = verify8-first ] || fail "the new server's Secret is missing or wrong"
curl -s -X PATCH -H "Authorization: Bearer $ADMIN_KEY" -H 'Content-Type: application/json' \
  -d '{"credential":"verify8-second"}' "$GW/api/servers/$THROWAWAY" >/dev/null
[ "$(val)" = verify8-second ] || fail "rotating the credential did not update the Secret"
[ "$(code -X DELETE -H "Authorization: Bearer $ADMIN_KEY" "$GW/api/servers/$THROWAWAY")" = 204 ] || fail "delete failed"
unset THROWAWAY
sleep 1
kubectl -n "$UPSTREAM_NS" get secrets -o name | grep -q "verify8" && fail "the deleted server's Secret is still there"
echo "ok"

step "Gateway egress under default deny: public upstreams reachable, internal addresses not (from the gateway pod's own identity)"
curl -s -H "Authorization: Bearer $ADMIN_KEY" "$GW/api/servers" | python3 -c '
import json, sys
for s in json.load(sys.stdin):
    assert s["status"] == "connected", (s["slug"], s["status"], s["lastError"])
print("ok: woocommerce, deepwiki and github all connected (so: DNS, Postgres, MCP, Kubernetes API and public egress all work)")'

if [ -z "${SKIP_REGRESSION:-}" ]; then
  step "Regression: the whole Phase 7 script (Phase 6 definition of done, permissions, Phase 2-5 checks)"
  SKIP_DEPLOY=1 SKIP_TESTS=1 ./scripts/verify-phase7.sh >"$OUT" 2>&1 || { tail -60 "$OUT"; fail "verify-phase7.sh"; }
  tail -3 "$OUT"
fi

echo
echo "All Phase 8 checks passed."
