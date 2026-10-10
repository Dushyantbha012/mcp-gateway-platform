#!/usr/bin/env bash
# Manual verification for Phase 1 (Scaffold). Run from anywhere:
#   ./scripts/verify-phase1.sh
# Re-runnable any time you want to confirm the foundation still works
# before building on top of it.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== Toolchain versions =="
node -v
npm -v
k3d version
helm version --short
kubectl version --client --short 2>/dev/null || kubectl version --client

echo
echo "== Lint =="
npm run lint

echo
echo "== Format check =="
npm run format:check

echo
echo "== Unit/component tests (all 3 packages) =="
npm test

echo
echo "== TypeScript build (all 3 packages) =="
npm run build

echo
echo "== Helm chart lints clean =="
helm lint helm/

echo
echo "== k3d cluster is up =="
kubectl get nodes

echo
echo "== Ingress smoke test (apply -> curl -> teardown) =="
kubectl apply -f helm/smoke-test.yaml
kubectl wait --for=condition=Available deployment/smoke-test --timeout=60s

for host in store.local.test dashboard.local.test gateway.local.test; do
  # Deployment "Available" doesn't mean Traefik's dynamic routing has
  # picked up the new Service endpoint yet - retry briefly before failing.
  code=""
  for attempt in 1 2 3 4 5; do
    code=$(curl -s -o /dev/null -w "%{http_code}" "http://${host}")
    [ "$code" = "200" ] && break
    sleep 2
  done
  echo "${host} -> HTTP ${code}"
  if [ "$code" != "200" ]; then
    echo "FAILED: expected HTTP 200 from ${host}. Is /etc/hosts set? Is the cluster up?"
    kubectl delete -f helm/smoke-test.yaml --ignore-not-found
    exit 1
  fi
done

kubectl delete -f helm/smoke-test.yaml

echo
echo "All Phase 1 checks passed."
