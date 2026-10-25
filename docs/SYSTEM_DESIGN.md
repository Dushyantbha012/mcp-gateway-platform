# System design and tradeoffs

How the platform is put together, why, and what changes between the local k3d
cluster and a production-like k3s VPS. File paths are relative to the repo root.

## 1. The four layers

```
                        ┌──────────────────────── Kubernetes (namespace urumi) ───────────────────────┐
 browser ─► Ingress ──► │ dashboard (nginx, static React) ─/api─► gateway ◄── MCP clients (API key)    │
 MCP client ─► Ingress ►│                                          │  │                                │
                        │                  chat agent (in gateway) ┘  ├─► woocommerce-mcp ─► WordPress ─► MySQL
                        │                                             ├─► github (public internet)    │
                        │                          Postgres ◄─────────┴─► deepwiki (public internet)  │
                        └───────────────────────────────────────────────────────────────────────────────┘
                          upstream credentials: Secrets in namespace urumi-upstreams
```

| Layer | What | Where |
|---|---|---|
| Store | WordPress + WooCommerce + MySQL (StatefulSet + PVC), bootstrap Job installs and seeds it | `helm/charts/store` |
| WooCommerce MCP server | Our own MCP server, 5 tools, Streamable HTTP, ClusterIP only | `woocommerce-mcp/`, `helm/charts/store/templates/woocommerce-mcp.yaml` |
| Gateway + dashboard | Express + Kysely/Postgres; MCP client to every upstream, one MCP server for everyone; React dashboard | `gateway/`, `dashboard/`, `helm/charts/gateway`, `helm/charts/dashboard` |
| Chat agent | A tool loop (Groq gpt-oss-120b by default, or Gemini; user-switchable) inside the gateway that calls tools through the same router as `/mcp`, as the logged-in user | `gateway/src/chat/` |

Nothing but the gateway talks to an upstream. The chat agent is not a separate
client: it calls `ToolRouter` in-process with the user's identity, so there is
one code path for routing, permissions, timeouts and auditing.

## 2. A tool call, end to end

1. The client sends `tools/call` to `/mcp` with `Authorization: Bearer <api key>`
   (or an OAuth access token, section 12) (`gateway/src/mcp/endpoint.ts`). The key is hashed (SHA-256) and looked up on
   **every** request, so a revoked key or disabled user fails on its next call.
2. `ToolRouter` (`gateway/src/upstreams/router.ts`) maps the exposed name to
   `{server, upstream tool}` using a map built from each enabled server's cached
   tool list. Unknown or disabled → `rejected` (audited).
3. `decide()` (`gateway/src/permissions/evaluate.ts`) checks whether this user may
   use this tool, using rules read from Postgres now. Refused → `denied`, and the
   upstream is never called.
4. `UpstreamRegistry` returns the long-lived MCP client session for that server
   and attaches its credential as a header, server side
   (`gateway/src/upstreams/registry.ts`, `connection.ts`). The caller's own key is
   never forwarded.
