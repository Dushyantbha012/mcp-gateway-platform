#!/usr/bin/env bash
# Verification for hosted MCP servers against the live k3d cluster: deploy a
# stdio image (behind the bridge) and an HTTP image through the admin API,
# use both through the one gateway endpoint (approving a held call), probe
# what their pods can and can't reach, audit them, then delete them and check
# nothing of them is left. Re-runnable:
#   ./scripts/verify-hosted.sh                # build, deploy, verify
#   SKIP_DEPLOY=1 ./scripts/verify-hosted.sh  # reuse what's already deployed
#   KEEP_HOSTED=1 ...                         # leave the stdio server running at the end
#
# Pulls mcp/sequentialthinking from Docker Hub on the first run.
set -euo pipefail
cd "$(dirname "$0")/.."
. scripts/lib/probe.sh

NS="${NAMESPACE:-urumi}"
RELEASE=platform
CLUSTER=urumi-mcp
GW="http://gateway.local.test"
DASH="http://dashboard.local.test"
# Docker Hub's mcp/* images only publish :latest, which the allowlist refuses, so pin by digest.
STDIO_IMAGE="mcp/sequentialthinking@sha256:cd3174b2ecf37738654cf7671fb1b719a225c40a78274817da00c4241f465e5f"
HTTP_IMAGE="mcp-gateway/woocommerce-mcp:dev"
SECRET_VALUE="verify-hosted-$RANDOM$RANDOM"

step() { echo; echo "== $* =="; }
fail() { echo "FAILED: $*"; exit 1; }
secret() { kubectl -n "$NS" get secret "$1" -o jsonpath="{.data.$2}" | base64 -d; }
jsonget() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)"; }
JAR=$(mktemp)
trap 'rm -f "$JAR"' EXIT

