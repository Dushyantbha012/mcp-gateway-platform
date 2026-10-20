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
   (`gateway/src/mcp/endpoint.ts`). The key is hashed (SHA-256) and looked up on
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
| Secrets | `scripts/create-secrets.sh` (random, never in git) | The same script, different values, run on the VPS; optionally sealed-secrets/SOPS |
| NetworkPolicy | `global.networkPolicy.apiServerCidr` = k3d node IP | = the VPS node IP (`kubectl get endpoints kubernetes`) |
| Sizing | small requests/limits | raise via values; `gateway.replicas` > 1 is safe for the API (sessions in Postgres), rate limits are per pod |
| Upgrades | `helm upgrade --install … -f values.yaml -f values-local.yaml` | same; `helm rollback platform <rev>` (migrations are additive; 005 is the only destructive one) |

**Caution:** `helm upgrade --reuse-values` keeps old computed values and skips the
defaults of newly added keys. Always pass the values files explicitly.

**Status of the production path:** `values-prod.yaml` is the documented set of
changes with placeholder domains/registry; it renders and lints in CI, but the
charts have not yet been deployed to a real VPS.

## 9. Not done, on purpose

OAuth on the gateway, hosted MCP servers, multi-store provisioning, per-pod-shared
rate limiting, hostname-based egress filtering (needs an FQDN-aware CNI). See the
README's "Bonus items" table and the threat model's residual risks.
