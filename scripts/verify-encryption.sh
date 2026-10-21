#!/usr/bin/env bash
# Proves Kubernetes Secrets are encrypted at rest in the k3s datastore.
#
#   CLUSTER=urumi-mcp ./scripts/verify-encryption.sh
#
# 1. k3s reports secrets encryption Enabled.
# 2. A Secret with a random marker reads back as plaintext through the API but
#    is stored as ciphertext (k8s:enc:aescbc:...) with no marker in the bytes.
# 3. Every Secret currently in the datastore carries the encryption prefix
#    (values are never printed; only names and counts).
#
# k3s keeps its state in SQLite (kine), so the check copies the database out of
# the server container and reads it on the host with python3.
set -euo pipefail

CLUSTER="${CLUSTER:-urumi-mcp}"
NODE="k3d-${CLUSTER}-server-0"
CTX="k3d-${CLUSTER}"
K="kubectl --context ${CTX}"
NS=default
NAME="enc-check-$$"
MARKER="plaintext-marker-$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"
WORK="$(mktemp -d)"
FAILED=0

cleanup() {
  $K -n "$NS" delete secret "$NAME" --ignore-not-found >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

pass() { echo "  ok    $*"; }
fail() { echo "  FAIL  $*"; FAILED=1; }

echo "== 1. k3s secrets encryption status ($CLUSTER)"
status="$(docker exec "$NODE" k3s secrets-encrypt status 2>&1 | grep -v 'level=' || true)"
if grep -q 'Encryption Status: Enabled' <<<"$status"; then
  pass "Encryption Status: Enabled"
else
  fail "encryption is not enabled: $(head -1 <<<"$status")"
  echo "     Create the cluster with: --k3s-arg \"--secrets-encryption@server:*\""
  exit 1
fi

echo "== 2. A new Secret is ciphertext in the datastore"
$K -n "$NS" create secret generic "$NAME" --from-literal=credential="$MARKER" >/dev/null
api_value="$($K -n "$NS" get secret "$NAME" -o jsonpath='{.data.credential}' | base64 -d)"
[ "$api_value" = "$MARKER" ] && pass "the API returns the plaintext to an authorised caller" \
  || fail "the API did not return the stored value"

# docker cp the live database (and its WAL) so SQLite sees a consistent copy.
mkdir -p "$WORK/db"
docker cp "$NODE:/var/lib/rancher/k3s/server/db/." "$WORK/db" >/dev/null

result="$(DB="$WORK/db/state.db" NAME="$NAME" MARKER="$MARKER" NS="$NS" python3 -I - <<'PY'
import os, sqlite3
con = sqlite3.connect("file:%s?mode=ro" % os.environ["DB"], uri=True)
rows = con.execute(
    "select name, value from kine where name like '/registry/secrets/%' "
    "and deleted = 0 and id in (select max(id) from kine group by name)"
).fetchall()
mine = "/registry/secrets/%s/%s" % (os.environ["NS"], os.environ["NAME"])
marker = os.environ["MARKER"].encode()
target = [v for n, v in rows if n == mine]
print("found=%d" % len(target))
print("encrypted=%d" % (1 if target and target[0].startswith(b"k8s:enc:aescbc:") else 0))
print("leak=%d" % (1 if target and marker in target[0] else 0))
bad = [n for n, v in rows if not v.startswith(b"k8s:enc:")]
print("total=%d" % len(rows))
print("plain=%d" % len(bad))
for n in bad[:20]:
    print("plain_name=%s" % n)
PY
)"
get() { sed -n "s/^$1=//p" <<<"$result" | head -1; }

[ "$(get found)" = "1" ] && pass "the Secret is in the datastore" || fail "the Secret was not found in the datastore"
[ "$(get encrypted)" = "1" ] && pass "stored with the k8s:enc:aescbc prefix" || fail "stored value is not ciphertext"
[ "$(get leak)" = "0" ] && pass "the marker does not appear in the stored bytes" || fail "the marker is readable in the datastore"

echo "== 3. Every Secret in the datastore is encrypted"
echo "     $(get total) Secrets checked"
if [ "$(get plain)" = "0" ]; then
  pass "none stored as plaintext"
else
  fail "$(get plain) Secret(s) stored as plaintext (written before encryption was on?)"
  sed -n 's/^plain_name=/       /p' <<<"$result"
  echo "     Fix: docker exec $NODE k3s secrets-encrypt reencrypt"
fi

echo
if [ "$FAILED" = 0 ]; then echo "verify-encryption: all checks passed"; else echo "verify-encryption: FAILED"; exit 1; fi