if [ -z "${SKIP_DEPLOY:-}" ]; then
  step "Build the gateway (and provisioner), bridge, woocommerce-mcp and dashboard; import; deploy"
  for app in gateway mcp-bridge woocommerce-mcp dashboard; do
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
call() { mcp "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"$1\",\"arguments\":$2}}"; }
tool_names() { mcp '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | jsonget '" ".join(t["name"] for t in d["result"]["tools"])'; }
# "" when the hosted server doesn't exist (or the field is null).
hosted_field() { api /hosted | jsonget "next(((str(s['$2']) if s['$2'] is not None else '') for s in d['servers'] if s['slug'] == '$1'), '')"; }
psql_gw() { kubectl -n "$NS" exec "$RELEASE-gateway-postgres-0" -- sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -Atc \"$1\""; }

delete_hosted() { # slug
  local id; id=$(hosted_field "$1" id)
  [ -z "$id" ] && return 0
  api "/hosted/$id" -o /dev/null -X DELETE
  for _ in $(seq 1 100); do
    [ -z "$(hosted_field "$1" id)" ] && ! kubectl get ns "mcp-$1" >/dev/null 2>&1 && return 0
    sleep 3
  done
  fail "$1 still there after 5 minutes: $(hosted_field "$1" step)"
}

[ "$(api /hosted | jsonget 'd["enabled"]')" = True ] || fail "hosting is switched off (gateway.hosted.enabled)"
for s in thinking woo-http broken; do delete_hosted "$s"; done # leftovers of an interrupted run

step "Only allowlisted, pinned images are accepted (and refusals are audited)"
for image in "evil/miner:1" "mcp/sequentialthinking:latest" "mcp/sequentialthinking"; do
  out=$(api /hosted -X POST -d "{\"slug\":\"refused\",\"name\":\"x\",\"image\":\"$image\",\"transport\":\"stdio\",\"command\":[\"x\"]}")
  [ "$(jsonget 'd["error"]["code"]' <<<"$out")" = image_not_allowed ] || fail "$image was not refused: $out"
  echo "ok: $image refused: $(jsonget 'd["error"]["message"]' <<<"$out")"
done
[ "$(psql_gw "select count(*) from audit_log where tool_name = 'hosted.image_refused' and detail = 'evil/miner:1'")" -ge 1 ] ||
  fail "the refusal was not audited"
echo "ok: refusals are in the audit log"

step "Deploy a stdio image behind the bridge, and an HTTP image with a generated bearer token"
code=$(api /hosted -o /dev/null -w '%{http_code}' -X POST -d "{
  \"slug\":\"thinking\",\"name\":\"Sequential thinking\",\"image\":\"$STDIO_IMAGE\",
  \"transport\":\"stdio\",\"command\":[\"node\",\"dist/index.js\"],\"libc\":\"musl\",
  \"secretEnv\":{\"VERIFY_SECRET\":\"$SECRET_VALUE\"}}")
[ "$code" = 201 ] || fail "creating thinking: HTTP $code"
# The store's own MCP image, pointed at the default store: it can't get there
# (private ranges are never allowed), which is exactly what a call should show.
code=$(api /hosted -o /dev/null -w '%{http_code}' -X POST -d "{
  \"slug\":\"woo-http\",\"name\":\"Woo over HTTP\",\"image\":\"$HTTP_IMAGE\",
  \"transport\":\"http\",\"port\":3000,\"authTokenEnv\":\"MCP_AUTH_TOKEN\",\"egress\":\"internet\",
  \"env\":{\"WC_BASE_URL\":\"http://$RELEASE-store-wordpress.$NS.svc.cluster.local\"},
  \"secretEnv\":{\"WC_CONSUMER_KEY\":\"ck_verify\",\"WC_CONSUMER_SECRET\":\"cs_verify\"}}")
[ "$code" = 201 ] || fail "creating woo-http: HTTP $code"
echo "ok: both requested"

deadline=$((SECONDS + 600))
seen=""
while :; do
  pending=0
  for s in thinking woo-http; do
    status=$(hosted_field "$s" status)
    progress="$status $(hosted_field "$s" step) $(hosted_field "$s" reason)"
    grep -qxF "$s:$progress" <<<"$seen" || { echo "  $s: $progress"; seen="$seen"$'\n'"$s:$progress"; }
    [ "$status" = failed ] && fail "$s failed: $(hosted_field "$s" reason)"
    [ "$status" = ready ] || pending=1
  done
  [ "$pending" = 0 ] && break
  [ "$SECONDS" -lt "$deadline" ] || fail "hosted servers not ready after 10 minutes"
  sleep 3
done
echo "ok: both ready"

step "Secret variables live in a Kubernetes Secret, never in Postgres"
[ "$(kubectl -n mcp-thinking get secret server-env -o jsonpath='{.data.VERIFY_SECRET}' | base64 -d)" = "$SECRET_VALUE" ] ||
  fail "VERIFY_SECRET did not reach the server's namespace"
[ "$(psql_gw "select count(*) from hosted_servers where row_to_json(hosted_servers)::text like '%$SECRET_VALUE%'")" = 0 ] ||
  fail "the secret value is in Postgres"
[ "$(psql_gw "select count(*) from audit_log where coalesce(detail,'') || coalesce(error,'') like '%$SECRET_VALUE%'")" = 0 ] ||
  fail "the secret value is in the audit log"
api /hosted | grep -q "$SECRET_VALUE" && fail "the API returns the secret value"
echo "ok: the value is only in mcp-thinking/server-env; the API and database know its name"

step "Each server runs hardened, in its own restricted namespace"
for s in thinking woo-http; do
  ns="mcp-$s"
  [ "$(kubectl get ns "$ns" -o jsonpath='{.metadata.labels.urumi\.ai/managed-by}')" = provisioner ] ||
    fail "$ns is not labelled as the provisioner's"
  [ "$(kubectl get ns "$ns" -o jsonpath='{.metadata.labels.pod-security\.kubernetes\.io/enforce}')" = restricted ] ||
    fail "$ns does not enforce restricted Pod Security"
  python3 scripts/audit-pods.py "$ns" | tail -1
done
msg=$(kubectl -n mcp-thinking run rootpod --image=busybox --restart=Never -- sleep 1 2>&1 || true)
grep -q 'violates PodSecurity "restricted' <<<"$msg" || fail "a root pod was admitted in mcp-thinking: $msg"
echo "ok: mcp-thinking refuses a pod with no securityContext"

step "Both servers' tools are served by the one gateway endpoint"
for _ in $(seq 1 30); do
  names=$(tool_names)
  grep -q "thinking__sequentialthinking" <<<"$names" && grep -q "woo-http__list_orders" <<<"$names" && break
  sleep 2 # the health loop picks up new servers within its interval
done
grep -q "thinking__sequentialthinking" <<<"$names" || fail "thinking__sequentialthinking is not in tools/list"
grep -q "woo-http__list_orders" <<<"$names" || fail "woo-http__list_orders is not in tools/list"
echo "ok: thinking__sequentialthinking and woo-http__* listed"
code=$(api "/servers/$(hosted_field thinking serverId)" -o /dev/null -w '%{http_code}' -X PATCH -d '{"name":"x"}')
[ "$code" = 409 ] || fail "editing a hosted server's managed row answered HTTP $code"
echo "ok: its mcp_servers row is managed: the servers API refuses to edit it (409)"

step "A stdio tool call: held for approval, then answered by the bridged process"
ARGS='{"thought":"Verify the hosted bridge","thoughtNumber":1,"totalThoughts":1,"nextThoughtNeeded":false}'
first=$(call thinking__sequentialthinking "$ARGS")
python3 -c '
import json, sys
r = json.loads(sys.argv[1])["result"]
t = r["content"][0]["text"]
assert r.get("isError") and "approv" in t, "not held: " + t[:150]
print("ok: held:", t[:90])' "$first" || fail "the call was not held for approval"
curl -sf -c "$JAR" -X POST -H "Origin: $DASH" -H "Content-Type: application/json" \
  -d "{\"email\":\"$(secret gateway-bootstrap-admin email)\",\"password\":\"$(secret gateway-bootstrap-admin password)\"}" \
  "$GW/api/auth/login" >/dev/null || fail "could not log in as the admin to approve"
REQ_ID=$(curl -sf -b "$JAR" -H "Origin: $DASH" "$GW/api/approvals" | python3 -c '
import json, sys
print([r for r in json.load(sys.stdin) if r["name"] == "thinking__sequentialthinking"][0]["id"])') ||
  fail "no pending approval for thinking__sequentialthinking"
curl -sf -b "$JAR" -H "Origin: $DASH" -X POST "$GW/api/approvals/$REQ_ID/approve" >/dev/null ||
  fail "approving $REQ_ID failed"
second=$(call thinking__sequentialthinking "$ARGS")
python3 -c '
import json, sys
r = json.loads(sys.argv[1])["result"]
t = r["content"][0]["text"]
assert not r.get("isError"), "failed after approval: " + t[:200]
assert json.loads(t)["thoughtNumber"] == 1, t[:200]
print("ok: answered by the server:", t.replace("\n", " ")[:90])' "$second" || fail "the approved call failed"

step "An HTTP tool call: the gateway authenticates with the generated token; the image has no route to the store"
out=$(call woo-http__list_products '{}')
python3 -c '
import json, sys
r = json.loads(sys.argv[1])["result"]
t = r["content"][0]["text"]
assert "401" not in t and "nauthorized" not in t, "the gateway was not let in: " + t[:200]
assert r.get("isError") and "WooCommerce" in t, "expected the server to report it cannot reach WooCommerce: " + t[:200]
print("ok: the server ran the tool and reported:", t[:90])' "$out" || fail "woo-http__list_products"

step "Network: who can reach the hosted servers, and what they can reach"
gw_labels="app.kubernetes.io/instance=$RELEASE-gateway,app.kubernetes.io/component=gateway,urumi.ai/mcp-client=true"
out=$(run_probe probe-hosted-gw "$gw_labels" "sleep 4
for t in server.mcp-thinking.svc.cluster.local:8080 server.mcp-woo-http.svc.cluster.local:3000; do
  code=\$(curl -s -o /dev/null -w '%{http_code}' --max-time 4 -X POST -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -d '{}' http://\$t/mcp)
  echo \"\$t=\$code\"
done")
echo "$out" | sed 's/^/  /'
grep -q 'mcp-thinking.svc.cluster.local:8080=401' <<<"$out" || fail "the bridge did not answer 401 without its token"
grep -q 'mcp-woo-http.svc.cluster.local:3000=401' <<<"$out" || fail "the HTTP server did not answer 401 without its token"
echo "ok: the gateway's pods reach both servers, and both refuse a request without the token"
out=$(run_probe probe-hosted-other "app.kubernetes.io/component=probe" "sleep 4
curl -sv --max-time 4 telnet://server.mcp-thinking.svc.cluster.local:8080 </dev/null 2>&1 | grep -q 'Connected to' && echo open || echo blocked")
[ "$out" = blocked ] || fail "a pod in $NS without the mcp-client label reached mcp-thinking"
echo "ok: other pods in $NS can't reach a hosted server"

# A hostname, not an IP: some networks drop 1.1.1.1 outright.
targets="internet=example.com:443
metadata=169.254.169.254:80
k8s-api=kubernetes.default.svc:443
postgres=$RELEASE-gateway-postgres.$NS.svc.cluster.local:5432
store-mysql=$RELEASE-store-mysql.$NS.svc.cluster.local:3306
store-wordpress=$RELEASE-store-wordpress.$NS.svc.cluster.local:80
store-mcp=$RELEASE-store-woocommerce-mcp.$NS.svc.cluster.local:3000
gateway=$RELEASE-gateway.$NS.svc.cluster.local:3000
other-hosted=server.mcp-OTHER.svc.cluster.local:PORT"
check_reach() { # slug other-slug other-port expected-open...
  local slug="$1" other="$2" port="$3"; shift 3
  local script out
  script="sleep 4
$(sed "s/OTHER/$other/; s/PORT/$port/" <<<"$targets" | while IFS== read -r name addr; do
    echo "( curl -sv --max-time 4 telnet://$addr </dev/null 2>&1 | grep -q 'Connected to' && echo '$name=open' || echo '$name=blocked' ) &"
  done)
wait"
  out=$(run_probe "probe-$slug" "app.kubernetes.io/component=hosted-mcp" "$script" "mcp-$slug" | sort)
  while IFS== read -r name state; do
    want=blocked
    for o in "$@"; do [ "$o" = "$name" ] && want=open; done
    [ "$state" = "$want" ] || fail "mcp-$slug -> $name is $state (expected $want)"
  done <<<"$out"
  echo "ok: $slug (egress $(hosted_field "$slug" egress)) reaches only: ${*:-nothing} (checked: $(cut -d= -f1 <<<"$out" | tr '\n' ' '))"
}
check_reach thinking woo-http 3000
check_reach woo-http thinking 8080 internet

step "A server that can't start says why"
code=$(api /hosted -o /dev/null -w '%{http_code}' -X POST -d '{"slug":"broken","name":"Broken","image":"mcp/sequentialthinking:does-not-exist","transport":"stdio","command":["node","dist/index.js"],"libc":"musl"}')
[ "$code" = 201 ] || fail "creating broken: HTTP $code"
reason=""
for _ in $(seq 1 40); do
  reason=$(hosted_field broken reason)
  grep -qE 'ErrImagePull|ImagePullBackOff' <<<"$reason" && break
  sleep 3
done
grep -qE 'ErrImagePull|ImagePullBackOff' <<<"$reason" || fail "no image pull reason reported: '$reason'"
echo "ok: ${reason:0:110}…"
delete_hosted broken

step "Delete woo-http: its tools go, then its namespace, Secrets and credential"
WOO_ID=$(hosted_field woo-http id)
delete_hosted woo-http
kubectl -n urumi-upstreams get secret "hosted-env-$WOO_ID" >/dev/null 2>&1 && fail "hosted-env-$WOO_ID is left"
kubectl -n urumi-upstreams get secret "mcp-upstream-$WOO_ID" >/dev/null 2>&1 && fail "mcp-upstream-$WOO_ID is left"
[ "$(psql_gw "select count(*) from mcp_servers where slug = 'woo-http'")" = 0 ] || fail "woo-http's server row is left"
names=$(tool_names)
grep -q "woo-http__" <<<"$names" && fail "woo-http tools are still listed"
grep -q "thinking__sequentialthinking" <<<"$names" || fail "thinking's tools went too"
echo "ok: row, namespace, env Secret, credential and tools of woo-http are gone; thinking is untouched"

if [ -n "${KEEP_HOSTED:-}" ]; then
  echo; echo "KEEP_HOSTED set: leaving thinking running."
else
  step "Delete thinking too: the cluster ends as it started"
  delete_hosted thinking
  kubectl get ns | grep -q '^mcp-' && fail "an mcp-* namespace is left"
  echo "ok"
fi

echo; echo "Hosted MCP servers verified."
