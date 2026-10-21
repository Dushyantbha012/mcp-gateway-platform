#!/usr/bin/env bash
# Verification for OAuth on the live k3d cluster, doing what an MCP client
# (Claude Code, MCP Inspector, claude.ai) does, with curl: discover the
# authorization server from a 401 on /mcp, register, authorize with PKCE,
# approve on the dashboard's consent API (as the logged-in user), exchange the
# code, use /mcp with the token, refresh, and revoke. Re-runnable:
#   ./scripts/verify-oauth.sh                # build, deploy, verify
#   SKIP_DEPLOY=1 ./scripts/verify-oauth.sh  # reuse what's already deployed
#
# Registration is rate limited per IP (20 an hour); each run registers 3 clients.
set -euo pipefail
cd "$(dirname "$0")/.."

NS="${NAMESPACE:-urumi}"
RELEASE=platform
CLUSTER=urumi-mcp
GW="http://gateway.local.test"
DASH="http://dashboard.local.test"
# Nothing listens here: the script reads the code off the redirect instead.
REDIRECT="http://127.0.0.1:43219/callback"

step() { echo; echo "== $* =="; }
fail() { echo "FAILED: $*"; exit 1; }
secret() { kubectl -n "$NS" get secret "$1" -o jsonpath="{.data.$2}" | base64 -d; }
jsonget() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)"; }
# A query parameter of a URL ("" when absent).
qparam() { python3 -c 'import sys, urllib.parse as u; print(u.parse_qs(u.urlsplit(sys.argv[1]).query).get(sys.argv[2], [""])[0])' "$1" "$2"; }
psql_gw() { kubectl -n "$NS" exec "$RELEASE-gateway-postgres-0" -- sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -Atc \"$1\""; }
JAR=$(mktemp)
HDRS=$(mktemp)
trap 'rm -f "$JAR" "$HDRS"' EXIT

if [ -z "${SKIP_DEPLOY:-}" ]; then
  step "Build the gateway and dashboard; import; deploy"
  for app in gateway dashboard; do
    docker build -q -f "$app/Dockerfile" -t "mcp-gateway/$app:dev" . >/dev/null
    k3d image import "mcp-gateway/$app:dev" -c "$CLUSTER" >/dev/null
  done
  helm upgrade --install "$RELEASE" helm -n "$NS" -f helm/values-local.yaml --wait --timeout 15m >/dev/null
  kubectl -n "$NS" rollout restart "deployment/$RELEASE-gateway" "deployment/$RELEASE-dashboard" >/dev/null
fi
for d in gateway dashboard; do
  kubectl -n "$NS" rollout status "deployment/$RELEASE-$d" --timeout=300s >/dev/null
done

