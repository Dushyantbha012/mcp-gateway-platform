# Threat model

Who and what we defend against, what each control does, and what is **not**
solved. Scope: the gateway, dashboard, chat agent and upstream connections.
Out of scope: the Kubernetes node itself, the cloud/VPS provider, and the
security of GitHub, DeepWiki or Google.

## Assets and actors

| Asset | Why it matters |
|---|---|
| Upstream credentials (e.g. the GitHub token, the WooCommerce MCP bearer token) | Shared by the whole team; whoever holds one acts as the whole integration |
| Members' API keys and dashboard sessions | Act as that member, and in the audit log |
| The store (orders, customer data) | Reachable only through the WooCommerce MCP server |
| The audit log | The record of who did what |

| Actor | Trust |
|---|---|
| Admin | Trusted to manage servers, members and permissions; still audited |
| Member | Authenticated, may use only the tools they are allowed; not trusted with credentials |
| Upstream MCP server (especially a public one) | **Untrusted**: it supplies tool descriptions and results that reach an LLM |
| Anyone on the internet | Reaches only the Ingress (dashboard, gateway `/mcp`, storefront) |
| A compromised pod | Assumed possible; networking limits what it can reach |

## 1. Shared upstream credentials: what a member can do without seeing them

A member can *use* a server's tools but never learns its credential:

- The credential is stored as a Kubernetes Secret per server in the dedicated
  `urumi-upstreams` namespace. Postgres records only that one exists
  (`has_credential`). The gateway's ServiceAccount can manage Secrets in that
  namespace only (it cannot read `gateway-db`, list pods or touch other
  namespaces); it is the only pod that mounts a ServiceAccount token.
- The REST API never returns a credential, to admins either (the edit form leaves
  the field blank to keep the current one). Members additionally never see an
  upstream's URL. Checked by E2E tests that scan every response.
- The gateway attaches the credential itself when calling the upstream; the member
  only ever holds their own gateway key.

**What a member can still do:** anything the upstream allows that credential to do,
through the tools they may call. That is why the **member default is read-only**
(only tools the upstream marks `readOnlyHint`); write tools need an explicit admin
Allow, per user or for all members, and the GitHub token itself is read-only so
GitHub refuses writes even if allowed. Every call is audited under the member.

## 2. Why client tokens are not passed through to upstreams

The member's gateway key is never forwarded, and the upstream never sees it:

- **Confused deputy / token passthrough.** An upstream could replay a forwarded
  token against the gateway or other servers. A gateway key is valid only for the
  gateway.
- **Credentials of different audiences.** The gateway key means "this person may
  call the gateway"; the upstream credential means "this integration may call
  GitHub". Mixing them would let any upstream operator harvest user tokens.
- **Revocation stays central.** Revoking a gateway key takes effect on the very next
  call because every request re-checks it; an upstream credential is rotated
  separately and never lives in client machines.

## 3. Untrusted upstreams and prompt injection

A malicious or compromised upstream can put instructions in a tool **description**
(read by every client and by the chat model) or in a tool **result** (read by the
model after a call). It can also be slow, huge, or lie about its tools.

| Risk | Control |
|---|---|
| Upstream URL points at an internal target (SSRF: metadata, Postgres, the Kubernetes API) | URLs must resolve to public addresses, checked on save **and** on every connection with the address actually connected to (DNS rebinding); redirects are not followed. Private hosts only via the Helm allowlist, which an admin cannot edit at runtime. `gateway/src/security/ssrf.ts` |
| A compromised gateway reaches internal services | Default-deny ingress **and** egress NetworkPolicies; the gateway may reach the public internet only with private ranges excluded (`helm/templates/networkpolicies.yaml`, proven by `scripts/netpol_matrix.py`) |
| A hanging or flooding upstream | Per-call deadline, result size cap (`MAX_RESULT_BYTES`), health check with its own timeout; other upstreams are unaffected |
| An upstream's tool shadows another's | Every tool is namespaced `<slug>__<tool>`; a server cannot claim another's names |
| A tool description or result tries to steer the chat model into doing something harmful | **Not solved.** Damage is bounded, not prevented: the agent acts with the user's own permissions (read-only for members by default), every call is audited, the GitHub token is read-only, and results are capped at 20k characters. There is no per-call confirmation for destructive tools |
| An upstream returns HTML/script into the UI | Chat answers are rendered as Markdown with no raw HTML; upstream error text is sanitised before it reaches the dashboard |

## 4. What one team member can do to another

| Possible abuse | Outcome |
|---|---|
| Read or use another member's API key | Keys are shown once and stored only as a hash; members list only their own (`prefix`, never the key). Admin cannot read a key either, only revoke it |
| Act as another member | Not possible without their key or password; every call is attributed to the key's owner in the audit log |
| See another member's chat | Chat history lives in each member's browser, not on the server; nothing is shared |
| See another member's audit entries or permissions | Audit log, team and permissions pages and APIs are admin-only (403 for members, enforced server side) |
| Escalate to admin | Roles change only through the admin-only API; the last admin cannot be demoted or disabled, nobody can change their own role |
| Use a tool they were denied | Hidden from `tools/list` and chat, and refused on a direct call (audited `denied`) |
| Cause another member's calls to fail | Per-user rate limits (chat turns, login failures) are keyed by user/IP/email; a shared upstream's own limits are shared, which is an accepted residual risk |
| CSRF from another website | Session cookie is SameSite=Strict, scoped to `/api`; every cookie-authenticated change must carry an allowed `Origin` (fails closed); `/mcp` accepts API keys only |

## 5. Other controls

- **Passwords:** scrypt with a per-password salt, constant-time compare; dummy hash
  for unknown emails; login rate limit (10 failures / 15 min per IP and per email).
- **Sessions and invites:** random 32-byte tokens stored as SHA-256 only; invites
  single-use, 7-day expiry; disabling a user ends their session at once.
- **Pods:** non-root, read-only root filesystem, all capabilities dropped, seccomp,
  no ServiceAccount token (gateway aside); the namespace enforces Pod Security
  `restricted`.
- **Dashboard headers:** CSP `script-src 'self'` (no inline scripts), `frame-ancestors
  'none'`, `X-Content-Type-Options`, `Referrer-Policy: no-referrer`.
- **Audit:** every tool call and every gateway-level `search_tools` call, awaited
  before the reply, with request IDs for correlation.

## 6. Residual risks (honest list)

- **Prompt injection is not solved** (section 3). Mitigations bound the damage.
- **Allow rules are powerful.** An admin who allows a write tool to all members
  accepts the consequences; there is no approval workflow or per-call confirmation.
- **Rate limits are per gateway pod** (in memory); with more replicas an attacker
  gets that many attempts.
- **`/metrics` is unauthenticated** (tool and server names, counts; never
  arguments or results). It is not on the Ingress; a NetworkPolicy decides who in
  the cluster may scrape it.
- **Egress is filtered by IP range, not hostname** (needs an FQDN-aware CNI), so a
  compromised gateway can still reach arbitrary public hosts.
- **Admin actions are not audited** (the brief asks for tool calls). A rogue admin
  can change rules; the tool calls they make are still logged.
- **Credentials rotate on other replicas within about 5 s** (short cache).
- **No image scanning or digest pinning;** the Gemini API key and the WooCommerce
  bearer token are Secrets in the same cluster as the workloads that use them.
- **Local test setup uses plain HTTP**; production values turn on TLS and the
  `Secure` cookie flag, but this has not yet been exercised on a real VPS.
