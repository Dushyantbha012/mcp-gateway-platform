#!/usr/bin/env bash
# Resets the local stack to a clean demo state - run before recording the demo
# or after the test suites have littered the store and the audit log.
#
#   ./scripts/reset-demo.sh          # asks first
#   ./scripts/reset-demo.sh --yes    # no prompt
#
# DESTROYS, in the `urumi` namespace:
#   - every WooCommerce product and order (then re-seeds the 3 demo products)
#   - the whole audit log
#   - every dashboard user except the bootstrap admin, with their keys,
#     sessions, invites and permission rules
# KEEPS: the bootstrap admin (and its key), the registered MCP servers and
# their credentials, the Helm release, all Secrets.
#
# Refuses to run unless kubectl points at the local k3d cluster, so it can't be
# aimed at a real environment by accident.
set -euo pipefail

NS="${NS:-urumi}"
EXPECTED_CONTEXT="${EXPECTED_CONTEXT:-k3d-urumi-mcp}"
STORE_JOB="${STORE_JOB:-platform-store-bootstrap}"
PG_POD="${PG_POD:-platform-gateway-postgres-0}"
ADMIN_SECRET="${ADMIN_SECRET:-gateway-bootstrap-admin}"

yes=false
[ "${1:-}" = "--yes" ] && yes=true

context="$(kubectl config current-context)"
if [ "$context" != "$EXPECTED_CONTEXT" ]; then
  echo "refusing: kubectl context is '$context', expected '$EXPECTED_CONTEXT'" >&2
  echo "(set EXPECTED_CONTEXT to override, only if you are sure)" >&2
  exit 1
fi

cat <<EOF
This will reset the demo in namespace '$NS' (context $context):
  - delete ALL WooCommerce products and orders, then re-seed the demo products
  - delete the ENTIRE audit log
  - delete every dashboard user except the bootstrap admin
Registered MCP servers, credentials and the admin are kept.
EOF
if [ "$yes" != true ]; then
  read -r -p "Continue? [y/N] " answer
  [ "$answer" = "y" ] || [ "$answer" = "Y" ] || { echo "aborted"; exit 1; }
fi

admin_email="$(kubectl -n "$NS" get secret "$ADMIN_SECRET" -o jsonpath='{.data.email}' | base64 -d)"
[ -n "$admin_email" ] || { echo "could not read the bootstrap admin's email" >&2; exit 1; }

echo "== Gateway database"
# SQL goes in on stdin and the admin email is a psql variable, so nothing is
# interpolated into the statement text.
kubectl -n "$NS" exec -i "$PG_POD" -- sh -c \
  'psql -v ON_ERROR_STOP=1 -v admin_email="$0" -U "$POSTGRES_USER" -d "$POSTGRES_DB"' "$admin_email" <<'SQL'
begin;
create temp table doomed as
  select id from users where lower(email) <> lower(:'admin_email');
delete from audit_log;
delete from tool_permissions where user_id in (select id from doomed);
delete from invites where user_id in (select id from doomed);
delete from sessions where user_id in (select id from doomed);
delete from api_keys where user_id in (select id from doomed);
delete from users where id in (select id from doomed);
select count(*) as users_left from users;
commit;
SQL

echo "== WooCommerce store"
job_name="store-reset-$(date +%s)"
here="$(cd "$(dirname "$0")" && pwd)"
# A one-off Job built from the bootstrap Job (same image, volume, env, uid and
# pod labels, so the same NetworkPolicy and affinity apply), running
# scripts/lib/reset-store.sh instead of the bootstrap script.
kubectl -n "$NS" get job "$STORE_JOB" -o json |
  JOB_NAME="$job_name" RESET_SCRIPT="$here/lib/reset-store.sh" python3 -c '
import json, os, sys
job = json.load(sys.stdin)
generated = ("batch.kubernetes.io/", "controller-uid", "job-name")
tmpl = job["spec"]["template"]
tmpl["metadata"]["labels"] = {k: v for k, v in tmpl["metadata"]["labels"].items()
                              if not k.startswith(generated)}
job["spec"].pop("selector", None)
job["spec"]["backoffLimit"] = 1
tmpl["spec"]["containers"][0]["command"] = ["sh", "-c", open(os.environ["RESET_SCRIPT"]).read()]
job["metadata"] = {"name": os.environ["JOB_NAME"],
                   "labels": {k: v for k, v in job["metadata"].get("labels", {}).items()
                              if not k.startswith(generated)}}
job.pop("status", None)
json.dump(job, sys.stdout)
' | kubectl -n "$NS" create -f - >/dev/null

if kubectl -n "$NS" wait --for=condition=complete "job/$job_name" --timeout=300s >/dev/null; then
  kubectl -n "$NS" logs "job/$job_name" | grep -E '^\[(reset|bootstrap)\]' | tail -12
else
  echo "store reset failed; logs:" >&2
  kubectl -n "$NS" logs "job/$job_name" | tail -30 >&2 || true
  kubectl -n "$NS" delete job "$job_name" --ignore-not-found >/dev/null
  exit 1
fi
kubectl -n "$NS" delete job "$job_name" >/dev/null

echo "== Done"
echo "Storefront: products left (Store API)"
curl -fsS -m 10 "http://store.local.test/wp-json/wc/store/v1/products?per_page=100" 2>/dev/null |
  python3 -c 'import json,sys; print("  ", [p["name"] for p in json.load(sys.stdin)])' || true
echo "Reload the dashboard: the Audit log and Team pages are now empty except for the admin."
