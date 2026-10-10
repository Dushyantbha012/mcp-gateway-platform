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
