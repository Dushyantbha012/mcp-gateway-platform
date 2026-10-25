#!/usr/bin/env bash
# Deploys the platform to a single Ubuntu EC2 instance running k3s, from your laptop.
#
#   LETSENCRYPT_EMAIL=you@example.com GROQ_API_KEY=... \
#     ./deploy/ec2/deploy.sh ubuntu@<public-ip> ~/.ssh/key.pem
#
# Images are built here for linux/amd64 (PLATFORM=linux/arm64 for Graviton) and
# streamed into k3s' containerd: no registry needed. Hostnames use sslip.io
# (store.<ip-with-dashes>.sslip.io), so no domain is required.
set -euo pipefail
TARGET="${1:?usage: deploy.sh user@host [ssh-key]}"
KEY="${2:-}"
: "${LETSENCRYPT_EMAIL:?set LETSENCRYPT_EMAIL for Lets Encrypt}"
PLATFORM="${PLATFORM:-linux/amd64}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
IP="${TARGET##*@}"
DOM="${IP//./-}.sslip.io"
SSH_OPTS=(-o StrictHostKeyChecking=accept-new)
[ -n "$KEY" ] && SSH_OPTS+=(-i "$KEY")
rsh() { ssh "${SSH_OPTS[@]}" "$TARGET" "$@"; }

cd "$ROOT"
echo "==> building images ($PLATFORM)"
for app in woocommerce-mcp gateway dashboard mcp-bridge; do
  docker buildx build --platform "$PLATFORM" --load -f $app/Dockerfile -t mcp-gateway/$app:dev .
done

echo "==> server setup (swap, k3s, helm, cert-manager)"
scp "${SSH_OPTS[@]}" deploy/ec2/server-setup.sh "$TARGET":/tmp/server-setup.sh
rsh "sudo LETSENCRYPT_EMAIL='$LETSENCRYPT_EMAIL' bash /tmp/server-setup.sh"

echo "==> shipping images into k3s"
# Files + resumable rsync with retries: a long ssh pipe can die on networks with a small MTU.
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
RSH="ssh ${SSH_OPTS[*]} -o ServerAliveInterval=15 -o IPQoS=none"
for app in woocommerce-mcp gateway dashboard mcp-bridge; do
  docker save mcp-gateway/$app:dev | gzip > "$TMP/$app.tar.gz"
  for try in 1 2 3 4 5 6; do
    rsync --partial --inplace -e "$RSH" "$TMP/$app.tar.gz" "$TARGET":/tmp/$app.tar.gz && break
    echo "upload of $app failed (try $try), retrying"; sleep 3
    [ "$try" = 6 ] && { echo "giving up on $app"; exit 1; }
  done
  rsh "gunzip -c /tmp/$app.tar.gz | sudo k3s ctr images import - && rm /tmp/$app.tar.gz"
done

echo "==> copying chart + scripts"
rsh "rm -rf ~/platform && mkdir -p ~/platform"
COPYFILE_DISABLE=1 tar --no-xattrs --exclude="._*" -czf - helm scripts | rsh "tar xzf - -C ~/platform"

echo "==> installing (https://dashboard.$DOM)"
rsh "DOM='$DOM' GROQ_API_KEY='${GROQ_API_KEY:-}' GEMINI_API_KEY='${GEMINI_API_KEY:-}' bash -s" <<'REMOTE'
set -euo pipefail
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
cd ~/platform
NODE_IP=$(kubectl get endpoints kubernetes -o jsonpath='{.subsets[0].addresses[0].ip}')
./scripts/create-secrets.sh
cat > values-ec2.yaml <<YAML
global:
  networkPolicy:
    apiServerCidr: ${NODE_IP}/32
store:
  ingress:
    host: store.${DOM}
    tls: true
    annotations: { cert-manager.io/cluster-issuer: letsencrypt-prod }
  storageClassName: local-path
gateway:
  ingress:
    host: gateway.${DOM}
    tls: true
    annotations: { cert-manager.io/cluster-issuer: letsencrypt-prod }
  storageClassName: local-path
  dashboardUrl: https://dashboard.${DOM}
  seedWoocommerce:
    storeUrl: https://store.${DOM}
  oauth: { enabled: true }
  # Every upstream tool definition in each Groq request is too big for its free tier (HTTP 413):
  # give the chat agent search_tools + call_tool once it can see more than autoThreshold tools.
  gateway:
    search: { chatMode: auto, autoThreshold: 20 }
  stores:
    enabled: true
    template:
      baseDomain: stores.${DOM}
      tls: true
      ingressAnnotations: { cert-manager.io/cluster-issuer: letsencrypt-prod }
      storageClassName: local-path
  hosted:
    enabled: true
    imageAllowlist: [docker.io/mcp/, docker.io/mcp-gateway/]
dashboard:
  ingress:
    host: dashboard.${DOM}
    tls: true
    annotations: { cert-manager.io/cluster-issuer: letsencrypt-prod }
YAML
# cert-manager's HTTP-01 solver pods land in this namespace, which is
# default-deny: let Traefik reach them or certificates never issue.
kubectl apply -f - <<YAML
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: { name: allow-acme-solver, namespace: urumi }
spec:
  podSelector: { matchLabels: { acme.cert-manager.io/http01-solver: "true" } }
  policyTypes: [Ingress]
  ingress:
    - from:
        - namespaceSelector: { matchLabels: { kubernetes.io/metadata.name: kube-system } }
      ports: [{ port: 8089 }]
YAML
helm upgrade --install platform helm -n urumi -f helm/values.yaml -f values-ec2.yaml --wait --timeout 20m
echo
echo "Dashboard: https://dashboard.${DOM}"
echo "Store:     https://store.${DOM}"
echo "Gateway:   https://gateway.${DOM}/mcp"
echo "Admin login:"
echo "  email:    $(kubectl -n urumi get secret gateway-bootstrap-admin -o jsonpath='{.data.email}' | base64 -d)"
echo "  password: $(kubectl -n urumi get secret gateway-bootstrap-admin -o jsonpath='{.data.password}' | base64 -d)"
REMOTE