5. One deadline covers connect + call (the server's `timeout_ms`, default 10 s).
6. Success, the tool's own error, a timeout or an unreachable upstream all come
   back as a normal MCP result (`isError` where it failed) and one row is written
   to `audit_log`, awaited before the reply: user, key, source (mcp/chat), server,
   tool, time, duration, outcome.

## 3. Tool aggregation, naming and collisions

Every aggregated tool is exposed as `<server_slug>__<tool>` (for example
`woocommerce__list_orders`). Slugs are lowercase letters, digits and single dashes
(never `_`), so the first `__` always ends the slug. Two servers exposing
`list_products` become `store-a__list_products` and `store-b__list_products`: no
hidden precedence rule, and the caller (or LLM) sees which server a tool belongs
to; descriptions are also prefixed with the server's name.

Names must fit Claude's and Gemini's function-name limits (64 chars,
`[A-Za-z0-9_-]`); longer or unsafe names are sanitised and suffixed with a short
hash of the original. Routing is always a map lookup, never string parsing,
because a sanitised name cannot be reversed (`gateway/src/upstreams/naming.ts`).

## 4. Failure handling

- **One session per upstream, one deadline per call.** A slow upstream cannot
  hold up another: calls never share a client.
- **`tools/list` never waits on an upstream.** A health loop (every 15 s, all
  servers in parallel) lists each server's tools under a short timeout and caches
  the result in Postgres. `tools/list` reads that cache and returns only enabled,
  currently reachable servers' tools.
- **A dead upstream fails only its own calls** with a clear message
  ("Upstream 'woocommerce' is unreachable (ECONNREFUSED)"), is marked unreachable
  at once, and shows as Unreachable with the reason in the dashboard.
- **Readiness checks Postgres only**, never upstreams, so a dead MCP server can't
  take the gateway out of its Service.
- **Verified live:** with the WooCommerce MCP pod scaled to 0, the dashboard
  showed it Unreachable while GitHub and DeepWiki stayed Connected and callable;
  it recovered when scaled back.

## 5. Access model

- **Roles:** `admin` (manages servers, members, permissions; sees the audit log)
  and `member` (uses tools, manages own keys). Enforced in the API
  (`gateway/src/auth/middleware.ts`), not just hidden in the UI.
- **API keys** (for MCP clients): random, shown once, stored as SHA-256 + a
  display prefix, revocable. **Dashboard login:** invite link → password (scrypt)
  → server-side session, HttpOnly + SameSite=Strict cookie scoped to `/api`;
  `/mcp` accepts keys only.
- **Permissions:** rules per role or per user, at server or tool level; most
  specific wins, deny beats allow on a tie, admins are never restricted. The
  **member default is read-only** (`gateway.memberDefault`, default `readOnly`):
  with no matching rule a member only gets tools the upstream marks
  `readOnlyHint: true`; admins grant writes with an Allow rule (per user or for
  all members). The same `decide()` drives `tools/list`, `tools/call`, the chat
  agent and the admin preview, so they cannot disagree.
- **Chat approvals:** with `gateway.chat.confirmWrites` (default on) the agent loop never runs a tool whose upstream hasn't marked it `readOnlyHint`: it emits a `confirm` event and ends the turn. The stateless API means the browser re-sends the history with `approved: [{name, args}]`; each entry releases one call with identical arguments, so a model can't smuggle in different ones. Held calls are not audited (nothing ran); the approved one is, as a normal chat call.
- **MCP write approvals:** `gateway.approvals.mcpWrites` (default on) applies the same rule to MCP clients in `ToolRouter.callTool`, after the permission check. The transport is stateless, so the gateway cannot ask in the middle of a call; instead the first call of a write inserts a `write_approvals` row (user, tool, hash of the canonical arguments, 10 minute expiry), returns an error naming it and audits it as `held`. The user approves on the dashboard (`/api/approvals`, session only, so an API key can't approve for itself) and the client's retry spends the approval in one atomic `UPDATE`, so two replicas can't both use it. The approval prompts show the upstream's tool description and hints next to the arguments.
- **Read-only override:** upstreams such as DeepWiki send no `readOnlyHint`, so every tool would be held. An admin can set `mcp_servers.read_only` (dashboard: "Treat all tools as read-only"); `buildToolIndex` then reports every tool of that server as read-only, which `ToolRouter`, the chat agent, the member default and the admin preview all read from the same route, so none of them hold or hide it. It is per server, not per tool, and only an admin can set it.
- **Audit:** every `tools/call` (MCP or chat) is recorded; gateway-level
  `search_tools` calls are recorded too, with the query, no server and the match
  count. `tools/list` is not audited (it changes nothing and would drown the log).

## 6. Many tools: search-then-execute

With `gateway.search.mode: on|auto` (and `chatMode` for the chat agent) a caller
sees two tools, `search_tools` and `call_tool`, instead of hundreds. Search ranks
only tools the caller may use (BM25 over name, arguments, description); `call_tool`
goes through the same router, so permissions, timeouts and audit rows are
identical and show the real tool. Default is off (full list), because small tool
sets are better served by listing them.

## 7. Key decisions and their tradeoffs

| Decision | Why | Cost |
|---|---|---|
| WooCommerce via its REST API (OAuth 1.0a in-cluster) | Public, versioned contract; WooCommerce enforces its own rules; MCP server runs in its own pod behind a NetworkPolicy. WP-CLI needs the shared RWO volume; raw SQL bypasses WooCommerce logic. | OAuth 1.0a signing is fiddly (see `woocommerce-mcp/src/wc/oauth1.ts`); plain HTTP in-cluster rules out Basic auth. |
| Stateless Streamable HTTP everywhere | Any replica can serve any request; no sticky sessions. | No server-initiated notifications. |
| Upstream credentials as Kubernetes Secrets in their own namespace | Postgres never holds a secret; RBAC for the gateway covers only that namespace. | The gateway needs a ServiceAccount token and a Kubernetes API call (cached ~5 s) when credentials change. |
| Health-checked tool cache | Listing is instant and independent of upstreams. | A tool added upstream appears after the next health pass (≤ 15 s) or a manual refresh. |
| Read-only member default | A shared team gateway should not let any member create products or write to GitHub by default. | Upstreams without `readOnlyHint` look like write tools and must be allowed explicitly. |
| Chat history in the browser | No new tables, any replica serves any turn. | Refreshing the page starts a new conversation. |
| Chat model: Groq `openai/gpt-oss-120b` by default, Gemini as an alternative, both via plain `fetch` behind one `LlmClient` interface | The brief grades the tool loop, not the model; Groq is fast and has tool calling, Gemini needs no extra account. Switching is a Helm value (`gateway.chat.provider`) or the chat page's Model menu, with no change to routing, permissions or audit. | Free tiers are rate limited; every loop step is one request, so search mode (fewer tool schemas per step) stays on for chat. |
| Writing the Helm charts from scratch (no Bitnami) | Every resource can be explained. | More YAML to maintain. |

## 8. Local → production (k3s VPS)

Same charts; only values differ (`helm/values-local.yaml` vs `helm/values-prod.yaml`).

| | Local (k3d) | Production-like (k3s VPS) |
|---|---|---|
| DNS / hosts | `*.local.test` in `/etc/hosts` (`.test` is reserved, never resolves publicly) | Real A/AAAA records for `store.`, `dashboard.`, `gateway.` pointing at the VPS |
| Ingress | k3d's Traefik on ports 80/443 | k3s' bundled Traefik; `ingress.tls: true` + cert-manager annotation |
| TLS | none | cert-manager `ClusterIssuer` (Let's Encrypt); `gateway.dashboardUrl` is `https://…`, which turns on the `Secure` cookie flag |
| Images | `k3d image import mcp-gateway/*:dev` | pushed to a registry; `image:` values point at it, `imagePullPolicy` default |
| Storage class | `local-path` | `local-path` on single-node k3s, or the provider's class; set `storageClassName` |
| Secrets | `scripts/create-secrets.sh` (random, never in git); k3d started with `--secrets-encryption` | The same script, different values, run on the VPS; install k3s with `--secrets-encryption` (AES-CBC at rest), back up `/var/lib/rancher/k3s/server/cred/encryption-config.json` separately from the datastore, rotate with `k3s secrets-encrypt rotate-keys`; optionally sealed-secrets/SOPS or a KMS |
| NetworkPolicy | `global.networkPolicy.apiServerCidr` = k3d node IP | = the VPS node IP (`kubectl get endpoints kubernetes`) |
| Sizing | small requests/limits | raise via values; `gateway.replicas` > 1 is safe for the API (sessions in Postgres), rate limits are per pod |
| Upgrades | `helm upgrade --install … -f values.yaml -f values-local.yaml` | same; `helm rollback platform <rev>` (migrations are additive; 005 is the only destructive one) |

**Caution:** `helm upgrade --reuse-values` keeps old computed values and skips the
defaults of newly added keys. Always pass the values files explicitly.

**Status of the production path:** the charts are deployed to a single-node k3s on
AWS EC2 by `deploy/ec2/deploy.sh` (README "Deploying to a VPS"). That path differs
from the table above in three ways: images are built locally and imported into
k3s' containerd instead of pulled from a registry; hostnames are
`<name>.<ip-with-dashes>.sslip.io`, so no domain is needed; and a NetworkPolicy
(`allow-acme-solver`) lets Traefik reach cert-manager's HTTP-01 solver pods, which
the default-deny policy would otherwise block. Provisioned stores get the same
policy (`acme-solver`) when TLS is on, the issuer's solver Services are ClusterIP
(a NodePort is refused by the stores' quota), and the per-store limits quota is
4 CPU because the four store pods already use 3 and the solver pod needs room.
The core stack, TLS, the three upstreams, OAuth, hosted servers and multi-store
were verified there with the repo's `verify-*` scripts; the DoD suite was not re-run. `values-prod.yaml` remains the registry-based variant
with placeholders.

## 9. Not done, on purpose

Per-pod-shared rate limiting and hostname-based egress filtering (needs an
FQDN-aware CNI). See the README's "Bonus items" table and the threat model's
residual risks.

## 10. Multi-store provisioning

```
 member ─► POST /api/stores ─► Postgres (stores row, status=provisioning) ─NOTIFY─┐
                                                                                  ▼
                            provisioner pod (advisory lock, 5s tick + LISTEN) ─► Kubernetes API
                              ensureSecrets → apply → MySQL → WordPress →         (server-side apply)
                              bootstrap Job → MCP server → register
                                                                                  ▼
          gateway ◄── mcp_servers row (managed_by=store) + credential ◄── namespace store-<slug>
```

The gateway never gets cluster-wide rights. Creating a store is a database row;
a separate **provisioner** (same image, its own ServiceAccount and ClusterRole)
turns rows into Kubernetes objects. Manifests are typed TypeScript builders
(`gateway/src/provisioner/manifests/store.ts`) that mirror the store Helm chart;
a parity test compares them with `helm template`, and invariant tests check every
container is non-root with limits and every pod is covered by a NetworkPolicy.

- **A reconciler, not a script.** Each step is idempotent and recorded in
  `stores.step`. After a crash the loop starts every unfinished row from step one
  and each completed step is a no-op, so there is no in-memory state. Generated
  secrets are created only if absent, because the MySQL volume keeps its first
  password. A store past `deadline_at` becomes `failed` with the step and the last
  observed condition; the owner can retry. One replica holds a Postgres advisory
  lock; a second one waits.
- **Isolation.** One namespace per store with Pod Security `restricted`, a
  ResourceQuota and LimitRange, default-deny NetworkPolicies in both directions, and
  allow rules only inside the namespace plus "the gateway's pods may reach the MCP
  server". `verify-phase10.sh` proves a pod in one store cannot reach another's
  MySQL or WordPress.
- **Registration.** The store's MCP server becomes an `mcp_servers` row with
  `managed_by=store`, so the servers API refuses to edit or delete it and the
  gateway's SSRF guard accepts exactly the in-cluster address the row implies.
  Its tools are `<slug>__<tool>` like any other.
- **Delete.** Row, credential and tools first, then the namespace (volumes go with
  it, `local-path` reclaims with Delete), then the `stores` row once the namespace
  is gone. The provisioner refuses any namespace without its own label.
- **Limits.** Any user, at most 2 stores each, checked in a transaction holding a
  lock on the user row; creating the same name twice returns the first store.

| Decision | Why | Cost |
|---|---|---|
| A provisioner pod instead of giving the gateway cluster rights | The part that faces users and MCP clients cannot create namespaces; the blast radius of a gateway bug is unchanged | One more Deployment and a ClusterRole to review |
| Server-side apply from typed builders, not Helm in a Job | No Helm binary or chart in the image, the state machine can see each object, tests are plain unit tests | The builders must be kept in line with the chart (the parity test does that) |
| Tight quotas and 1Gi volumes | Several stores fit on a laptop | A busy store would hit its quota |

## 11. Hosted MCP servers

An admin gives an image; the provisioner runs it. The same reconciler framework
as stores, with a different spec (`hostedReconciler.ts`, `manifests/hosted.ts`):
secret, apply, wait for the Deployment, register.

- **HTTP images** run as they are, with a generated bearer token the gateway
  attaches. **stdio images** get the `mcp-bridge` binary through an init container
  and an `emptyDir`; the bridge starts the admin's command as a child process and
  serves it as stateless Streamable HTTP, requiring the same bearer token.
- **Untrusted code.** Each server is in its own `mcp-<slug>` namespace with Pod
  Security `restricted`, non-root, read-only root filesystem, no capabilities, no
  ServiceAccount token, a small quota, and default-deny NetworkPolicies. Ingress is
  the gateway's pods only. Egress is DNS only, or, if the admin chose "internet",
  the public internet minus the cluster, pod and service ranges and the metadata
  address. `verify-hosted.sh` probes every one of those edges.
- **Supply chain.** The image must start with a prefix in `hosted.imageAllowlist`
  and be pinned (a tag other than `latest`, or a digest). Refusals are audited.
- **Secrets.** Secret environment values go from the admin API to a Secret in
  `urumi-upstreams` and are copied into the server's namespace by the provisioner;
  Postgres stores only the variable names.
- **Failure reporting.** If the Deployment never becomes ready, the reason is the
  pod's waiting reason (`ErrImagePull`, `CrashLoopBackOff`), shown on the Servers page.

## 12. OAuth for MCP clients

The gateway is its own authorization server (`gateway/src/oauth/`), so there is no
external identity provider to run and the consent page is the dashboard the user
already logs in to.

```
 MCP client                    gateway                               dashboard (browser)
     │  POST /mcp (no token)       │                                          │
     ├────────────────────────────►│ 401 WWW-Authenticate: Bearer resource_metadata=…
     │  GET /.well-known/oauth-protected-resource/mcp  → {resource, authorization_servers}
     │  GET /.well-known/oauth-authorization-server    → endpoints, S256, public clients
     │  POST /oauth/register       │ → client_id (mgc_…)                      │
     │  open browser: GET /oauth/authorize?client_id&redirect_uri&code_challenge&resource&scope
     │                             │ park request, 302 ───────────────────────►│ /oauth/consent?req=…
     │                             │                                          │ login if needed; user ticks
     │                             │◄─ POST /api/oauth/requests/:id {approve, scopes}  (session + Origin)
     │◄── 302 redirect_uri?code&state&iss  ◄──────────────────────────────────┤
     │  POST /oauth/token (code, code_verifier, resource)                      │
     │                             │ burn code, check PKCE, client, redirect, resource
     │◄── access mgo_… (1h) + refresh mgr_… (30d)
     │  POST /mcp  Authorization: Bearer mgo_…  → tools filtered by scope and by role
     │  POST /oauth/token (refresh_token) → new pair; the old refresh token is spent
```

- **What a token is.** Opaque random strings (`mgc_` client id, `mgo_` access,
  `mgr_` refresh), stored only as SHA-256 hashes, looked up on every request like API
  keys, so revoking a grant or disabling the user works on the next call. Each is
  bound to one client, one user and one resource (RFC 8707): `/mcp` rejects a token
  issued for another audience.
- **Standards, and what is strict.** PKCE S256 is mandatory and `plain` is refused.
  Public clients only (`token_endpoint_auth_method: none`). Redirect URIs must be https
  or loopback (RFC 8252), matched exactly except the loopback port. Errors after the
  client and redirect URI check out go back to the client with `state` and `iss`
  (RFC 9207); before that they are a plain 400 page, never a redirect.
- **Codes and refresh tokens.** A code is single use and burned on any attempt,
  including a wrong verifier. Reusing a code, or a refresh token that was already
  rotated, revokes everything the grant issued (`family_id`). Refresh tokens are bound
  to their client. A refresh may ask for less than was granted; the access token is
  narrowed and the grant is not.
- **Scopes only narrow.** `mcp:read` allows tools marked read-only, `mcp:write` the
  rest. They apply to admins too, are checked before the role permissions, hide the
  tools from `tools/list` and refuse a direct call (audited `denied`). A grant
  never gives more than the user's role. Held writes still wait for the user's approval.
- **Consent is a session action.** Only the logged-in person at the browser can
  approve: `/api/oauth/*` takes dashboard sessions, not API keys or OAuth tokens,
  and the Origin check applies. "Connected apps" lists and ends grants.
- **Audit.** Approve, deny and disconnect are audit rows; tool calls through a token
  are audited as the user, with no API key.
- **Issuer.** `PUBLIC_BASE_URL` (default the Ingress URL) is the issuer and its `/mcp`
  is the resource, so a tunnel moves both. The consent page is `DASHBOARD_URL`.

| Decision | Why | Cost |
|---|---|---|
| The gateway as authorization server | MCP clients need dynamic registration and discovery; no extra service, and the user's existing login and audit log are reused | The gateway now handles sign-in endpoints that need their own rate limits and tests |
| Opaque, hashed tokens | Instant revocation, nothing to forge, same model as API keys | One database lookup per request |
| Public clients and PKCE only | What Claude Code, Inspector and claude.ai are; no secrets to leak | No confidential-client flows |

## 13. Local to production notes for the three features

- Stores need wildcard DNS for `*.store.<domain>` (a real wildcard A record in
  production); locally one hosts line per store.
- OAuth needs https in production, which `ingress.tls` and `publicBaseUrl` give;
  `gateway.oauth.publicBaseUrl` is also how a tunnel is used for claude.ai.
- The provisioner's NetworkPolicy allows Postgres and the API server only; set
  `global.networkPolicy.apiServerCidr` as for the gateway.
