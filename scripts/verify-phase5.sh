#!/usr/bin/env bash
# Verification for Phase 5 (chat agent), against the live k3d cluster and the
# real chat model (Groq by default, else Gemini). Re-runnable:
#   ./scripts/verify-phase5.sh                # tests, build, deploy, verify
#   SKIP_DEPLOY=1 ./scripts/verify-phase5.sh  # reuse what's already deployed
#   SKIP_TESTS=1 ...                          # skip the repo test suites (cluster checks only)
#   SKIP_REGRESSION=1 ...                     # skip re-running the Phase 2-4 scripts
#
# The checks run against the gateway's default provider: Groq when the
# gateway-groq Secret exists (unless CHAT_PROVIDER=gemini), otherwise Gemini.
# Keys are read from $GROQ_API_KEY / $GEMINI_API_KEY, ~/.config/urumi/{groq,gemini}.env,
# or (with SKIP_DEPLOY) from the cluster's gateway-groq / gateway-gemini Secret.
# The live checks cost about ten model requests.
#
# Not automated here: placing the storefront order by hand (the brief's DoD
# step). Phase 6's Playwright storefront automation covers it; until then do
# it in the browser and ask the chat "what orders came in today?".
set -euo pipefail
cd "$(dirname "$0")/.."

NS="${NAMESPACE:-urumi}"
RELEASE=platform
CLUSTER=urumi-mcp
DASH="http://dashboard.local.test"
GW="http://gateway.local.test"
STORE="http://store.local.test"
GATEWAY_DEPLOY="$RELEASE-gateway"
TEST_DB=postgres://gateway_test:gateway_test@localhost:5433/gateway_test
JAR_ADMIN=$(mktemp) JAR_MEMBER=$(mktemp) OUT=$(mktemp)
SAVED_KEY=""

step() { echo; echo "== $* =="; }
fail() { echo "FAILED: $*"; exit 1; }
secret() { kubectl -n "$NS" get secret "$1" -o jsonpath="{.data.$2}" | base64 -d; }
jsonget() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)"; }
login_body() { printf '{"email":"%s","password":"%s"}' "$1" "$2"; }

# The Secret, env var and name of the provider the gateway uses by default.
CHAT_SECRET=gateway-gemini CHAT_ENV=GEMINI_API_KEY CHAT_NAME=Gemini
pick_chat_provider() {
  local want
  want=$(kubectl -n "$NS" get deploy "$GATEWAY_DEPLOY" \
    -o jsonpath='{.spec.template.spec.containers[0].env[?(@.name=="CHAT_PROVIDER")].value}' 2>/dev/null || true)
  if [ "$want" != "gemini" ] && kubectl -n "$NS" get secret gateway-groq >/dev/null 2>&1; then
    CHAT_SECRET=gateway-groq CHAT_ENV=GROQ_API_KEY CHAT_NAME=Groq
  fi
}
set_gemini_secret() { # value on stdin; never an argument (the default provider's Secret)
  kubectl -n "$NS" create secret generic "$CHAT_SECRET" --from-file=api-key=/dev/stdin \
    --dry-run=client -o yaml | kubectl -n "$NS" apply -f - >/dev/null
}
# `rollout status` straight after `rollout restart` can return before the
# controller has noticed the change, while the old pod (with the old Secret
# value) is still the one answering. Wait until it has, then for the rollout.
wait_gateway() {
  local want
  want=$(kubectl -n "$NS" get deploy "$GATEWAY_DEPLOY" -o jsonpath='{.metadata.generation}')
  until [ "$(kubectl -n "$NS" get deploy "$GATEWAY_DEPLOY" -o jsonpath='{.status.observedGeneration}')" -ge "$want" ]; do
    sleep 1
  done
  kubectl -n "$NS" rollout status "deployment/$GATEWAY_DEPLOY" --timeout=300s >/dev/null
  # The old pod keeps answering through its preStop sleep, so also wait for it
  # to be gone: otherwise the next request can still hit the old Secret value.
  while kubectl -n "$NS" get pods --no-headers | grep "^$GATEWAY_DEPLOY-" | grep -q Terminating; do
    sleep 1
  done
}

