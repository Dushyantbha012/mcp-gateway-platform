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
| A tool description or result tries to steer the chat model into doing something harmful | **Not solved.** Damage is bounded, not prevented: the agent acts with the user's own permissions (read-only for members by default), every call is audited, the GitHub token is read-only, and results are capped at 20k characters. Neither the chat agent nor an MCP client can run a write tool on its own: the gateway holds it until the user approves that exact call (same user, tool and arguments, single use, 10 minutes) in the dashboard, and an API key can't approve, so injected text can't make a change without a click |
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
| CSRF from another website | Session cookie is SameSite=Strict, scoped to `/api`; every cookie-authenticated change must carry an allowed `Origin` (fails closed); `/mcp` takes bearer tokens (API keys or OAuth access tokens), never cookies |

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

## 7. Provisioned stores and the provisioner

New actor: **any member** can now cause namespaces to be created, and a new
component, the provisioner, holds a ClusterRole to do it.

| Threat | Control |
|---|---|
| The provisioner's ClusterRole is a high-value target (it creates namespaces and Secrets cluster-wide) | It is a separate pod with its own ServiceAccount; the gateway, which faces users and MCP clients, keeps its namespace-scoped Role. The provisioner has no ingress at all, and egress only to Postgres and the API server. It refuses any namespace that lacks the label it put there itself (`urumi.ai/managed-by=provisioner`), so a bad row cannot make it delete `kube-system` or `urumi`. Its verbs are listed in `helm/charts/gateway/templates/provisioner.yaml`: `delete` only on namespaces, Secrets, Jobs and NetworkPolicies |
| A member creates stores until the cluster is full | At most 2 per user, checked in a transaction under a row lock; a ResourceQuota per namespace; a deadline that fails a stuck store. Admins can delete any store |
| One store reads another's data | Namespace per store, default-deny NetworkPolicies both ways, allow rules only within the namespace plus the gateway's pods to the MCP server; proven by `verify-phase10.sh` |
| A member edits a store's server row to point it elsewhere | Managed rows (`managed_by`) cannot be edited or deleted through the servers API (409); the SSRF guard accepts only the exact in-cluster address the row implies |
| A store name collides with, or steals, an existing server's tool names | The slug must be unique across stores and servers, and tools are namespaced by slug |
| Deleting a store leaves data or credentials behind | Row, credential and tools go first, then the namespace; volumes go with it; the `stores` row is removed only after the namespace is gone |
| Passwords of a store survive a reconcile or leak | Generated once, only if absent; stored in Secrets in the store's namespace, never in Postgres |

## 8. Hosted MCP servers (untrusted code)

An admin deploys an image; the image is **untrusted code** that will run inside
the cluster, handle the credentials it is given, and answer tool calls that reach
an LLM.

| Threat | Control |
|---|---|
| A malicious or typo-squatted image | Registry allowlist (`hosted.imageAllowlist`) and pinned references: `:latest` and untagged images are refused, and refusals are audited. Only admins can deploy |
| The container attacks the node or the cluster | Pod Security `restricted` (non-root, read-only root filesystem, all capabilities dropped, seccomp), no ServiceAccount token, a ResourceQuota, its own namespace |
| It reaches internal services (Postgres, stores, the Kubernetes API, the metadata endpoint) | Default-deny NetworkPolicies. Ingress only from the gateway's pods. Egress DNS only, or public internet minus the cluster, pod and service ranges and `169.254.169.254`. `verify-hosted.sh` probes each target from inside the pod |
| It exfiltrates the secrets it was given | Not prevented for a server with internet egress: it can send its own environment anywhere public. Mitigated by choosing `egress: none` where the server does not need the internet, giving it only the credentials it needs, and rotating them |
| Its tool descriptions and results try to steer the model | Same as any upstream (section 3): bounded by the user's permissions, approval for writes, audit |
| Secret environment values leak through the API, Postgres or logs | They go straight to a Kubernetes Secret; Postgres and API responses hold names only; the verify script searches Postgres and the audit log for the value |
| The stdio bridge is an open door | It requires a bearer token (generated per server) and is reachable only from the gateway's pods |

## 9. OAuth for MCP clients

New actors: **MCP clients that registered themselves** (anyone can register) and
**the redirect target** a client names.

