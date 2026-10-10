# WooCommerce Team MCP Gateway

A WooCommerce hosting platform with a team MCP gateway on Kubernetes —
built for the Urumi AI FDE Internship Round 1 assignment.

Planning docs (architecture, phased build plan, testing strategy, progress
log) live outside this repo at [`../docs`](../docs) during development.

**Status:** Phase 6 — the store (WordPress + WooCommerce + MySQL), our own
WooCommerce MCP server, the MCP gateway (with its Postgres, API keys, audit
log and REST API), the team dashboard (login, servers, tools, keys, team,
audit) and the chat agent (Gemini tool loop, streamed to the dashboard) run
on Kubernetes, with three upstream servers connected (WooCommerce, GitHub,
DeepWiki) and the brief's whole definition of done scripted end to end.

## Layout

```
woocommerce-mcp/   # our MCP server: 5 tools over Streamable HTTP, talks to the WooCommerce REST API
gateway/           # MCP client to every upstream + one MCP endpoint for every caller, REST API, chat agent
dashboard/         # React/Vite admin + member UI (Tailwind + shadcn/ui), served by nginx
e2e/               # Playwright: browser tests against the real gateway + dashboard build, and live storefront checkout
system/            # the definition-of-done suite: one scripted scenario against the live cluster
helm/              # umbrella chart; charts/store = one store (MySQL, WordPress, bootstrap Job, MCP server),
                   #                 charts/gateway = gateway + its Postgres,
                   #                 charts/dashboard = the dashboard (its Ingress sends /api to the gateway)
scripts/           # create-secrets.sh, register-upstreams.sh, verify-phase*.sh
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

   If requests to these names take exactly 5 seconds each (`curl -w
   '%{time_namelookup}' http://gateway.local.test/healthz`), the macOS resolver
   is waiting for an IPv6 answer; add the IPv6 loopback too:

   ```
   ::1 store.local.test dashboard.local.test gateway.local.test
   ```

   `*.local.test` never resolves on the public internet (`.test` is reserved
   by RFC 2606), so these names can't collide with a real site.