ADMIN_EMAIL=$(secret gateway-bootstrap-admin email)
# Session calls come from the dashboard's origin, like the browser's do.
dash() { curl -s -b "$JAR" -H "Origin: $DASH" -H "Content-Type: application/json" "$GW/api$1" "${@:2}"; }
token() { curl -s -X POST "$GW/oauth/token" -H "Content-Type: application/x-www-form-urlencoded" "$@"; }
mcp() { # token body
  curl -s -X POST "$GW/mcp" -H "Authorization: Bearer $1" \
    -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -d "$2"
}
mcp_status() { # token
  curl -s -o /dev/null -w '%{http_code}' -X POST "$GW/mcp" -H "Authorization: Bearer $1" \
    -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
    -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
}
tool_names() { mcp "$1" '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | jsonget '" ".join(t["name"] for t in d["result"]["tools"])'; }
pkce() { # prints "verifier challenge"
  python3 -c '
import base64, hashlib, secrets
v = secrets.token_urlsafe(48)
c = base64.urlsafe_b64encode(hashlib.sha256(v.encode()).digest()).rstrip(b"=").decode()
print(v, c)'
}
location() { # url: GET it, print the Location it redirects to
  curl -s -o /dev/null -D "$HDRS" "$1"
  tr -d '\r' <"$HDRS" | sed -n 's/^[Ll]ocation: //p'
}
register() { # name
  curl -s -X POST "$GW/oauth/register" -H "Content-Type: application/json" \
    -d "{\"client_name\":\"$1\",\"redirect_uris\":[\"$REDIRECT\"]}" | jsonget 'd["client_id"]'
}
# Runs the browser part of the flow for CLIENT: authorize, approve SCOPES on the
# consent API; prints "code verifier".
grant() { # client scopes-json
  local verifier challenge loc req back code state
  read -r verifier challenge <<<"$(pkce)"
  state="st-$RANDOM"
  loc=$(location "$GW/oauth/authorize?response_type=code&client_id=$1&redirect_uri=$(python3 -c 'import sys,urllib.parse as u;print(u.quote(sys.argv[1],safe=""))' "$REDIRECT")&code_challenge=$challenge&code_challenge_method=S256&scope=mcp:read%20mcp:write&state=$state&resource=$GW/mcp")
  req=$(qparam "$loc" req)
  [ -n "$req" ] || fail "authorize did not send the browser to the consent page: $loc"
  back=$(dash "/oauth/requests/$req" -X POST -d "{\"approve\":true,\"scopes\":$2}" | jsonget 'd["redirectUrl"]')
  [ "$(qparam "$back" state)" = "$state" ] || fail "state did not come back: $back"
  [ "$(qparam "$back" iss)" = "$GW" ] || fail "iss is not the issuer: $back"
  code=$(qparam "$back" code)
  [ -n "$code" ] || fail "no code in $back"
  echo "$code $verifier"
}
exchange() { # client code verifier
  token -d grant_type=authorization_code -d "client_id=$1" -d "code=$2" -d "code_verifier=$3" \
    --data-urlencode "redirect_uri=$REDIRECT" --data-urlencode "resource=$GW/mcp"
}

step "Discovery: a 401 on /mcp points at the metadata, which points at the authorization server"
curl -s -o /dev/null -D "$HDRS" -X POST "$GW/mcp" -H "Content-Type: application/json" -d '{}'
www=$(tr -d '\r' <"$HDRS" | sed -n 's/^[Ww][Ww][Ww]-[Aa]uthenticate: //p')
grep -q "resource_metadata=\"$GW/.well-known/oauth-protected-resource/mcp\"" <<<"$www" ||
  fail "401 without resource_metadata: '$www'"
echo "ok: WWW-Authenticate: $www"
prm=$(curl -sf "$GW/.well-known/oauth-protected-resource/mcp") || fail "no protected-resource metadata"
[ "$(jsonget 'd["resource"]' <<<"$prm")" = "$GW/mcp" ] || fail "resource is not $GW/mcp: $prm"
AS=$(jsonget 'd["authorization_servers"][0]' <<<"$prm")
asm=$(curl -sf "$AS/.well-known/oauth-authorization-server") || fail "no authorization-server metadata at $AS"
python3 -c '
import json, sys
d = json.loads(sys.argv[1])
assert d["issuer"] == sys.argv[2], d["issuer"]
assert d["code_challenge_methods_supported"] == ["S256"], d
assert d["token_endpoint_auth_methods_supported"] == ["none"], d
assert {"mcp:read", "mcp:write"} <= set(d["scopes_supported"]), d
print("ok: issuer", d["issuer"], "- S256 only, public clients, scopes", " ".join(d["scopes_supported"]))' "$asm" "$GW" ||
  fail "authorization-server metadata"
acao=$(curl -s -o /dev/null -D - -X OPTIONS "$GW/oauth/token" -H "Origin: http://localhost:6274" \
  -H "Access-Control-Request-Method: POST" | tr -d '\r' | sed -n 's/^[Aa]ccess-[Cc]ontrol-[Aa]llow-[Oo]rigin: //p')
[ "$acao" = "*" ] || fail "no CORS on /oauth/token (browser clients like MCP Inspector need it): '$acao'"
echo "ok: CORS preflight on /oauth/token allowed for any origin"

step "Registration: loopback and https redirects only"
out=$(curl -s -X POST "$GW/oauth/register" -H "Content-Type: application/json" \
  -d '{"client_name":"Evil","redirect_uris":["http://evil.test/cb"]}')
[ "$(jsonget 'd["error"]' <<<"$out")" = invalid_redirect_uri ] || fail "http://evil.test was accepted: $out"
echo "ok: http://evil.test/cb refused"
CLIENT=$(register "verify-oauth read")
CLIENT_RW=$(register "verify-oauth read+write")
echo "ok: registered $CLIENT and $CLIENT_RW"

step "Authorize: bad requests go back to the client; unknown clients don't redirect anywhere"
code=$(curl -s -o /dev/null -w '%{http_code}' "$GW/oauth/authorize?response_type=code&client_id=mgc_unknownunknownunknown&redirect_uri=http://evil.test/cb")
[ "$code" = 400 ] || fail "unknown client got HTTP $code"
loc=$(location "$GW/oauth/authorize?response_type=code&client_id=$CLIENT&redirect_uri=$REDIRECT&state=s1")
[ "$(qparam "$loc" error)" = invalid_request ] || fail "no PKCE was not refused: $loc"
loc=$(location "$GW/oauth/authorize?response_type=code&client_id=$CLIENT&redirect_uri=$REDIRECT&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&code_challenge_method=S256&resource=https://other.test/mcp")
[ "$(qparam "$loc" error)" = invalid_target ] || fail "another resource was not refused: $loc"
loc=$(location "$GW/oauth/authorize?response_type=code&client_id=$CLIENT&redirect_uri=$REDIRECT&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&code_challenge_method=S256")
case "$loc" in "$DASH/oauth/consent?req="*) ;; *) fail "a good request was not sent to the consent page: $loc" ;; esac
echo "ok: unknown client 400; no PKCE and other resource sent back with an error; a good request goes to $DASH/oauth/consent"
REQ=$(qparam "$loc" req)
code=$(curl -s -o /dev/null -w '%{http_code}' -H "Origin: $DASH" "$GW/api/oauth/requests/$REQ")
[ "$code" = 401 ] || fail "the consent API answered HTTP $code without a session"
curl -sf -c "$JAR" -X POST -H "Origin: $DASH" -H "Content-Type: application/json" \
  -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$(secret gateway-bootstrap-admin password)\"}" \
  "$GW/api/auth/login" >/dev/null || fail "could not log in as the admin"
