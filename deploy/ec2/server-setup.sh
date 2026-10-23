#!/usr/bin/env bash
# Runs ON the EC2 instance (Ubuntu), as root: swap, k3s, Helm, cert-manager,
# Let's Encrypt issuer. Idempotent. Called by deploy.sh; can be run by hand:
#   sudo LETSENCRYPT_EMAIL=you@example.com bash server-setup.sh
set -euo pipefail
: "${LETSENCRYPT_EMAIL:?set LETSENCRYPT_EMAIL}"
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml

# 4GB RAM is tight for MySQL + WordPress + Postgres + gateway: add swap.
if ! swapon --show | grep -q /swapfile; then
  fallocate -l 4G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

# k3s with Secrets encrypted at rest (the chart's documented requirement).
if ! command -v k3s >/dev/null; then
  curl -sfL https://get.k3s.io | INSTALL_K3S_EXEC="server --secrets-encryption --write-kubeconfig-mode 644" sh -
fi
until kubectl get nodes 2>/dev/null | grep -q ' Ready'; do sleep 3; done

command -v helm >/dev/null || curl -fsSL https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash

if ! kubectl get ns cert-manager >/dev/null 2>&1; then
  helm repo add jetstack https://charts.jetstack.io >/dev/null
  helm upgrade --install cert-manager jetstack/cert-manager -n cert-manager --create-namespace \
    --version v1.16.2 --set crds.enabled=true --wait --timeout 5m
fi

kubectl apply -f - <<YAML
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-prod
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: ${LETSENCRYPT_EMAIL}
    privateKeySecretRef:
      name: letsencrypt-prod-key
    solvers:
      - http01:
          ingress:
            ingressClassName: traefik
YAML
echo "server-setup done"
