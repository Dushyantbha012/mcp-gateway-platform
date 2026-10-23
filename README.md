# WooCommerce Team MCP Gateway

A WooCommerce hosting platform with a team MCP gateway on Kubernetes —
built for the Urumi AI FDE Internship Round 1 assignment.

**Design notes:** [System design and tradeoffs](docs/SYSTEM_DESIGN.md) ·
[Threat model](docs/THREAT_MODEL.md) · [Observability](docs/observability/README.md) ·
[Bonus items and where to find them](#bonus-items-and-where-to-find-them)

**Status:** the store (WordPress + WooCommerce + MySQL), our own
WooCommerce MCP server, the MCP gateway (with its Postgres, API keys, audit
log and REST API), the team dashboard (login, servers, tools, keys, team,
audit) and the chat agent (a tool loop on Groq's gpt-oss-120b by default, or Gemini, streamed to the dashboard) run
on Kubernetes, with three upstream servers connected (WooCommerce, GitHub,
DeepWiki), the brief's whole definition of done scripted end to end, and
per-role / per-user tool permissions (members are read-only by default) on top,
plus SSRF protection, deny-by-default networking, hygiene for untrusted upstream text
(prompt-injection mitigation), per-call approval of writes, metrics and search-then-execute.
On top of that: members can provision their own isolated stores, admins can deploy
MCP servers from an image, and MCP clients such as Claude Code, MCP Inspector and
claude.ai can sign in with OAuth.
The same charts are deployed to a single-node k3s on AWS EC2 (see [Deploying to a VPS](#deploying-to-a-vps-aws-ec2--k3s)); the full definition-of-done suite has not been re-run there.

## Layout

```
woocommerce-mcp/   # our MCP server: 5 tools over Streamable HTTP, talks to the WooCommerce REST API
gateway/           # MCP client to every upstream + one MCP endpoint for every caller, REST API, chat agent
gateway/src/provisioner/  # the provisioner: builds and deletes stores and hosted MCP servers through the Kubernetes API
gateway/src/oauth/        # OAuth 2.1 authorization server for MCP clients
gateway/src/security/     # SSRF guard (ssrf.ts) and hygiene for untrusted upstream text (untrusted.ts)
mcp-bridge/        # serves a stdio MCP server over Streamable HTTP (for hosted stdio images)
dashboard/         # React/Vite admin + member UI (Tailwind + shadcn/ui), served by nginx
e2e/               # Playwright: browser tests against the real gateway + dashboard build, and live storefront checkout
system/            # the definition-of-done suite: one scripted scenario against the live cluster
helm/              # umbrella chart; charts/store = one store (MySQL, WordPress, bootstrap Job, MCP server),
                   #                 charts/gateway = gateway + its Postgres,
                   #                 charts/dashboard = the dashboard (its Ingress sends /api to the gateway)
scripts/           # create-secrets.sh, register-upstreams.sh, reset-demo.sh, verify-*.sh, netpol_matrix.py, audit-pods.py
docs/              # system design, threat model, observability (Grafana dashboard + alerts)
```

## Local setup (k3d)

Prerequisites: Docker Desktop with **8GB+ memory**, Node 22+, `k3d`, `kubectl`, `helm`.

1. **Cluster** (k3s in Docker, with host ports 80/443 going to Traefik):

   ```bash
   k3d cluster create urumi-mcp --port "80:80@loadbalancer" --port "443:443@loadbalancer" \
     --k3s-arg "--secrets-encryption@server:*"
   ```

   The last flag turns on encryption at rest for every Kubernetes Secret
   (upstream credentials, database passwords, LLM keys). Without it Secrets are
   only base64 in k3s' datastore. `./scripts/verify-encryption.sh` proves it.

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
   agent, create a [Groq API key](https://console.groq.com/keys) (the default
   model, `openai/gpt-oss-120b`) and/or a free Gemini key in
   [Google AI Studio](https://aistudio.google.com/apikey). Put each in the
   environment or in `~/.config/urumi/groq.env` / `gemini.env` (a line like
   `GROQ_API_KEY=...`); the script pipes it to `kubectl`, so it never appears on a
   command line or in a values file. With no key everything else works and chat is
   switched off; with both, the chat page has a model selector:

   ```bash
   GROQ_API_KEY=... GEMINI_API_KEY=... ./scripts/create-secrets.sh   # either one is enough
   ```

   To rotate a key later: `kubectl -n urumi delete secret gateway-groq`
   (or `gateway-gemini`), run the line above again, then `kubectl -n urumi
   rollout restart deployment/platform-gateway`.

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
   ./scripts/verify-phase5.sh   # chat agent (needs a Groq or Gemini key)
   ./scripts/verify-phase6.sh   # three upstreams + the full definition of done (needs the GitHub token too)
   ./scripts/verify-phase7.sh   # tool permissions (re-runs Phase 6 and 2-5)
   ./scripts/verify-phase8.sh   # security hardening (re-runs everything above under default-deny networking)
   ./scripts/verify-claude-code.sh   # a real Claude Code session as a member: read, denied tool, held write, approval
   ./scripts/verify-encryption.sh    # Secrets are ciphertext in the k3s datastore
   ./scripts/verify-phase10.sh       # multi-store provisioning (a few minutes per store)
   ./scripts/verify-hosted.sh        # hosted MCP servers
   ./scripts/verify-oauth.sh         # OAuth for MCP clients
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
| GET | `/api/audit?userId=&server=&outcome=&source=&requestId=&before=&limit=` | audit log, newest first (admin) |
| GET | `/api/stats` | overview numbers for the dashboard (admin) |
| GET, PUT, DELETE | `/api/permissions`, `/api/permissions/:id` | tool permission rules (admin) |
| GET | `/api/permissions/effective?userId=\|role=member` | what a person or role gets, and which rule decides (admin) |
| GET | `/api/approvals` | write approvals waiting for you |
| POST | `/api/approvals/:id/approve`, `/api/approvals/:id/deny` | decide one (dashboard session only; an API key gets 403) |
| POST | `/api/chat` | the chat agent, streamed as Server-Sent Events |
| GET, POST | `/api/stores` | list / create a store (see "Multi-store provisioning") |
| GET, DELETE | `/api/stores/:id` | one store / delete it |
| POST | `/api/stores/:id/retry` | retry a failed store |
| GET, POST | `/api/hosted` | hosted MCP servers: list / deploy by image (admin) |
| GET, PATCH, DELETE | `/api/hosted/:id` | one hosted server / edit / remove (admin) |
| POST | `/api/hosted/:id/retry` | retry a hosted server that failed (admin) |
| GET, POST | `/api/oauth/requests/:id` | consent page data / approve or deny an OAuth request (dashboard session) |
| GET, DELETE | `/api/oauth/apps`, `/api/oauth/apps/:id` | apps you connected through OAuth / disconnect one |

OAuth endpoints themselves (`/oauth/*`, `/.well-known/*`) are described under
"OAuth for MCP clients". `GET /healthz`, `GET /readyz` and `GET /metrics` are
outside `/api`.

Example - add a server with a bearer credential:

```bash
curl -X POST http://gateway.local.test/api/servers \
  -H "Authorization: Bearer $ADMIN_KEY" -H "Content-Type: application/json" \
  -d '{"slug":"github","name":"GitHub","url":"https://api.githubcopilot.com/mcp/","authType":"bearer","credential":"<token>"}'
```

Every tool call (from any client) is written to the audit log with user,
key, server, tool, time, duration, outcome (`success`, `tool_error`,
`timeout`, `unreachable`, `rejected`, `denied`) and request ID.

## Connect more servers (GitHub, DeepWiki)

The brief needs at least three upstreams. WooCommerce is seeded; the other two
are added the way an admin would, through the gateway's API (the dashboard's
"Add server" form calls the same endpoint):

1. Create a **read-only** fine-grained GitHub token (Settings → Developer
   settings → Fine-grained tokens; public repositories only; Metadata,
   Contents, Issues and Pull requests set to _Read_, nothing with write).
   Read-only matters: GitHub's server exposes 49 tools, many of which write,
   so a read-only token is still the right defence in depth, even though
   Phase 7 permissions can hide those tools from members. Save it
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

The token is sent to the gateway once, stored as a Kubernetes Secret in the
`urumi-upstreams` namespace (see "Security hardening"), and added to GitHub calls server-side; no response, log or Helm
value ever contains it (`verify-phase6.sh` greps for it). Tools appear as
`github__*` and `deepwiki__*` next to `woocommerce__*`.

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
   server (credentials are stored as a Kubernetes Secret and never shown again — leave
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

6. **Permissions** (admin): choose which tools members can see and call.
   Pick "All members" or one person, then set **Allow**, **Deny** or
   **Inherit** on a whole server or on a single tool. The "Result for them"
   column shows what that subject actually gets and why. Rules:
   - **Members are read-only by default** (`gateway.memberDefault: readOnly`):
     with no matching rule a member only gets tools the upstream marks
     `readOnlyHint: true` (WooCommerce's `list_*`/`get_*` are; `create_product`
     and `update_order_status` are not). An **Allow** rule grants a write tool
     to one person or to all members; the column "Result for them" says
     "read-only default" when that is why a tool is hidden. Set
     `gateway.memberDefault: allowAll` to get the old behaviour (everything
     allowed until a Deny rule). Admins are never restricted.
   - The most specific rule wins: a rule for one person beats a rule for all
     members, a tool rule beats a server rule, and deny beats allow when
     they are equally specific. A server rule also covers tools the upstream
     adds later.
   - A denied tool is missing from that member's `tools/list` and from the
     chat agent's tool list, and a direct `tools/call` is refused
     (`You don't have permission to use ...`) without reaching the upstream.
     The attempt is audited with outcome `denied`.
   - Rules are read on every request, so a change applies on the member's
     next call, on every gateway replica. Removing a server deletes its rules;
     renaming its slug moves them.

7. **Overview, Approvals, Stores, Connected apps**: Overview (admin) summarises
   calls, errors and server health; **Approvals** lists writes waiting for the
   user's click (see "Approving writes"); **Stores** creates and deletes
   members' stores; the Servers page can also deploy a server from an image; the
   API keys page lists OAuth apps you have connected and lets you disconnect them.
   The sections "Stores, hosted MCP servers and OAuth" below cover these.

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

1. Chat: _"Create a product named Demo Mug priced 12.50"_. The agent stops with an
   **Approval needed** card showing `woocommerce__create_product` and its
   arguments; click **Approve**. Open http://store.local.test and the product is there.
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

**Approving writes.** A tool that changes data (anything its server doesn't mark
`readOnlyHint`: `create_product`, `update_order_status`, GitHub's writes) is never
run straight away. The gateway ends the turn with a `confirm` event, the dashboard
shows an **Approval needed** card, and **Approve** / **Decline** answer it. The
approval is enforced by the gateway, not the model: `POST /api/chat` accepts
`approved: [{name, args}]`, and each entry lets one call to that tool with those
exact arguments through; anything else is held again. Reads run without asking.
`gateway.chat.confirmWrites: false` (env `CHAT_CONFIRM_WRITES`) turns it off. The
card also shows what the upstream says the tool does (its description and
`destructiveHint`), not only the arguments the model chose.

**Approving writes from MCP clients.** The same rule holds for Claude Code, Cursor
and any other client (`gateway.approvals.mcpWrites`, env `MCP_CONFIRM_WRITES`, default
on; admins too). The first call of a write is refused with a message naming a
request id, and a pending request appears on the dashboard's **Approvals** page.
The user checks the arguments and approves there; the client then repeats the same
call and it runs once. It is enforced in the gateway (`write_approvals` table), not
in the client: an approval is tied to the user, the tool and the exact arguments,
is used up by one call, and expires after 10 minutes. Only a dashboard session can
approve; the API key the client holds gets a 403, so the client can't approve for
itself. `./scripts/verify-claude-code.sh` runs this with a real Claude Code session
as a member (see Tests).

**Choosing the model.** The default is Groq's `openai/gpt-oss-120b` (tool calling
over Groq's OpenAI-compatible API; `gateway.chat.groqModel`, and
`groqReasoningEffort: low` keeps each step fast). Gemini is the alternative
(`gateway.chat.model`, default `gemini-3.5-flash-lite`). Both are behind one
`LlmClient` interface, so the tool loop, permissions and audit are identical.

- **Which one is default:** `gateway.chat.provider: groq | gemini` (env
  `CHAT_PROVIDER`). If that provider's Secret is missing, the other one is used.
- **Switching at runtime:** when both keys exist the chat page shows a **Model**
  menu next to "New chat"; the choice is sent per message (`provider` in
  `POST /api/chat`), `GET /api/meta` lists `chatProviders`. No restart needed.
- **Limits:** both free tiers are rate limited (Gemini Flash: ~20 requests/day,
  Flash Lite ~500; Groq: per-minute token limits, so keep `gateway.search.chatMode`
  on, which sends the model two tools instead of all of them). Every step of a turn
  is one request. Check your limits in the Groq console / AI Studio.

## Observability

- **`GET /metrics`** (Prometheus text, same port as the API, unauthenticated, not on the Ingress): tool-call count, error outcome and latency histogram per server and tool, `mcp_gateway_upstream_up` per server, plus process metrics. `METRICS_ENABLED=false` turns it off. Counters are per pod (sum them); the upstream gauges are read from Postgres at scrape time, so every replica agrees (use `max by (server)`).
- **Request ID**: every response has `X-Request-ID` (a well-formed inbound one is kept, otherwise generated). It is in every JSON log line as `requestId` and in each audit row (`audit_log.request_id`; filter with `GET /api/audit?requestId=...`; shown on the dashboard's Audit page). One chat turn or JSON-RPC batch shares one ID. It is not forwarded to upstream servers.
- **Helm**: `gateway.metrics.enabled`, optional `gateway.metrics.serviceMonitor.*` (rendered only if the cluster has the Prometheus Operator CRDs), and `global.networkPolicy.metricsScrape.*` to let a Prometheus namespace reach port 8080.
- A Grafana dashboard, example alert rules and the full metric list are in [`docs/observability`](docs/observability/README.md).

## Search-then-execute (hundreds of tools)

By default `tools/list` returns every tool, which floods a client's context once several servers are connected. With search mode the client sees only two tools:

- `search_tools {query, server?, limit?}` ranks the tools the caller may use (BM25-style keyword scoring over name, arguments and description) and returns exact names plus input schemas. An empty query lists servers and tool counts.
- `call_tool {name, arguments?}` runs one by its exact name through the same router: permissions, timeouts and auditing are unchanged, and the audit row, metrics and chat panel all show the real tool, never `call_tool`.

| Setting | Meaning |
|---|---|
| `SEARCH_MODE=off\|on\|auto` | Default tool list for MCP clients. `auto` switches to the two meta-tools once the caller can see more than `SEARCH_AUTO_THRESHOLD` (default 50) tools. |
| `/mcp?mode=search` or `?mode=full` | Per-client override, in either direction. Anything else is a 400. |
| `CHAT_SEARCH_MODE=off\|on\|auto` | The same choice for the chat agent's model. The agent's step and tool-call budgets get extra headroom for the search step. |

Helm: `gateway.search.mode`, `gateway.search.chatMode`, `gateway.search.autoThreshold`. `GET /api/tools` and the dashboard Tools page always show the full list.

## Security hardening

Five controls, each tested on its own (the first four are re-checked by
`./scripts/verify-phase8.sh`):

- **SSRF guard on "add server".** The gateway makes the requests to upstream
  URLs from inside the cluster, so a URL like `http://169.254.169.254/`,
  `http://localhost:5432` or `http://platform-gateway-postgres:5432` must never
  work. Upstream URLs must resolve to public addresses (all of them; IPv4,
  IPv6, mapped and encoded forms included), checked when you save and again on
  every connection with the address actually connected to, so DNS rebinding
  and redirects don't get around it. The in-cluster WooCommerce MCP server is
  allowed because its host is allowlisted in Helm (`gateway.ssrf.allowedHosts`
  adds more; nothing in the dashboard or API can). Code: `gateway/src/security/ssrf.ts`.
- **Credentials are Kubernetes Secrets, encrypted at rest.** Each upstream's
  token is one Secret in the `urumi-upstreams` namespace; Postgres only records
  that a credential exists. k3s runs with `--secrets-encryption` (AES-CBC), so
  the datastore and its backups hold ciphertext, not base64
  (`./scripts/verify-encryption.sh` reads the raw rows to prove it). That protects
  against a stolen disk or backup; anyone who can `get secrets` through the API,
  or is root on the node (the key file sits beside the datastore), still reads
  plaintext. A KMS or vault is the production upgrade. The gateway's ServiceAccount may manage Secrets in that namespace and
  nothing else (it can't read `gateway-db`, can't list pods), and it is the
  only pod with a ServiceAccount token. Inspect it with
  `kubectl -n urumi-upstreams get secrets` and
  `kubectl auth can-i get secrets -n urumi --as=system:serviceaccount:urumi:platform-gateway`.
- **Deny-by-default networking.** `helm/templates/networkpolicies.yaml` denies
  all ingress and egress, then allows only the flows in the diagram at the top
  of that file. The gateway can reach the public internet (Groq, Gemini, GitHub,
  DeepWiki) but not private ranges, the node or cloud metadata. Prove it:
  `python3 scripts/netpol_matrix.py` prints a 9x10 table of what each workload
  can reach. On a new cluster set `global.networkPolicy.apiServerCidr` to the
  node IP where the API server listens (`kubectl get endpoints kubernetes`).
- **Untrusted upstream text.** An upstream can put instructions in a tool
  description or a result ("prompt injection"). The gateway cannot make that
  harmless, so `gateway/src/security/untrusted.ts` reduces it: invisible content
  (zero-width and bidi characters, the Unicode tag block, control characters, HTML
  comments) is stripped from descriptions, schema descriptions and results;
  descriptions are normalised and capped (2000 characters, 500 per parameter);
  a description that reads like an instruction to the model ("ignore previous
  instructions", "don't tell the user", `<IMPORTANT>` tags, "before using any other
  tool", credential-reading requests) gets a gateway notice prepended, so clients, the
  chat model and approval prompts all see it; and in chat, upstream results are
  fenced as `<<<UNTRUSTED TOOL RESULT ...>>>` and the system prompt says nothing
  inside can change the rules. The patterns are a heuristic that rephrasing can
  evade; the real limits are the user's permissions, approval of writes and the
  audit log (see the threat model, section 3).
- **Restricted pods.** Every container is non-root with a read-only root
  filesystem, no capabilities, a seccomp profile and no ServiceAccount token (the
  gateway aside). The namespace enforces the Pod Security `restricted`
  profile, so a bare `kubectl run` there is refused. `python3 scripts/audit-pods.py`
  checks the running pods; CI checks the rendered chart.

## Tests

```bash
docker compose -f docker-compose.test.yml up -d   # throwaway Postgres for gateway integration tests
TEST_DATABASE_URL=postgres://gateway_test:gateway_test@localhost:5433/gateway_test npm test
(cd e2e && npx playwright install chromium)        # once
TEST_DATABASE_URL=postgres://gateway_test:gateway_test@localhost:5433/gateway_test npm run test:e2e
./scripts/verify-phase2.sh   # store + MCP server, live against the k3d deployment
./scripts/verify-phase3.sh   # gateway, live against the k3d deployment
./scripts/verify-phase4.sh   # dashboard, live (incl. a Playwright run against dashboard.local.test)
./scripts/verify-phase5.sh   # chat agent, live against the default provider (Groq, else Gemini; reads GROQ_API_KEY / GEMINI_API_KEY or ~/.config/urumi/*.env); then re-runs phases 2-4
./scripts/verify-phase6.sh   # registers GitHub + DeepWiki, runs the definition-of-done suite (real chat model, GitHub, DeepWiki), then re-runs phases 2-5
./scripts/verify-phase7.sh   # the same suite plus its tool-permissions step, live permission/audit checks, then re-runs phases 2-5
./scripts/verify-phase10.sh  # multi-store: create two stores, use both, prove they are isolated, delete them (a few minutes: WooCommerce is downloaded per store)
./scripts/verify-hosted.sh   # hosted MCP servers: deploy a stdio and an HTTP image, probe the network, delete them
./scripts/verify-encryption.sh  # Secrets are ciphertext in the k3s datastore
./scripts/verify-oauth.sh    # OAuth: discovery, registration, PKCE, scopes, refresh rotation, revoke (curl, no browser)
```

The test suites create users, products and orders that stay in the local
cluster. Reset it to a clean demo state with `./scripts/reset-demo.sh`
(destructive; refuses to run unless `kubectl` points at `k3d-urumi-mcp`).

The definition-of-done suite alone (cluster up, upstreams registered):

```bash
SYSTEM_GATEWAY_URL=http://gateway.local.test SYSTEM_DASHBOARD_URL=http://dashboard.local.test \
SYSTEM_STORE_URL=http://store.local.test SYSTEM_ADMIN_KEY=... \
SYSTEM_STORE_ADMIN_USER=... SYSTEM_STORE_ADMIN_PASSWORD=... npx vitest run --project system
```

It needs a browser for the storefront step (`npx playwright install chromium`
in `e2e/`, once) and takes about a minute and roughly 15 model requests.

The chat agent's unit, API and E2E tests use a scripted or rule-based fake
model, so they are deterministic, free and need no key; only
`verify-phase5.sh` talks to the real model (about ten requests per run).

The E2E suite starts the real gateway on a fresh database with fake MCP
upstreams, builds the dashboard and drives it in Chromium (two browser
contexts for the admin/member flow).

Without `TEST_DATABASE_URL` the gateway's Postgres-backed tests are skipped
(with a warning); CI always runs them against a Postgres service container.
With Postgres the full run is about 990 passing tests (24 more need a live
cluster or model keys and are skipped) plus 15 Playwright scenarios.

## Stores, hosted MCP servers and OAuth

Three features that build on the gateway. Each has a live verify script that
builds, deploys to k3d and checks the claims below; `SKIP_DEPLOY=1` reuses what
is already running. Design and threats: [system design](docs/SYSTEM_DESIGN.md)
sections 10-12 and the [threat model](docs/THREAT_MODEL.md) sections 7-9.

### Multi-store provisioning

Any member can create a store from the **Stores** page (at most `stores.maxPerUser`,
default 2, each). A **provisioner** pod (same image as the gateway, its own
ServiceAccount) builds it through the Kubernetes API: a `store-<slug>` namespace
with a quota, default-deny NetworkPolicies, MySQL, WordPress, the bootstrap Job and
a WooCommerce MCP server, then registers that server so its tools appear as
`<slug>__list_orders` beside every other tool. Deleting a store removes the
namespace (and with it the volumes), the credential and the tools.

- The page shows progress step by step; a store that gets stuck is marked failed
  with the step and reason (default deadline 15 minutes) and its owner can retry.
- Stores are reached at `<slug>.store.local.test`. `/etc/hosts` has no wildcards,
  so add a line per store (the verify script prints them), or run dnsmasq.
- The provisioner is the only thing with a cluster-wide Role, and it refuses to
  touch a namespace it did not label itself. Crash recovery needs no state: every
  step is idempotent and re-runs from the top.
- The original store stays as the read-only "default" store.

### Hosted MCP servers

An admin can deploy an MCP server from an image on the **Servers** page ("By
image"). An HTTP image is used as it is; a stdio image gets the `mcp-bridge`
binary copied in by an init container, which serves it over Streamable HTTP. Each
server runs in its own `mcp-<slug>` namespace: non-root, read-only filesystem, no
ServiceAccount token, default-deny networking (egress is "none" or "internet" with
private ranges excluded, chosen per server), and only the gateway can reach it.

- Images must match `hosted.imageAllowlist` and be pinned: `:latest` and untagged
  references are refused, and refusals are audited.
- Secret environment variables go to a Kubernetes Secret, never to Postgres or the API.
- Docker Hub's `mcp/*` images only publish `:latest`, so pin them by digest.
- A server that cannot start says why (`ImagePullBackOff`, `CrashLoopBackOff`...).

### OAuth for MCP clients

With `gateway.oauth.enabled` the gateway is its own OAuth 2.1 authorization
server, so Claude Code, MCP Inspector and claude.ai connect without an API key:
discovery from the 401 on `/mcp` (RFC 9728, 8414), dynamic client registration
(RFC 7591), authorization code with PKCE S256 only, resource indicators (RFC
8707), refresh token rotation and revocation (RFC 7009). The user approves on the
dashboard's consent page and can disconnect an app under **API keys**, which ends
its access on the next request.

- Scopes `mcp:read` and `mcp:write` only narrow what the user can already do (admins
  included): a read-only grant never sees or runs a write tool. Writes still wait
  for the user's approval.
- Tokens are opaque and stored as SHA-256 hashes. Reusing a refresh token or an
  authorization code revokes the whole grant.
- **Claude Code** only sends tokens over https or to localhost. Locally, point the
  issuer at a port-forward (the comments in `helm/values-local.yaml` show how).
- **claude.ai** needs a public https URL: run `ngrok http` (or cloudflared) at the
  gateway, set `gateway.oauth.publicBaseUrl` to the tunnel URL, and add
  `<tunnel>/mcp` as a custom connector. Close the tunnel and reset the value when done.
- Checked live with Claude Code, MCP Inspector 2.10 and claude.ai.

## Deploying to a VPS (AWS EC2 + k3s)

The same charts run on one Ubuntu EC2 instance (`m7i-flex.large`, 2 vCPU / 8 GB)
with only values changed. `deploy/ec2/deploy.sh` does it from your laptop:

```bash
LETSENCRYPT_EMAIL=you@example.com ./deploy/ec2/deploy.sh ubuntu@<public-ip> ~/key.pem
```

Open ports 22, 80 and 443 in the Security Group first. The script:

1. builds the four images for `linux/amd64` and streams them into k3s' containerd
   (no registry; `imagePullPolicy: IfNotPresent` with the `:dev` tags);
2. on the instance (`deploy/ec2/server-setup.sh`): adds swap, installs k3s with
   `--secrets-encryption`, Helm, cert-manager and a Let's Encrypt `ClusterIssuer`;
3. runs `scripts/create-secrets.sh` and `helm upgrade --install` with a generated
   `values-ec2.yaml`.

What differs from local, all through values:

| | Local (k3d) | EC2 (k3s) |
|---|---|---|
| Hostnames | `*.local.test` in `/etc/hosts` | `dashboard.`, `store.`, `gateway.` + `<ip-with-dashes>.sslip.io` (no domain needed) |
| TLS | none | cert-manager + Let's Encrypt (HTTP-01); `gateway.dashboardUrl` is `https://`, so the session cookie gets `Secure` |
| Images | `k3d image import` | built locally, imported into k3s containerd |
| `networkPolicy.apiServerCidr` | k3d node IP | the instance's private IP (`kubectl get endpoints kubernetes`) |
| Stores | `<slug>.store.local.test` | `<slug>.stores.<ip>.sslip.io` (wildcard DNS, so no hosts lines) |

Two things the default-deny networking needed: cert-manager's HTTP-01 solver pods
run in the `urumi` namespace, so `deploy.sh` adds a NetworkPolicy
(`allow-acme-solver`) that lets Traefik reach them; without it no certificate is
issued. Upstreams (DeepWiki, GitHub) are registered afterwards with
`GATEWAY_URL=https://gateway.<ip>.sslip.io ./scripts/register-upstreams.sh`, and
chat keys are added as the `gateway-groq` / `gateway-gemini` Secrets followed by
`kubectl -n urumi rollout restart deployment/platform-gateway`.

Checked on the instance: all pods Running, the three Ingress certificates Ready
(valid Let's Encrypt over HTTPS), and the WooCommerce (5 tools), DeepWiki (3) and
GitHub (49) upstreams Connected. Not re-run there: the definition-of-done suite,
store provisioning (its per-store certificates may need the same ACME NetworkPolicy
inside each `store-<slug>` namespace), hosted servers and the OAuth flow.
`helm/values-prod.yaml` stays the registry-based variant with placeholders.

## Upgrades and rollback

```bash
helm upgrade platform helm -n urumi -f helm/values.yaml -f helm/values-local.yaml --wait --timeout 15m
helm history platform -n urumi
helm rollback platform <revision> -n urumi --wait
```

Pass the values files **every time**. `--reuse-values` keeps the previously
computed values and skips the defaults of keys added since, which silently
changes behaviour (it once rendered an empty `podSelector` in a NetworkPolicy).
Gateway migrations run at startup under an advisory lock and are additive, so a
rollback to the previous image still works (migration 005 dropped the old
encrypted-credential column; roll back no further than the release before it).
The store's bootstrap Job is idempotent and re-runs on every upgrade.

## Bonus items and where to find them

| Item from the brief | Status | Where |
|---|---|---|
| Tool permissions (per role / per user, hidden + rejected; read-only member default) | Done | `gateway/src/permissions/`, Permissions page, `docs/SYSTEM_DESIGN.md` §5 |
| Security hardening: SSRF guard, Secrets for credentials (encrypted at rest by k3s), default-deny NetworkPolicies, non-root pods, least-privilege RBAC | Done | `gateway/src/security/ssrf.ts`, `gateway/src/credentials/`, `helm/templates/networkpolicies.yaml`, `helm/charts/gateway/templates/rbac.yaml`, `scripts/netpol_matrix.py`, `scripts/audit-pods.py`, `scripts/verify-encryption.sh`; [threat model](docs/THREAT_MODEL.md) |
| Prompt-injection hygiene for untrusted upstream text (strip hidden content, flag instruction-like descriptions, fence chat results) | Done (reduces, does not solve) | `gateway/src/security/untrusted.ts`, [threat model](docs/THREAT_MODEL.md) §3 |
| Handling many tools (search-then-execute) | Done | `gateway/src/search/`, README "Search-then-execute" |
| Observability (metrics, request IDs, unreachable reasons, Grafana + alerts) | Done | `gateway/src/metrics/`, `gateway/src/requestContext.ts`, `docs/observability/` |
| Upgrades and rollback | Documented | README "Upgrades and rollback" |
| Production-like VPS deployment | **Deployed** on AWS EC2 + k3s with Let's Encrypt TLS (core stack and three upstreams checked; DoD suite, stores, hosted and OAuth not re-run there) | `deploy/ec2/`, README "Deploying to a VPS", `helm/values-prod.yaml` (registry variant, placeholders), `docs/SYSTEM_DESIGN.md` §8 |
| Scaling (multi-replica, rate limits) | Partial: stateless API, `gateway.replicas` works; rate limits are per pod | Rate limits are per gateway pod (login, chat) |
| OAuth on the gateway (Claude Code, MCP Inspector, claude.ai) | Done | `gateway/src/oauth/`, `gateway/src/db/oauth.ts`, `dashboard/src/pages/OAuthConsentPage.tsx`, `scripts/verify-oauth.sh`; README "Stores, hosted MCP servers and OAuth" |
| Hosted MCP servers (deploy an image; stdio through a bridge) | Done | `gateway/src/provisioner/hostedReconciler.ts`, `gateway/src/provisioner/manifests/hosted.ts`, `mcp-bridge/`, `scripts/verify-hosted.sh` |
| Multi-store provisioning (bonus) | Done | `gateway/src/provisioner/`, `gateway/src/api/stores.ts`, Stores page, `scripts/verify-phase10.sh`; `docs/SYSTEM_DESIGN.md` §10 |