name=$(dash "/oauth/requests/$REQ" | jsonget 'd["clientName"]')
[ "$name" = "verify-oauth read" ] || fail "the consent page would show '$name'"
echo "ok: the consent API needs a session, and shows the logged-in user which app is asking"

step "Token: PKCE is checked, and a code works once"
G=$(grant "$CLIENT" '["mcp:read"]'); read -r CODE VERIFIER <<<"$G"
out=$(exchange "$CLIENT" "$CODE" "wrong-verifier-wrong-verifier-wrong-verifier-123")
[ "$(jsonget 'd["error"]' <<<"$out")" = invalid_grant ] || fail "a wrong verifier was accepted: $out"
out=$(exchange "$CLIENT" "$CODE" "$VERIFIER")
[ "$(jsonget 'd["error"]' <<<"$out")" = invalid_grant ] || fail "the code was usable after a failed attempt: $out"
echo "ok: a wrong verifier is refused, and burns the code"
G=$(grant "$CLIENT" '["mcp:read"]'); read -r CODE VERIFIER <<<"$G"
TOKENS=$(exchange "$CLIENT" "$CODE" "$VERIFIER")
ACCESS=$(jsonget 'd["access_token"]' <<<"$TOKENS")
REFRESH=$(jsonget 'd["refresh_token"]' <<<"$TOKENS")
[ "$(jsonget 'd["scope"]' <<<"$TOKENS")" = "mcp:read" ] || fail "scope is not mcp:read: $TOKENS"
[ "$(jsonget 'd["token_type"]' <<<"$TOKENS")" = Bearer ] || fail "token_type: $TOKENS"
echo "ok: ${ACCESS:0:8}… (expires in $(jsonget 'd["expires_in"]' <<<"$TOKENS")s) and a refresh token, scope mcp:read"
out=$(exchange "$CLIENT" "$CODE" "$VERIFIER")
[ "$(jsonget 'd["error"]' <<<"$out")" = invalid_grant ] || fail "the code was redeemed twice: $out"
[ "$(mcp_status "$ACCESS")" = 401 ] || fail "the replayed code did not revoke what it issued"
echo "ok: replaying the code is refused and revokes the tokens it issued"
G=$(grant "$CLIENT" '["mcp:read"]'); read -r CODE VERIFIER <<<"$G"
TOKENS=$(exchange "$CLIENT" "$CODE" "$VERIFIER")
ACCESS=$(jsonget 'd["access_token"]' <<<"$TOKENS")
REFRESH=$(jsonget 'd["refresh_token"]' <<<"$TOKENS")

