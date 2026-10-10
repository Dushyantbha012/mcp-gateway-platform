# WooCommerce Team MCP Gateway

A WooCommerce hosting platform with a team MCP gateway on Kubernetes —
built for the Urumi AI FDE Internship Round 1 assignment.

Planning docs (architecture, phased build plan, testing strategy, progress
log) live outside this repo at [`../docs`](../docs) during development.

**Status:** Phase 2 — the store (WordPress + WooCommerce + MySQL) and our own
WooCommerce MCP server run on Kubernetes. Gateway, dashboard and chat agent
land in later phases.

## Layout

```
woocommerce-mcp/   # our MCP server: 5 tools over Streamable HTTP, talks to the WooCommerce REST API
gateway/           # (Phase 3) MCP client to every upstream + MCP server for every caller, REST API, chat agent
dashboard/         # (Phase 4) React/Vite admin + member UI
helm/              # umbrella chart; helm/charts/store = one store (MySQL, WordPress, bootstrap Job, MCP server)
scripts/           # create-secrets.sh, verify-phase*.sh
```

## Local setup (k3d)

Prerequisites: Docker Desktop with **8GB+ memory**, Node 22+, `k3d`, `kubectl`, `helm`.

1. **Cluster** (k3s in Docker, with host ports 80/443 going to Traefik):

   ```bash
   k3d cluster create urumi-mcp --port "80:80@loadbalancer" --port "443:443@loadbalancer"
   ```

2. **Local domains** — add once to `/etc/hosts` (needs sudo):

   ```
   127.0.0.1 store.local.test dashboard.local.test gateway.local.test
   ```

   `*.local.test` never resolves on the public internet (`.test` is reserved
   by RFC 2606), so these names can't collide with a real site.

3. **Secrets** — random values, created once, never in git:

   ```bash
   ./scripts/create-secrets.sh
   ```

4. **Build the MCP server image** and load it into the cluster:

   ```bash
   docker build -f woocommerce-mcp/Dockerfile -t mcp-gateway/woocommerce-mcp:dev .
   k3d image import mcp-gateway/woocommerce-mcp:dev -c urumi-mcp
   ```

5. **Deploy**:

   ```bash
   helm upgrade --install platform helm -n urumi -f helm/values-local.yaml --wait --timeout 15m
   ```

   A post-install Job (WP-CLI) installs WordPress and WooCommerce, enables
   Cash on Delivery and free shipping, creates the shop pages, seeds three
   demo products and registers the REST API key. It's idempotent and re-runs
   on every `helm upgrade`. Logs: `kubectl -n urumi logs job/platform-store-bootstrap`.

6. **Verify everything** (tests, Helm render, deploy, isolation, live MCP
   calls, persistence, idempotency):

   ```bash
   ./scripts/verify-phase2.sh
   ```

## Using the store

- Storefront: http://store.local.test — add a product to the cart, check out
  with **Cash on delivery**.
- Admin: http://store.local.test/wp-admin — WooCommerce → Orders shows the order.
  Credentials:

  ```bash
  kubectl -n urumi get secret store-admin -o jsonpath='{.data.username}' | base64 -d; echo
  kubectl -n urumi get secret store-admin -o jsonpath='{.data.password}' | base64 -d; echo
  ```

## The WooCommerce MCP server

Tools: `list_products`, `create_product`, `list_orders`, `get_order`,
`update_order_status`.

It has **no Ingress or NodePort** — only a ClusterIP Service — and requires a
bearer token (`woocommerce-mcp-auth` Secret). In normal use only the gateway
calls it. To inspect it by hand with MCP Inspector, port-forward for the
duration of the test:

```bash
kubectl -n urumi port-forward svc/platform-store-woocommerce-mcp 13000:3000
kubectl -n urumi get secret woocommerce-mcp-auth -o jsonpath='{.data.token}' | base64 -d; echo
npx @modelcontextprotocol/inspector
```

In Inspector choose transport **Streamable HTTP**, URL
`http://127.0.0.1:13000/mcp`, and add header `Authorization: Bearer <token>`.

How it talks to the store, and why (REST API + OAuth 1.0a signing): see
`docs/02-architecture.md`.

## Tests

```bash
npm test           # unit + MCP protocol tests (no cluster needed)
./scripts/verify-phase2.sh   # everything above, plus live tests against the k3d deployment
```
