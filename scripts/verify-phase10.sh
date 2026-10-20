#!/usr/bin/env bash
# Verification for multi-store provisioning against the live k3d cluster:
# create two stores through the API, watch the provisioner build them, use
# both through the one gateway endpoint, prove they can't reach each other,
# then delete one and check nothing of it is left. Re-runnable:
#   ./scripts/verify-phase10.sh               # build, deploy, verify
#   SKIP_DEPLOY=1 ./scripts/verify-phase10.sh # reuse what's already deployed
#   KEEP_STORES=1 ...                         # leave both stores running at the end
#
# Provisioning downloads WooCommerce, so a cold run takes a few minutes per store
# (they're built in parallel).
set -euo pipefail
cd "$(dirname "$0")/.."
. scripts/lib/probe.sh

NS="${NAMESPACE:-urumi}"
RELEASE=platform
CLUSTER=urumi-mcp
GW="http://gateway.local.test"
BASE_DOMAIN=store.local.test
STORES=(acme globex)

step() { echo; echo "== $* =="; }
fail() { echo "FAILED: $*"; exit 1; }
secret() { kubectl -n "$NS" get secret "$1" -o jsonpath="{.data.$2}" | base64 -d; }
jsonget() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)"; }

if [ -z "${SKIP_DEPLOY:-}" ]; then
  step "Build the gateway (it ships the provisioner) and dashboard, import into k3d, deploy"
  for app in gateway dashboard; do
    docker build -q -f "$app/Dockerfile" -t "mcp-gateway/$app:dev" . >/dev/null
    k3d image import "mcp-gateway/$app:dev" -c "$CLUSTER" >/dev/null
  done
  helm upgrade --install "$RELEASE" helm -n "$NS" -f helm/values-local.yaml --wait --timeout 15m >/dev/null
  kubectl -n "$NS" rollout restart "deployment/$RELEASE-gateway" "deployment/$RELEASE-dashboard" \
    "deployment/$RELEASE-gateway-provisioner" >/dev/null
fi
for d in gateway gateway-provisioner dashboard; do
  kubectl -n "$NS" rollout status "deployment/$RELEASE-$d" --timeout=300s >/dev/null
done

ADMIN_KEY=$(secret gateway-bootstrap-admin api-key)
api() { curl -s -H "Authorization: Bearer $ADMIN_KEY" -H "Content-Type: application/json" "$GW/api$1" "${@:2}"; }
mcp() {
  curl -s -X POST "$GW/mcp" -H "Authorization: Bearer $ADMIN_KEY" \
    -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -d "$1"
}
store_field() { api /stores | jsonget "next((s['$2'] or '') for s in d['stores'] if s['slug'] == '$1')"; }

step "The provisioner is least-privileged and unreachable"
PROV_SA="system:serviceaccount:$NS:$RELEASE-gateway-provisioner"
can() { kubectl auth can-i "$1" "$2" -n "$3" --as="$PROV_SA" 2>/dev/null; }
[ "$(can create namespaces default)" = yes ] || fail "the provisioner can't create namespaces"
for denied in "list secrets $NS" "create rolebindings store-x" "create clusterroles default" \
  "create pods store-x" "get nodes default" "create pods/exec store-x"; do
  # shellcheck disable=SC2086
  [ "$(can $denied)" = no ] || fail "the provisioner ServiceAccount can '$denied'"
done
[ "$(kubectl auth can-i create namespaces --as="system:serviceaccount:$NS:$RELEASE-gateway" 2>/dev/null)" = no ] ||
  fail "the gateway ServiceAccount can create namespaces"
echo "ok: only the provisioner creates namespaces; it can't list Secrets, exec, or grant itself RBAC"

step "Create ${STORES[*]} through the API (a repeated request is not a second store)"
for s in "${STORES[@]}"; do
  code=$(api /stores -o /dev/null -w '%{http_code}' -X POST -d "{\"name\":\"$s\"}")
  [ "$code" = 201 ] || [ "$code" = 200 ] || fail "creating $s: HTTP $code"
  again=$(api /stores -o /dev/null -w '%{http_code}' -X POST -d "{\"name\":\"$s\"}")
  [ "$again" = 200 ] || fail "repeating the create of $s answered HTTP $again"
  echo "ok: $s requested (HTTP $code, repeat HTTP $again)"
done