| Threat | Control |
|---|---|
| A malicious site registers as a trusted-looking app and phishes consent | Registration is open by design (RFC 7591) but grants nothing: the user must approve on the consent page, which shows the app's name, the account it will act as, where the browser is sent next (and says when that is an app on this computer), and what it wants. Redirect URIs must be https or loopback. Residual risk: the app name is self-declared, so the page tells users to approve only apps they started connecting |
| Redirect hijack: a code sent to the attacker | Exact redirect URI match against the registered URIs (loopback port may vary, RFC 8252); an unknown client or unmatched URI gets a plain error page, never a redirect |
| Code interception | PKCE S256 is mandatory (`plain` is refused); the code is single use, expires in 10 minutes, and is bound to client and redirect URI; reuse revokes what it issued |
| Refresh token theft | Tokens rotate on every use; reusing a rotated token revokes the whole grant, so a thief and the real client cannot both keep going; refresh tokens are bound to their client; stored only as hashes |
| Token audience confusion (a token for another service used here, or the reverse) | Every token carries its resource (RFC 8707); `/mcp` rejects another audience; the gateway never forwards a client token to an upstream (section 2) |
| An OAuth token does more than the user could | Scopes only narrow: `mcp:read` hides and refuses write tools even for admins, and the role's own permissions still apply on top. Held writes still need the user's approval |
| A token approves something itself | `/api/oauth/*` accepts dashboard sessions only (no API keys, no OAuth tokens) and enforces the Origin check, so a client cannot approve its own request |
| Cross-site request approving a consent | The consent decision is a session POST that must carry an allowed Origin; the request id is a random UUID, single use |
| Token endpoint brute force or registration flooding | 30 failures per IP per 15 minutes on `/oauth/token`; 20 registrations per IP per hour; both in memory per pod (as in section 6). The client IP comes from `TRUST_PROXY_HOPS` |
| A leaked access token | Lifetime 1 hour; the user can disconnect the app (Connected apps) and the next request fails; revocation by token (RFC 7009) works for the client too |
| Open CORS on the OAuth and `/mcp` endpoints | Needed by browser clients such as MCP Inspector. They carry no cookies (`ACAO *` without credentials); every route needs a bearer token or is a public discovery document |
| Audit gaps | Approve, deny and disconnect are audit rows; tool calls are attributed to the user, with no API key |

## 6. Residual risks (honest list)

- **Prompt injection is not solved** (section 3). Mitigations bound the damage.
- **Allow rules are powerful.** An admin who allows a write tool to all members
  accepts the consequences, although every write still waits for the user's approval. That prompt shows the arguments and the upstream's own description of the tool, so it is only as honest as the upstream; an MCP client must retry after approval.
- **Rate limits are per gateway pod** (in memory); with more replicas an attacker
  gets that many attempts.
- **`/metrics` is unauthenticated** (tool and server names, counts; never
  arguments or results). It is not on the Ingress; a NetworkPolicy decides who in
  the cluster may scrape it.
- **Egress is filtered by IP range, not hostname** (needs an FQDN-aware CNI), so a
  compromised gateway can still reach arbitrary public hosts.
- **Most admin actions are not audited** (the brief asks for tool calls). A rogue admin
  can change rules; the tool calls they make are still logged. Store, hosted-server
  and OAuth actions are the exception: they are audit rows.
- **Credentials rotate on other replicas within about 5 s** (short cache).
- **No image scanning;** hosted images are pinned but not scanned, and the chart's own images are not digest-pinned; the Groq and Gemini API keys and the WooCommerce
  bearer token are Secrets in the same cluster as the workloads that use them.
- **A hosted server with internet egress can exfiltrate whatever it was given**
  (section 8), and a provisioned store's MCP server is trusted code from this repo.
- **OAuth app names are self-declared.** The consent page shows where the browser
  goes next, but a user who approves an app they did not start gives it their
  access (read-only unless they allow writes, and writes still need approval).
- **Open registration** means anyone who can reach the gateway can create client
  records; they are rate limited per pod and hold no access until approved.
- **Local test setup uses plain HTTP**; production values turn on TLS and the
  `Secure` cookie flag, but this has not yet been exercised on a real VPS.