cleanup() {
  # A check that aborts between "disable WooCommerce" and "re-enable" must not
  # leave it disabled for whatever runs next (the chat would then have no store tools).
  if [ -n "${WOO_ID:-}" ]; then
    curl -s -o /dev/null -X PATCH -b "$JAR_ADMIN" -H "Origin: $DASH" -H "Content-Type: application/json" \
      -d '{"enabled":true}' "$DASH/api/servers/$WOO_ID" || true
  fi
  rm -f "$JAR_ADMIN" "$JAR_MEMBER" "$OUT"
  # Always put the real key back if a check swapped it out.
  if [ -n "$SAVED_KEY" ]; then
    printf '%s' "$SAVED_KEY" | set_gemini_secret
    kubectl -n "$NS" rollout restart "deployment/$GATEWAY_DEPLOY" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

for f in groq gemini; do
  if [ -f "$HOME/.config/urumi/$f.env" ]; then set -a; . "$HOME/.config/urumi/$f.env"; set +a; fi
done

if [ -z "${SKIP_TESTS:-}" ]; then
  step "Lint, format, unit + integration tests (real Postgres), build"
  docker compose -f docker-compose.test.yml up -d --wait >/dev/null
  npm run lint
  npm run format:check
  TEST_DATABASE_URL="$TEST_DB" npm test
  npm run build

  step "Browser E2E (Playwright), including the chat agent with a fake model"
  TEST_DATABASE_URL="$TEST_DB" npm run test:e2e
fi

step "Helm chart lints and renders for both environments"
helm lint helm -f helm/values-local.yaml
helm lint helm -f helm/values-prod.yaml
helm template "$RELEASE" helm -f helm/values-prod.yaml >/dev/null

if [ -z "${SKIP_DEPLOY:-}" ]; then
  [ -n "${GROQ_API_KEY:-}${GEMINI_API_KEY:-}" ] || kubectl -n "$NS" get secret gateway-groq >/dev/null 2>&1 ||
    kubectl -n "$NS" get secret gateway-gemini >/dev/null 2>&1 ||
    fail "no chat key: set GROQ_API_KEY (or GEMINI_API_KEY), or create ~/.config/urumi/groq.env"
  step "Build images, import into k3d, deploy"
  for app in woocommerce-mcp gateway dashboard; do
    docker build -q -f "$app/Dockerfile" -t "mcp-gateway/$app:dev" . >/dev/null
    k3d image import "mcp-gateway/$app:dev" -c "$CLUSTER" >/dev/null
  done
  ./scripts/create-secrets.sh
  helm upgrade --install "$RELEASE" helm -n "$NS" -f helm/values-local.yaml --wait --timeout 15m
  kubectl -n "$NS" rollout restart "deployment/$RELEASE-store-woocommerce-mcp" "deployment/$GATEWAY_DEPLOY" "deployment/$RELEASE-dashboard"
fi

pick_chat_provider
step "All workloads ready; the gateway has chat enabled ($CHAT_NAME)"
for d in "$RELEASE-store-woocommerce-mcp" "$GATEWAY_DEPLOY" "$RELEASE-dashboard"; do
  kubectl -n "$NS" rollout status "deployment/$d" --timeout=300s
done
# Earlier scripts kill pods, so `logs deployment/...` may briefly pick a pod
# that is starting or terminating: retry against fresh logs for up to a minute.
for _ in $(seq 30); do
  kubectl -n "$NS" logs "deployment/$GATEWAY_DEPLOY" --tail=2000 2>/dev/null | grep '"chat agent enabled"' >/dev/null && break
  sleep 2
done
kubectl -n "$NS" logs "deployment/$GATEWAY_DEPLOY" --tail=2000 | grep '"chat agent enabled"' >/dev/null ||
  fail "gateway log doesn't say 'chat agent enabled' (is secret/$CHAT_SECRET present?)"
echo "ok"

ADMIN_EMAIL=$(secret gateway-bootstrap-admin email)
ADMIN_PASSWORD=$(secret gateway-bootstrap-admin password)
ADMIN_KEY=$(secret gateway-bootstrap-admin api-key)
as_admin() { curl -s -b "$JAR_ADMIN" -c "$JAR_ADMIN" -H "Origin: $DASH" -H "Content-Type: application/json" "$DASH/api$1" "${@:2}"; }
as_member() { curl -s -b "$JAR_MEMBER" -c "$JAR_MEMBER" -H "Origin: $DASH" -H "Content-Type: application/json" "$DASH/api$1" "${@:2}"; }
status_of() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
# Extra arguments pass through (--approve: act as the user who approves a held write).
# Groq's free tier allows ~8000 tokens a minute, which a few consecutive turns
# use up: a turn that ends in rate_limited is retried after the window passes.
chat_as() { # jar, message, extra args...
  local tmp try
  tmp=$(mktemp)
  for try in 1 2 3; do
    scripts/chat_stream.py "$DASH/api/chat" "$2" --cookie "$1" --origin "$DASH" "${@:3}" >"$tmp"
    grep -q '"code": *"rate_limited"' "$tmp" || break
    echo "  (rate limited by the model provider; waiting 60s, try $try)" >&2
    sleep 60
  done
  cat "$tmp"
  rm -f "$tmp"
}
chat_admin() { chat_as "$JAR_ADMIN" "$@"; }
chat_member() { chat_as "$JAR_MEMBER" "$@"; }
# Prints the tool names the agent called, one per line, from chat_stream output in $OUT.
called() { python3 -c '
import json,sys
for l in open(sys.argv[1]):
    e=json.loads(l)
    if e.get("type")=="tool_call": print(e["name"])' "$OUT"; }
event_types() { python3 -c '
import json,sys
print(",".join(json.loads(l).get("type","?") for l in open(sys.argv[1])))' "$OUT"; }

step "Admin logs in; /api/meta says chat is enabled"
curl -s -o /dev/null -c "$JAR_ADMIN" -H "Origin: $DASH" -H "Content-Type: application/json" \
  -d "$(login_body "$ADMIN_EMAIL" "$ADMIN_PASSWORD")" "$DASH/api/auth/login"
[ "$(as_admin /meta | jsonget 'd["chatEnabled"]')" = "True" ] || fail "/api/meta chatEnabled"
for _ in $(seq 1 60); do
  [ "$(as_admin /servers | jsonget 'next((s["status"] for s in d if s["slug"] == "woocommerce"), "missing")')" = "connected" ] && break
  sleep 1
done
echo "ok"

step "Access control: no credentials -> 401, cookie without Origin -> 403, bad bodies -> 400"
[ "$(status_of -X POST "$DASH/api/chat" -H 'Content-Type: application/json' -d '{"messages":[{"role":"user","text":"hi"}]}')" = "401" ] || fail "unauthenticated chat"
[ "$(status_of -X POST "$DASH/api/chat" -b "$JAR_ADMIN" -H 'Content-Type: application/json' -d '{"messages":[{"role":"user","text":"hi"}]}')" = "403" ] || fail "cookie without Origin"
[ "$(status_of -X POST "$DASH/api/chat" -b "$JAR_ADMIN" -H "Origin: http://evil.test" -H 'Content-Type: application/json' -d '{"messages":[{"role":"user","text":"hi"}]}')" = "403" ] || fail "foreign Origin"
for body in '{}' '{"messages":[]}' '{"messages":[{"role":"assistant","text":"hi"}]}'; do
  [ "$(status_of -X POST "$DASH/api/chat" -b "$JAR_ADMIN" -H "Origin: $DASH" -H 'Content-Type: application/json' -d "$body")" = "400" ] || fail "bad body accepted: $body"
done
echo "ok"

PRODUCT="Verify5 Mug $(date +%s)"
step "Exit criterion 1: 'create a product named X priced Y' -> it is on the storefront; events are streamed through Traefik"
chat_admin "Create a product named \"$PRODUCT\" priced 7.25" --approve >"$OUT"
echo "events: $(event_types)"
called | grep -qx "woocommerce__create_product" || fail "agent didn't call woocommerce__create_product: $(cat "$OUT")"
python3 - "$OUT" <<'PY' || fail "events were not streamed incrementally"
import json, sys
ev = [json.loads(l) for l in open(sys.argv[1])]
assert ev[-1]["type"] == "done", ev[-1]
# The write was held first: asked about, and not run until the user approved.
# (search_tools runs first in search mode, so look only at the write itself.)
kinds = [e["type"] for e in ev if e.get("name") == "woocommerce__create_product" and e["type"] in ("confirm", "tool_call")]
assert kinds[:2] == ["confirm", "tool_call"], f"write was not held for approval: {kinds}"
call = next(e for e in ev if e["type"] == "tool_call")
done = ev[-1]
# The tool call must reach the client well before the turn finishes: if the
# ingress buffered the stream, every event would arrive together at the end.
gap = done["t"] - call["t"]
print(f"tool_call at {call['t']}s, done at {done['t']}s (gap {gap:.2f}s)")
assert gap > 0.2, "tool_call arrived with the rest: stream is buffered"
res = next(e for e in ev if e["type"] == "tool_result")
assert not res["isError"], res
PY
curl -s "$STORE/wp-json/wc/store/v1/products?search=$(python3 -c 'import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))' "$PRODUCT")" |
  python3 -c "
import json,sys
ps=[p for p in json.load(sys.stdin) if p['name']=='$PRODUCT']
assert ps, 'product not on the storefront'
assert ps[0]['prices']['price']=='725', ps[0]['prices']
print('storefront shows', ps[0]['name'], ps[0]['prices']['price'])" || fail "product not on the storefront"

step "Exit criterion 2 (automated half): 'what orders came in today' -> the agent calls list_orders and answers"
chat_admin "What orders came in today?" >"$OUT"
echo "events: $(event_types)"
called | grep -qx "woocommerce__list_orders" || fail "agent didn't call woocommerce__list_orders"
python3 - "$OUT" <<'PY' || fail "no clean answer"
import json, sys
ev = [json.loads(l) for l in open(sys.argv[1])]
assert not any(e["type"] == "error" for e in ev), ev
assert any(e["type"] == "text" and e["text"].strip() for e in ev), "no answer text"
assert ev[-1]["type"] == "done"
PY
echo "ok (the manual storefront order is checked by hand; see the header)"

step "A member can chat too, and their calls are attributed to them"
MEMBER_EMAIL="verify5-$(date +%s)@example.com"
MEMBER_PASSWORD="member-$(openssl rand -hex 8)"
invite=$(as_admin /users -d "$(printf '{"email":"%s","name":"Verify Five"}' "$MEMBER_EMAIL")")
token=$(jsonget 'd["inviteUrl"].rsplit("/",1)[1]' <<<"$invite")
accepted=$(curl -s -c "$JAR_MEMBER" -H "Origin: $DASH" -H "Content-Type: application/json" \
  -d "$(printf '{"password":"%s"}' "$MEMBER_PASSWORD")" "$DASH/api/auth/invites/$token/accept")
MEMBER_ID=$(jsonget 'd["id"]' <<<"$accepted")
chat_member "List the products in the store." >"$OUT"
called | grep -qx "woocommerce__list_products" || fail "member's agent didn't call list_products: $(cat "$OUT")"
as_admin "/audit?source=chat&limit=100" | MEMBER_EMAIL="$MEMBER_EMAIL" ADMIN_EMAIL="$ADMIN_EMAIL" python3 -c '
import json, os, sys
rows = json.load(sys.stdin)
by = lambda email, tool: [r for r in rows if r["userEmail"] == email and r["tool"] == tool and r["outcome"] == "success"]
assert by(os.environ["MEMBER_EMAIL"], "woocommerce__list_products"), "no audit row for the member"
assert by(os.environ["ADMIN_EMAIL"], "woocommerce__create_product"), "no audit row for the admin"
assert all(r["source"] == "chat" for r in rows)
print("ok: admin and member chat calls are audited under their own names, source=chat")'

step "Disable WooCommerce: its tools vanish from chat on the next message; re-enable brings them back"
WOO_ID=$(as_admin /servers | jsonget 'next(s["id"] for s in d if s["slug"] == "woocommerce")')
as_admin "/servers/$WOO_ID" -X PATCH -d '{"enabled":false}' >/dev/null
# Other upstreams (GitHub, DeepWiki since Phase 6) may still be registered, so
# the agent may use their tools; it must never be able to use WooCommerce's.
[ "$(as_admin /tools | jsonget 'sum(1 for t in d if t["name"].startswith("woocommerce__"))')" = "0" ] ||
  fail "woocommerce tools still offered while disabled"
chat_admin "What orders came in today?" >"$OUT"
called | grep -q "^woocommerce__" && fail "agent called a WooCommerce tool while it was disabled: $(called)"
python3 - "$OUT" <<'PY' || fail "expected a clean answer without WooCommerce, got: $(cat "$OUT")"
import json, sys
ev = [json.loads(l) for l in open(sys.argv[1])]
assert ev[-1]["type"] == "done" and any(e["type"] == "text" for e in ev), ev
PY
echo "disabled: no WooCommerce tools offered or called ($(event_types))"
as_admin "/servers/$WOO_ID" -X PATCH -d '{"enabled":true}' >/dev/null
for _ in $(seq 1 60); do
  [ "$(as_admin /servers | jsonget 'next((s["status"] for s in d if s["slug"] == "woocommerce"), "missing")')" = "connected" ] && break
  sleep 1
done
[ "$(as_admin /tools | jsonget 'sum(1 for t in d if t["name"].startswith("woocommerce__"))')" = "5" ] ||
  fail "woocommerce tools didn't come back after re-enable"
chat_admin "Using the WooCommerce store, what orders came in today?" >"$OUT"
called | grep -q "^woocommerce__" || fail "chat didn't use WooCommerce after re-enable: $(called)"
echo "ok"

step "A rejected $CHAT_NAME key: the turn ends with a clear error, the gateway stays Ready, the rest keeps working"
SAVED_KEY=$(secret "$CHAT_SECRET" api-key)
printf '%s' "not-a-real-key" | set_gemini_secret
kubectl -n "$NS" rollout restart "deployment/$GATEWAY_DEPLOY" >/dev/null
wait_gateway
curl -s -o /dev/null -c "$JAR_ADMIN" -H "Origin: $DASH" -H "Content-Type: application/json" \
  -d "$(login_body "$ADMIN_EMAIL" "$ADMIN_PASSWORD")" "$DASH/api/auth/login"
chat_admin "hello" >"$OUT"
grep -q '"code": *"auth"' "$OUT" || fail "expected an 'auth' error event: $(cat "$OUT")"
grep -q "not-a-real-key" "$OUT" && fail "the bad key was echoed to the browser"
[ "$(status_of "$GW/healthz")" = "200" ] || fail "gateway not healthy with a bad key"
[ "$(kubectl -n "$NS" get deploy "$GATEWAY_DEPLOY" -o jsonpath='{.status.readyReplicas}')" = "1" ] || fail "gateway not Ready"
[ "$(status_of "$GW/api/tools" -H "Authorization: Bearer $ADMIN_KEY")" = "200" ] || fail "tools API broke"
printf '%s' "$SAVED_KEY" | set_gemini_secret
kubectl -n "$NS" rollout restart "deployment/$GATEWAY_DEPLOY" >/dev/null
wait_gateway
SAVED_KEY=""
curl -s -o /dev/null -c "$JAR_ADMIN" -H "Origin: $DASH" -H "Content-Type: application/json" \
  -d "$(login_body "$ADMIN_EMAIL" "$ADMIN_PASSWORD")" "$DASH/api/auth/login"
chat_admin "hello" >"$OUT"
grep -q '"type": *"done"' "$OUT" || fail "chat didn't recover after restoring the key: $(cat "$OUT")"
echo "ok"

step "The $CHAT_NAME key is nowhere it shouldn't be: Helm release, pod spec, logs, API responses"
GEMINI_VALUE=$(secret "$CHAT_SECRET" api-key)
leak=""
helm get all "$RELEASE" -n "$NS" 2>/dev/null | grep -qF "$GEMINI_VALUE" && leak="helm release"
kubectl -n "$NS" get deploy,pod -o yaml | grep -qF "$GEMINI_VALUE" && leak="$leak pod spec"
kubectl -n "$NS" logs "deployment/$GATEWAY_DEPLOY" --tail=1000 | grep -qF "$GEMINI_VALUE" && leak="$leak gateway logs"
{ as_admin /meta; as_admin /tools; as_admin /servers; as_admin "/audit?limit=200"; cat "$OUT"; } | grep -qF "$GEMINI_VALUE" && leak="$leak API responses"
[ -z "$leak" ] || fail "$CHAT_NAME key found in:$leak"
kubectl -n "$NS" get deploy "$GATEWAY_DEPLOY" -o json | python3 -c '
import json,sys
env = json.load(sys.stdin)["spec"]["template"]["spec"]["containers"][0]["env"]
e = next(e for e in env if e["name"] == sys.argv[1])
assert "valueFrom" in e and "value" not in e, e
print("ok: " + sys.argv[1] + " comes from secretKeyRef only")' "$CHAT_ENV"

if [ -z "${SKIP_REGRESSION:-}" ]; then
  step "Regression: Phase 2, 3 and 4 checks against the same deployment"
  for n in 2 3 4; do
    echo "--- verify-phase$n"
    SKIP_DEPLOY=1 SKIP_TESTS=1 ./scripts/verify-phase$n.sh >"$OUT" 2>&1 || { tail -30 "$OUT"; fail "verify-phase$n.sh"; }
    tail -1 "$OUT"
  done
fi

as_admin /auth/logout -X POST >/dev/null
echo
echo "All Phase 5 checks passed."