step "Wait for both stores to be ready (each step as the provisioner reports it)"
deadline=$((SECONDS + 1200))
seen="" # "slug:progress" lines already printed (macOS bash 3.2: no associative arrays)
while :; do
  pending=0
  for s in "${STORES[@]}"; do
    status=$(store_field "$s" status)
    progress="$status $(store_field "$s" step) $(store_field "$s" reason)"
    grep -qxF "$s:$progress" <<<"$seen" || { echo "  $s: $progress"; seen="$seen"$'\n'"$s:$progress"; }
    [ "$status" = failed ] && fail "$s failed: $(store_field "$s" reason)"
    [ "$status" = ready ] || pending=1
  done
  [ "$pending" = 0 ] && break
  [ "$SECONDS" -lt "$deadline" ] || fail "stores not ready after 20 minutes"
  sleep 5
done
echo "ok: both stores ready"

step "Each store is isolated in its own namespace, inside its quota"
for s in "${STORES[@]}"; do
  ns="store-$s"
  [ "$(kubectl get ns "$ns" -o jsonpath='{.metadata.labels.urumi\.ai/managed-by}')" = provisioner ] ||
    fail "$ns is not labelled as the provisioner's"
  [ "$(kubectl get ns "$ns" -o jsonpath='{.metadata.labels.pod-security\.kubernetes\.io/enforce}')" = restricted ] ||
    fail "$ns does not enforce restricted Pod Security"
  kubectl -n "$ns" get resourcequota store-quota -o jsonpath='{.status.used}' | python3 -c "
import json, sys
used = json.load(sys.stdin)
print('ok: $ns quota used:', ', '.join(f'{k}={used[k]}' for k in ('requests.cpu', 'requests.memory', 'limits.cpu', 'limits.memory', 'pods')))"
  python3 scripts/audit-pods.py "$ns" | tail -1
done
msg=$(kubectl -n store-acme run rootpod --image=busybox --restart=Never -- sleep 1 2>&1 || true)
grep -q 'violates PodSecurity "restricted' <<<"$msg" || fail "a root pod was admitted in store-acme: $msg"
echo "ok: store-acme refuses a pod with no securityContext"

step "The storefronts answer through Traefik at <slug>.$BASE_DOMAIN"
for s in "${STORES[@]}"; do
  host="$s.$BASE_DOMAIN"
  code=$(curl -s -o /dev/null -w '%{http_code}' --resolve "$host:80:127.0.0.1" "http://$host/")
  [ "$code" = 200 ] || fail "http://$host/ answered HTTP $code"
  grep -q "$host" /etc/hosts || echo "  (to open it in a browser: echo '127.0.0.1 $host' | sudo tee -a /etc/hosts)"
  echo "ok: http://$host/ is up"
done