step "/mcp with a read-only token: write tools hidden and refused, even for an admin"
names=$(tool_names "$ACCESS")
grep -q "woocommerce__list_products" <<<"$names" || fail "list_products is not listed: $names"
grep -q "woocommerce__create_product" <<<"$names" && fail "create_product is listed for mcp:read"
echo "ok: listed: $names"
out=$(mcp "$ACCESS" '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"woocommerce__create_product","arguments":{"name":"verify-oauth"}}}')
python3 -c '
import json, sys
r = json.loads(sys.argv[1])
t = json.dumps(r)
assert "mcp:read" in t and "read access" in t, t[:300]
print("ok: create_product refused:", (r.get("result") or r.get("error"))["content"][0]["text"][:100] if "result" in r else r["error"]["message"][:100])' "$out" ||
  fail "create_product was not refused for mcp:read"
out=$(mcp "$ACCESS" '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"woocommerce__list_products","arguments":{}}}')
[ "$(jsonget 'd["result"].get("isError", False)' <<<"$out")" = False ] || fail "list_products failed: ${out:0:300}"
echo "ok: list_products answered"
[ "$(psql_gw "select count(*) from audit_log where tool_name = 'woocommerce__create_product' and outcome = 'denied' and api_key_id is null and ts > now() - interval '5 minutes'")" -ge 1 ] ||
  fail "the refused call is not in the audit log"
echo "ok: the refusal is audited (as the user, with no API key)"

step "/mcp with a read+write grant: write tools listed"
G=$(grant "$CLIENT_RW" '["mcp:read","mcp:write"]'); read -r CODE VERIFIER <<<"$G"
RW=$(exchange "$CLIENT_RW" "$CODE" "$VERIFIER")
[ "$(jsonget 'd["scope"]' <<<"$RW")" = "mcp:read mcp:write" ] || fail "scope: $RW"
grep -q "woocommerce__create_product" <<<"$(tool_names "$(jsonget 'd["access_token"]' <<<"$RW")")" ||
  fail "create_product is not listed for mcp:write"
echo "ok: create_product listed"
out=$(token -d grant_type=refresh_token -d "client_id=$CLIENT_RW" -d "refresh_token=$(jsonget 'd["refresh_token"]' <<<"$RW")" -d "scope=mcp:read")
[ "$(jsonget 'd["scope"]' <<<"$out")" = "mcp:read" ] || fail "a refresh could not narrow the scope: $out"
echo "ok: a refresh can narrow to mcp:read"

