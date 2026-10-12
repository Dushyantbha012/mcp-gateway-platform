#!/usr/bin/env bash
# Creates the Kubernetes Secrets the Helm chart references, with random
# values. Idempotent: an existing Secret is left untouched, because the MySQL
# volume and WooCommerce's API-key table already depend on its value.
#
#   ./scripts/create-secrets.sh                 # namespace "urumi"
#   NAMESPACE=prod ./scripts/create-secrets.sh  # any other namespace
#
# Same script for local k3d and the VPS: no secret value ever lives in git
# or in a values file.
set -euo pipefail

NAMESPACE="${NAMESPACE:-urumi}"
ADMIN_USER="${STORE_ADMIN_USER:-admin}"
ADMIN_EMAIL="${STORE_ADMIN_EMAIL:-admin@example.com}"

rand() { openssl rand -hex "$1"; }

kubectl get namespace "$NAMESPACE" >/dev/null 2>&1 || kubectl create namespace "$NAMESPACE"

# Pod Security Admission: the API server itself refuses any pod in this
# namespace that is not non-root, without privilege escalation, with all
# capabilities dropped and a seccomp profile ("restricted" profile). A mistake
# in a chart then fails at deploy time instead of shipping a root container.
kubectl label namespace "$NAMESPACE" --overwrite \
  pod-security.kubernetes.io/enforce=restricted \
  pod-security.kubernetes.io/audit=restricted \
  pod-security.kubernetes.io/warn=restricted >/dev/null

create() {
  local name="$1"
  shift
  if kubectl -n "$NAMESPACE" get secret "$name" >/dev/null 2>&1; then
    echo "secret/$name exists, leaving it as is"
  else
    kubectl -n "$NAMESPACE" create secret generic "$name" "$@"
  fi
}

create store-db \
  --from-literal=root-password="$(rand 24)" \
  --from-literal=password="$(rand 24)"

create store-admin \
  --from-literal=username="$ADMIN_USER" \
  --from-literal=password="$(rand 16)" \
  --from-literal=email="$ADMIN_EMAIL"

# Same shape WooCommerce itself generates: ck_/cs_ + 40 hex chars.
create store-wc-api \
  --from-literal=consumer-key="ck_$(rand 20)" \
  --from-literal=consumer-secret="cs_$(rand 20)"

create woocommerce-mcp-auth \
  --from-literal=token="$(rand 32)"

# --- Gateway ---
create gateway-db \
  --from-literal=password="$(rand 24)"

# AES-256-GCM key for upstream credentials stored in the gateway's Postgres.
# Losing it means re-entering every upstream credential.
create gateway-encryption-key \
  --from-literal=key="$(openssl rand -base64 32)"

# Bootstrap admin: seeded on the gateway's first start. Same format as keys
# the gateway issues: mgw_<8 hex>_<32 random bytes, base64url>.
api_key="mgw_$(rand 4)_$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=')"
create gateway-bootstrap-admin \
  --from-literal=email="${GATEWAY_ADMIN_EMAIL:-admin@example.com}" \
  --from-literal=api-key="$api_key"
unset api_key

# Dashboard password for the bootstrap admin (added in Phase 4). Patched in
# only if missing, so an existing install keeps its email and API key; the
# gateway sets it once, on its next start, if the admin has no password yet.
if [ -z "$(kubectl -n "$NAMESPACE" get secret gateway-bootstrap-admin -o jsonpath='{.data.password}')" ]; then
  kubectl -n "$NAMESPACE" patch secret gateway-bootstrap-admin --type merge \
    -p "{\"stringData\":{\"password\":\"$(rand 16)\"}}" >/dev/null
  echo "secret/gateway-bootstrap-admin: added dashboard password"
fi

# Chat agent (Phase 5). Only created when GEMINI_API_KEY is set, so an install
# without a key still works (chat is simply off). The value is piped in, not
# passed as an argument, so it never shows in a process list. To rotate:
#   kubectl -n urumi delete secret gateway-gemini
#   GEMINI_API_KEY=... ./scripts/create-secrets.sh
#   kubectl -n urumi rollout restart deployment/platform-gateway
if [ -n "${GEMINI_API_KEY:-}" ]; then
  if kubectl -n "$NAMESPACE" get secret gateway-gemini >/dev/null 2>&1; then
    echo "secret/gateway-gemini exists, leaving it as is"
  else
    printf '%s' "$GEMINI_API_KEY" |
      kubectl -n "$NAMESPACE" create secret generic gateway-gemini --from-file=api-key=/dev/stdin
  fi
else
  kubectl -n "$NAMESPACE" get secret gateway-gemini >/dev/null 2>&1 ||
    echo "GEMINI_API_KEY not set and no secret/gateway-gemini: the chat agent will be off"
fi

echo "Gateway admin API key:  kubectl -n $NAMESPACE get secret gateway-bootstrap-admin -o jsonpath='{.data.api-key}' | base64 -d"
echo "Dashboard admin login:  kubectl -n $NAMESPACE get secret gateway-bootstrap-admin -o jsonpath='{.data.email}' | base64 -d"
echo "                        kubectl -n $NAMESPACE get secret gateway-bootstrap-admin -o jsonpath='{.data.password}' | base64 -d"