step "Both stores' tools are served by the one gateway endpoint"
for _ in $(seq 1 30); do
  names=$(mcp '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | jsonget '" ".join(t["name"] for t in d["result"]["tools"])')
  grep -q "acme__list_orders" <<<"$names" && grep -q "globex__list_orders" <<<"$names" && break
  sleep 2 # the gateway's health loop picks new servers up within its interval
done
for s in "${STORES[@]}" woocommerce; do
  grep -q "${s}__list_orders" <<<"$names" || fail "${s}__list_orders is not in tools/list"
  out=$(mcp "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"${s}__list_products\",\"arguments\":{}}}")
  ok=$(jsonget '"error" not in d and not d["result"].get("isError")' <<<"$out")
  [ "$ok" = True ] || fail "${s}__list_products failed: $out"
  n=$(jsonget 'len(__import__("json").loads(d["result"]["content"][0]["text"]).get("products", []))' <<<"$out" 2>/dev/null || echo "?")
  echo "ok: ${s}__list_products answered ($n products)"
done
api /servers | jsonget '"\n".join(f"  {s[\"slug\"]:12} managedBy={s[\"managedBy\"]} status={s[\"status\"]}" for s in d)'
code=$(api "/servers/$(store_field acme serverId)" -o /dev/null -w '%{http_code}' -X PATCH -d '{"name":"x"}')
[ "$code" = 409 ] || fail "editing a store's managed server answered HTTP $code"
echo "ok: the admin API refuses to edit a store's managed server (409)"

step "Stores can't reach each other or the platform (probes carry the real pods' labels)"
targets="globex-mysql=mysql.store-globex.svc.cluster.local:3306
globex-wordpress=wordpress.store-globex.svc.cluster.local:80
globex-mcp=woocommerce-mcp.store-globex.svc.cluster.local:3000
postgres=$RELEASE-gateway-postgres.$NS.svc.cluster.local:5432
default-mysql=$RELEASE-store-mysql.$NS.svc.cluster.local:3306
k8s-api=kubernetes.default.svc:443
own-mysql=mysql.store-acme.svc.cluster.local:3306
own-wordpress=wordpress.store-acme.svc.cluster.local:80"
script="sleep 4
$(while IFS== read -r name addr; do
  echo "( curl -sv --max-time 4 telnet://$addr </dev/null 2>&1 | grep -q 'Connected to' && echo '$name=open' || echo '$name=blocked' ) &"
done <<<"$targets")
wait"
check_matrix() { # source-label expected-open...
  local label="$1"; shift
  local out
  out=$(run_probe "probe-$label" "app.kubernetes.io/instance=store-acme,app.kubernetes.io/component=$label" "$script" store-acme | sort)
  while IFS== read -r name state; do
    want=blocked
    for o in "$@"; do [ "$o" = "$name" ] && want=open; done
    [ "$state" = "$want" ] || fail "acme $label -> $name is $state (expected $want)"
  done <<<"$out"
  echo "ok: acme's $label reaches only: ${*:-nothing}"
}
check_matrix wordpress own-mysql
check_matrix woocommerce-mcp own-wordpress
check_matrix mysql

step "The gateway reaches each store's MCP server, and only that"
gw_labels="app.kubernetes.io/instance=$RELEASE-gateway,app.kubernetes.io/component=gateway,urumi.ai/mcp-client=true"
out=$(run_probe probe-gw "$gw_labels" "sleep 4
for t in woocommerce-mcp.store-acme.svc.cluster.local:3000 mysql.store-acme.svc.cluster.local:3306 wordpress.store-globex.svc.cluster.local:80; do
  curl -sv --max-time 4 telnet://\$t </dev/null 2>&1 | grep -q 'Connected to' && echo \"\$t=open\" || echo \"\$t=blocked\"
done")
echo "$out" | sed 's/^/  /'
grep -q 'woocommerce-mcp.store-acme.svc.cluster.local:3000=open' <<<"$out" || fail "the gateway can't reach acme's MCP server"
grep -q 'mysql.store-acme.svc.cluster.local:3306=blocked' <<<"$out" || fail "the gateway can reach acme's MySQL"
grep -q 'wordpress.store-globex.svc.cluster.local:80=blocked' <<<"$out" || fail "the gateway can reach globex's WordPress"
echo "ok"

if [ -n "${KEEP_STORES:-}" ]; then
  echo; echo "KEEP_STORES set: leaving both stores running."; exit 0
fi

step "Delete globex: its tools go at once, then its namespace, volumes and Secrets"
GLOBEX_ID=$(store_field globex id)
GLOBEX_SERVER=$(store_field globex serverId)
code=$(api "/stores/$GLOBEX_ID" -o /dev/null -w '%{http_code}' -X DELETE)
[ "$code" = 202 ] || fail "deleting globex answered HTTP $code"
for _ in $(seq 1 120); do
  [ -z "$(store_field globex id)" ] && break
  sleep 3
done
[ -z "$(store_field globex id)" ] || fail "globex still listed: $(store_field globex step)"
kubectl get ns store-globex >/dev/null 2>&1 && fail "namespace store-globex still exists"
[ -z "$(kubectl get pv -o jsonpath='{range .items[?(@.spec.claimRef.namespace=="store-globex")]}{.metadata.name}{"\n"}{end}')" ] ||
  fail "a PersistentVolume of store-globex is left"
kubectl -n urumi-upstreams get secret "mcp-upstream-$GLOBEX_SERVER" >/dev/null 2>&1 &&
  fail "globex's MCP credential Secret is left"
names=$(mcp '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | jsonget '" ".join(t["name"] for t in d["result"]["tools"])')
grep -q "globex__" <<<"$names" && fail "globex tools are still listed"
grep -q "acme__list_orders" <<<"$names" || fail "acme's tools went too"
echo "ok: store row, namespace, volumes, credential and tools of globex are gone; acme is untouched"

echo; echo "Phase 10 (multi-store) verified."