step "Refresh: tokens rotate, and reusing an old refresh token ends the grant"
out=$(token -d grant_type=refresh_token -d "client_id=$CLIENT_RW" -d "refresh_token=$REFRESH")
[ "$(jsonget 'd["error"]' <<<"$out")" = invalid_grant ] || fail "another client's refresh token was accepted: $out"
NEW=$(token -d grant_type=refresh_token -d "client_id=$CLIENT" -d "refresh_token=$REFRESH")
ACCESS2=$(jsonget 'd["access_token"]' <<<"$NEW")
REFRESH2=$(jsonget 'd["refresh_token"]' <<<"$NEW")
[ "$REFRESH2" != "$REFRESH" ] || fail "the refresh token did not rotate"
[ "$(mcp_status "$ACCESS2")" = 200 ] || fail "the refreshed access token does not work"
echo "ok: refreshed (bound to its client); the new access token works"
out=$(token -d grant_type=refresh_token -d "client_id=$CLIENT" -d "refresh_token=$REFRESH")
[ "$(jsonget 'd["error"]' <<<"$out")" = invalid_grant ] || fail "the old refresh token worked again: $out"
[ "$(mcp_status "$ACCESS2")" = 401 ] || fail "reuse did not revoke the new access token"
out=$(token -d grant_type=refresh_token -d "client_id=$CLIENT" -d "refresh_token=$REFRESH2")
[ "$(jsonget 'd["error"]' <<<"$out")" = invalid_grant ] || fail "reuse did not revoke the new refresh token: $out"
echo "ok: reusing the old refresh token revoked the whole grant (new access and refresh tokens too)"

step "Revoke (RFC 7009), and what a client sees afterwards"
G=$(grant "$CLIENT" '["mcp:read"]'); read -r CODE VERIFIER <<<"$G"
T=$(exchange "$CLIENT" "$CODE" "$VERIFIER")
A=$(jsonget 'd["access_token"]' <<<"$T")
[ "$(mcp_status "$A")" = 200 ] || fail "fresh token does not work"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$GW/oauth/revoke" -d "token=$(jsonget 'd["refresh_token"]' <<<"$T")")
[ "$code" = 200 ] || fail "revoke answered HTTP $code"
curl -s -o /dev/null -D "$HDRS" -X POST "$GW/mcp" -H "Authorization: Bearer $A" -H "Content-Type: application/json" -d '{}'
grep -qi '^www-authenticate: .*error="invalid_token"' "$HDRS" || fail "no invalid_token after revoke: $(cat "$HDRS")"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$GW/oauth/revoke" -d "token=mgo_not_a_real_token_at_all")
[ "$code" = 200 ] || fail "revoking an unknown token answered HTTP $code"
echo "ok: revoking the refresh token ended its access token (401, error=\"invalid_token\"); unknown tokens also get 200"

step "Connected apps: the user sees their grants and can disconnect one"
G=$(grant "$CLIENT" '["mcp:read"]'); read -r CODE VERIFIER <<<"$G"
A=$(exchange "$CLIENT" "$CODE" "$VERIFIER" | jsonget 'd["access_token"]')
apps=$(dash /oauth/apps)
APP_ID=$(python3 -c '
import json, sys
apps = [a for a in json.loads(sys.argv[1]) if a["clientId"] == sys.argv[2]]
assert apps and all(a["scopes"] == ["mcp:read"] for a in apps), apps
print(apps[0]["id"])' "$apps" "$CLIENT") || fail "the grant is not listed: $apps"
echo "ok: listed, as mcp:read"
# This run's grants, and any an interrupted run left behind.
for a in $(python3 -c 'import json,sys; print(" ".join(a["id"] for a in json.loads(sys.argv[1]) if a["clientName"].startswith("verify-oauth")))' "$apps"); do
  code=$(dash "/oauth/apps/$a" -o /dev/null -w '%{http_code}' -X DELETE)
  [ "$code" = 204 ] || fail "disconnecting $a answered HTTP $code"
done
[ "$(mcp_status "$A")" = 401 ] || fail "the disconnected app's token still works"
dash /oauth/apps | grep -q "$CLIENT" && fail "the disconnected app is still listed"
[ "$(psql_gw "select count(*) from audit_log where tool_name in ('oauth.approve','oauth.revoke') and ts > now() - interval '5 minutes'")" -ge 2 ] ||
  fail "approvals and disconnects are not audited"
dash /oauth/apps | grep -q verify-oauth && fail "verify-oauth apps are still connected"
echo "ok: disconnecting $APP_ID (and the other verify-oauth grants) cut access at once, and it's audited"

echo; echo "OAuth verified."