3. **Secrets** — random values, created once, never in git. For the chat
   agent, create a free Gemini API key in
   [Google AI Studio](https://aistudio.google.com/apikey) and pass it in the
   environment (it's piped to `kubectl`, never put on a command line or in a
   values file). Without it everything else works and chat is switched off:

   ```bash
   GEMINI_API_KEY=... ./scripts/create-secrets.sh
   ```

   To rotate the key later: `kubectl -n urumi delete secret gateway-gemini`,
   run the line above again, then `kubectl -n urumi rollout restart
   deployment/platform-gateway`.

4. **Build the images** and load them into the cluster:

   ```bash
   for app in woocommerce-mcp gateway dashboard; do
     docker build -f $app/Dockerfile -t mcp-gateway/$app:dev .
     k3d image import mcp-gateway/$app:dev -c urumi-mcp
   done
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
   calls, failure isolation, NetworkPolicies, persistence, dashboard flows):

   ```bash
   ./scripts/verify-phase2.sh   # store + WooCommerce MCP server
   ./scripts/verify-phase3.sh   # gateway
   ./scripts/verify-phase4.sh   # dashboard: login, invites, keys, audit, live browser test
   ./scripts/verify-phase5.sh   # chat agent (needs the Gemini key)
   ./scripts/verify-phase6.sh   # three upstreams + the full definition of done (needs the GitHub token too)
   ```

   Each accepts `SKIP_DEPLOY=1` to check the running deployment without
   rebuilding; `verify-phase4.sh` also takes `SKIP_TESTS=1`.

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

Since Phase 3 a NetworkPolicy also drops traffic from any pod not labelled
`urumi.ai/mcp-client=true` (the gateway's pods are), so port-forwarding is
the only way to reach it by hand.

How it talks to the store, and why (REST API + OAuth 1.0a signing): see
`docs/02-architecture.md`.

## The gateway

One MCP endpoint for the whole team: `http://gateway.local.test/mcp`
(Streamable HTTP). It lists the tools of every enabled, reachable upstream
server as `<server>__<tool>` (e.g. `woocommerce__list_orders`) and routes
each call to the right server, adding that server's stored credential
server-side. Callers authenticate with their own gateway API key; they never
see upstream URLs or credentials.

The bootstrap admin's API key (created by `create-secrets.sh`):

```bash
kubectl -n urumi get secret gateway-bootstrap-admin -o jsonpath='{.data.api-key}' | base64 -d; echo
```

**Connect an MCP client** with only the gateway URL and a key:

- Claude Code:

  ```bash
  claude mcp add --transport http gateway http://gateway.local.test/mcp --header "Authorization: Bearer <key>"
  ```

- MCP Inspector (`npx @modelcontextprotocol/inspector`): transport
  **Streamable HTTP**, URL `http://gateway.local.test/mcp`, header
  `Authorization: Bearer <key>`.

**REST API** — what the dashboard uses. Scripts authenticate with
`Authorization: Bearer <key>`; the dashboard with its session cookie (and
an `Origin` the gateway allows on every change):

| Method | Path | |
|---|---|---|
| POST | `/api/auth/login`, `/api/auth/logout` | dashboard session (cookie) |
| GET, POST | `/api/auth/invites/:token[/accept]` | who an invite is for / set a password and log in |
| GET | `/api/me` | the caller |
| POST | `/api/me/password` | change your password (dashboard session; ends your other sessions) |
| GET | `/api/tools`, `/api/meta` | the tools your MCP client sees now / the public MCP URL |
| GET, POST | `/api/servers` | list (anyone; never includes credentials) / add (admin) |
| GET, PATCH, DELETE | `/api/servers/:id` | edit, enable/disable, remove (admin) |
| POST | `/api/servers/:id/refresh` | health-check now (admin) |
| GET, POST | `/api/users` | list / invite (admin; returns a one-time invite link) |
| PATCH | `/api/users/:id` | name, role, disable/enable (admin; not yourself, not the last admin) |
| POST | `/api/users/:id/invite` | new invite link — also how an admin resets a password |
| GET, POST | `/api/users/:id/keys` | list / issue a key - `me` for yourself; the key is shown once |
| DELETE | `/api/keys/:id` | revoke (admin or the key's owner) |
| GET | `/api/audit?userId=&server=&outcome=&source=&before=&limit=` | audit log, newest first (admin) |

Example - add a server with a bearer credential:

```bash
curl -X POST http://gateway.local.test/api/servers \
  -H "Authorization: Bearer $ADMIN_KEY" -H "Content-Type: application/json" \
  -d '{"slug":"github","name":"GitHub","url":"https://api.githubcopilot.com/mcp/","authType":"bearer","credential":"<token>"}'
```

Every tool call (from any client) is written to the audit log with user,
key, server, tool, time, duration and outcome (`success`, `tool_error`,
`timeout`, `unreachable`, `rejected`).

## Connect more servers (GitHub, DeepWiki)

The brief needs at least three upstreams. WooCommerce is seeded; the other two
are added the way an admin would, through the gateway's API (the dashboard's
"Add server" form calls the same endpoint):

1. Create a **read-only** fine-grained GitHub token (Settings → Developer
   settings → Fine-grained tokens; public repositories only; Metadata,
   Contents, Issues and Pull requests set to _Read_, nothing with write).
   Read-only matters: GitHub's server exposes 49 tools, many of which write,
   and the chat agent has no per-tool permissions until Phase 7. Save it
   outside the repo:

   ```bash
   mkdir -p ~/.config/urumi && install -m 600 /dev/null ~/.config/urumi/github.env
   echo 'GITHUB_MCP_TOKEN=github_pat_...' > ~/.config/urumi/github.env
   ```

2. Register both (idempotent; existing servers are never touched):

   ```bash
   ./scripts/register-upstreams.sh                  # DeepWiki (no auth) + GitHub (bearer)
   ./scripts/register-upstreams.sh --rotate-github  # replace GitHub's token later
   ```

The token is sent to the gateway once, stored AES-256-GCM-encrypted in its
Postgres, and added to GitHub calls server-side; no response, log or Helm
value ever contains it (`verify-phase6.sh` greps for it). Tools appear as
`github__*` and `deepwiki__*` next to `woocommerce__*`.

## Full demo script (the definition of done)

`./scripts/verify-phase6.sh` runs all of this automatically
(`system/dod.system.test.ts`). To do it by hand, as in the demo video:

1. **Store** — http://store.local.test: add a product, check out with Cash on
   delivery; the order is in http://store.local.test/wp-admin → WooCommerce → Orders.
2. **User A, chat** — log in to the dashboard as a member, open Chat: _"Create
   a product named Demo Mug priced 9.75"_ (it appears on the storefront), place
   an order for it by hand, then _"What orders came in today?"_.
3. **User B, Claude Code** — an admin invites B (Team → Invite member); B opens
   the link, sets a password, creates a key under API keys, and runs the
   command the Tools page shows:

   ```bash
   claude mcp add --transport http gateway http://gateway.local.test/mcp --header "Authorization: Bearer <B's key>"
   ```

   In Claude Code, `/mcp` lists the tools of every server. Ask _"what orders
   came in today?"_. For two upstreams in one prompt: _"Use DeepWiki to look up
   the structure of the woocommerce/woocommerce repo and list the products in
   my store."_
4. **Control** — as admin: revoke B's key (API keys or Team) and B's next call
   is rejected; disable DeepWiki and its tools vanish from chat and from
   Claude Code; `kubectl -n urumi scale deploy/platform-store-woocommerce-mcp
   --replicas=0` shows WooCommerce Unreachable while GitHub and DeepWiki keep
   working (scale back to 1 to recover).
5. **Audit** — the Audit page lists every call above under the right user,
   with source `mcp` (Claude Code) or `chat`.

## The dashboard

http://dashboard.local.test — one origin for the browser: the dashboard's
Ingress sends `/api` to the gateway.

1. **Log in as the admin.** Email and password (set by `create-secrets.sh`):

   ```bash
   kubectl -n urumi get secret gateway-bootstrap-admin -o jsonpath='{.data.email}' | base64 -d; echo
   kubectl -n urumi get secret gateway-bootstrap-admin -o jsonpath='{.data.password}' | base64 -d; echo
   ```

   Change it from the account menu (top right) after the first login.

2. **Servers**: WooCommerce shows **Connected** with its 5 tools. Add a
   server (credentials are stored encrypted and never shown again — leave
   the field blank on edit to keep the current one), toggle it off/on,
   "Check" it now, or remove it. Status refreshes every 5s; a dead server shows
   **Unreachable** with the reason within one health interval (15s).

3. **Invite a member**: Team → Invite member → copy the link (there is no
   mail server; send it yourself). It's valid for 7 days and works once.
   The member opens it, sets a password and is logged in. "Reset password"
   on a member gives a new link the same way.

4. **The member gets a key**: API keys → Create API key (shown once), then
   Tools shows the gateway URL and a ready-to-paste `claude mcp add`
   command. Members see no upstream URLs, no Team or Audit pages and no
   edit controls (the API enforces the same).

5. **Audit log** (admin): every tool call with user, source, server, tool,
   duration and outcome; filter by user/server/outcome/source, "Live"
   refreshes every 5s.

Revoking a key (API keys, or a member's keys on Team) rejects its very next
MCP call; disabling a member ends their dashboard session and keys at once.

## The chat agent

http://dashboard.local.test/chat (every logged-in user). Ask a question; the
agent picks tools from the same list your MCP client gets
(`woocommerce__list_orders`, ...), calls them **as you**, and answers from the
results. Each turn shows a "Tools called" panel (arguments, result, duration)
while it streams; **Stop** ends a turn and **New chat** starts over. Answers are
rendered as markdown (raw HTML is never rendered).

To reproduce the demo flow:

1. Chat: _"Create a product named Demo Mug priced 12.50"_. Open
   http://store.local.test and the product is there.
2. On the storefront, add it to the cart and check out with Cash on Delivery.
3. Chat: _"What orders came in today?"_ — it calls `woocommerce__list_orders`
   and lists your order.
4. As admin, Audit log shows both calls under your name with source `chat`.

How it works: `POST /api/chat` takes the transcript (the browser keeps the
history), runs the loop in the gateway and streams Server-Sent Events. Tool
calls go through the same router as the MCP endpoint, so routing, timeouts
and the audit log are identical; disabling a server removes its tools from
the very next step. Model, limits and the Secret are set under
`gateway.chat` in the Helm values.

The free Gemini tier is small: Flash models allow about 20 requests a day,
Flash Lite (the default, `gemini-3.5-flash-lite`) about 500, and every step of
a turn is one request. Check your key's limits at
https://aistudio.google.com/rate-limit and change `gateway.chat.model` if you
want a stronger model.

## Tests

```bash
docker compose -f docker-compose.test.yml up -d   # throwaway Postgres for gateway integration tests
TEST_DATABASE_URL=postgres://gateway_test:gateway_test@localhost:5433/gateway_test npm test
(cd e2e && npx playwright install chromium)        # once
TEST_DATABASE_URL=postgres://gateway_test:gateway_test@localhost:5433/gateway_test npm run test:e2e
./scripts/verify-phase2.sh   # store + MCP server, live against the k3d deployment
./scripts/verify-phase3.sh   # gateway, live against the k3d deployment
./scripts/verify-phase4.sh   # dashboard, live (incl. a Playwright run against dashboard.local.test)
./scripts/verify-phase5.sh   # chat agent, live against the real Gemini API (reads GEMINI_API_KEY or ~/.config/urumi/gemini.env); then re-runs phases 2-4
./scripts/verify-phase6.sh   # registers GitHub + DeepWiki, runs the definition-of-done suite (real Gemini, GitHub, DeepWiki), then re-runs phases 2-5
```

The definition-of-done suite alone (cluster up, upstreams registered):

```bash
SYSTEM_GATEWAY_URL=http://gateway.local.test SYSTEM_DASHBOARD_URL=http://dashboard.local.test \
SYSTEM_STORE_URL=http://store.local.test SYSTEM_ADMIN_KEY=... \
SYSTEM_STORE_ADMIN_USER=... SYSTEM_STORE_ADMIN_PASSWORD=... npx vitest run --project system
```

It needs a browser for the storefront step (`npx playwright install chromium`
in `e2e/`, once) and takes about a minute and roughly 15 Gemini requests.

The chat agent's unit, API and E2E tests use a scripted or rule-based fake
model, so they are deterministic, free and need no key; only
`verify-phase5.sh` talks to Gemini (about ten requests per run).

The E2E suite starts the real gateway on a fresh database with fake MCP
upstreams, builds the dashboard and drives it in Chromium (two browser
contexts for the admin/member flow).

Without `TEST_DATABASE_URL` the gateway's Postgres-backed tests are skipped
(with a warning); CI always runs them against a Postgres service container.

## Known limitations

- **No outgoing email.** The WordPress container has no mail server, so
  WooCommerce's order emails ("New order", "Processing order") fail and
  leave a note on each order: _"Email ... failed to send: Could not
  instantiate mail function"_. Orders are unaffected. Real email would need
  an SMTP service (e.g. an SMTP plugin configured from a Secret), which is
  out of scope for this assignment. The same goes for dashboard invites:
  the admin copies the invite link and sends it themselves.
- **Chat history lives in the browser.** Refreshing the page starts a new
  conversation, and only the text of earlier turns (not their tool calls) is
  sent back to the model.
- **The chat agent doesn't ask before destructive tools.** It acts with the
  user's own permissions and every call is audited, but there is no
  per-tool confirmation or allow-list until Phase 7. Until then the GitHub
  upstream uses a read-only token, so its write tools exist but GitHub
  rejects them (HTTP 403). WooCommerce's `create_product` and
  `update_order_status` do work for every member.
- **GitHub and DeepWiki are external.** The suite needs internet access and
  can fail for reasons that aren't ours (DeepWiki down, GitHub token
  expired); the gateway then marks that one server Unreachable and the rest
  keep working.
- **Chat limits are per gateway pod** (turns per minute per user, in
  memory), like the login limiter, and the Gemini free tier has a daily cap.
- **Login rate limiting is per gateway pod** (in memory). With more
  replicas an attacker gets that many times the attempts; a shared store
  is a Phase 8 item.
