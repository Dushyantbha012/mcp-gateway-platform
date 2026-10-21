import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./client";
import type {
  ApiKey,
  WriteApproval,
  AuditEntry,
  AuditFilters,
  ConnectedApp,
  EffectiveTool,
  Hosted,
  HostedInput,
  HostedList,
  Invite,
  McpTool,
  Meta,
  NewApiKey,
  OAuthRequest,
  OAuthScope,
  PermissionRule,
  PermissionSubject,
  Role,
  RuleEffect,
  Server,
  ServerInput,
  Store,
  StoreList,
  Stats,
  StatsRange,
  User,
} from "./types";

/**
 * Server state lives in TanStack Query: one cache entry per resource,
 * polled where the brief wants "live" status, and invalidated after every
 * change so the page shows the gateway's answer, not a guess.
 */
export const POLL_MS = 5_000;

export const keys = {
  me: ["me"] as const,
  oauthRequest: (id: string) => ["oauth", "request", id] as const,
  connectedApps: ["oauth", "apps"] as const,
  meta: ["meta"] as const,
  servers: ["servers"] as const,
  stores: ["stores"] as const,
  hosted: ["hosted"] as const,
  tools: ["tools"] as const,
  users: ["users"] as const,
  userKeys: (userId: string) => ["users", userId, "keys"] as const,
  permissions: ["permissions"] as const,
  effective: (subject: PermissionSubject) => ["permissions", "effective", subject] as const,
  audit: (filters: AuditFilters) => ["audit", filters] as const,
  approvals: ["approvals"] as const,
  stats: (range: StatsRange) => ["stats", range] as const,
};

/** The logged-in user; `null` when not logged in (401). */
export function useMe() {
  return useQuery({
    queryKey: keys.me,
    queryFn: () =>
      api<User>("/me").catch((err: { status?: number }) => {
        if (err.status === 401) return null;
        throw err;
      }),
    staleTime: 60_000,
    retry: false,
  });
}

export function useMeta() {
  return useQuery({ queryKey: keys.meta, queryFn: () => api<Meta>("/meta"), staleTime: Infinity });
}

export function useServers() {
  return useQuery({
    queryKey: keys.servers,
    queryFn: () => api<Server[]>("/servers"),
    refetchInterval: POLL_MS,
  });
}

export function useTools() {
  return useQuery({
    queryKey: keys.tools,
    queryFn: () => api<McpTool[]>("/tools"),
    refetchInterval: POLL_MS,
  });
}

export function useUsers(enabled = true) {
  return useQuery({ queryKey: keys.users, queryFn: () => api<User[]>("/users"), enabled });
}

/** `userId` "me" for your own keys. */
export function useUserKeys(userId: string) {
  return useQuery({
    queryKey: keys.userKeys(userId),
    queryFn: () => api<ApiKey[]>(`/users/${userId}/keys`),
  });
}

export function usePermissions() {
  return useQuery({
    queryKey: keys.permissions,
    queryFn: () => api<PermissionRule[]>("/permissions"),
  });
}

const subjectQuery = (subject: PermissionSubject) =>
  new URLSearchParams("userId" in subject ? { userId: subject.userId } : { role: subject.role });

/** What the gateway would show this subject right now, with the reason for each tool. */
export function useEffectivePermissions(subject: PermissionSubject) {
  return useQuery({
    queryKey: keys.effective(subject),
    queryFn: () => api<EffectiveTool[]>(`/permissions/effective?${subjectQuery(subject)}`),
  });
}

/** Admin-only aggregates for the overview; refreshed slower than live server status. */
export function useStats(range: StatsRange, enabled = true) {
  return useQuery({
    queryKey: keys.stats(range),
    queryFn: () => api<Stats>(`/stats?range=${range}`),
    refetchInterval: 30_000,
    enabled,
  });
}

export const AUDIT_PAGE = 50;

export function auditQuery(filters: AuditFilters, before?: string) {
  const params = new URLSearchParams({ limit: String(AUDIT_PAGE) });
  for (const [k, v] of Object.entries(filters)) if (v) params.set(k, v);
  if (before) params.set("before", before);
  return api<AuditEntry[]>(`/audit?${params}`);
}

/** Newest first, paged with the gateway's keyset cursor (`before` = last id seen). */
export function useAudit(filters: AuditFilters, live: boolean) {
  return useInfiniteQuery({
    queryKey: keys.audit(filters),
    queryFn: ({ pageParam }) => auditQuery(filters, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => (last.length === AUDIT_PAGE ? last[last.length - 1].id : undefined),
    refetchInterval: live ? POLL_MS : false,
  });
}

// --- mutations ---

function useInvalidate() {
  const qc = useQueryClient();
  return (...queryKeys: readonly (readonly unknown[])[]) =>
    Promise.all(queryKeys.map((queryKey) => qc.invalidateQueries({ queryKey })));
}

export function useLogin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { email: string; password: string }) =>
      api<User>("/auth/login", { method: "POST", body }),
    onSuccess: (user) => {
      qc.clear(); // nothing from a previous user may linger
      qc.setQueryData(keys.me, user);
    },
  });
}

export function useLogout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<void>("/auth/logout", { method: "POST" }),
    onSettled: () => {
      qc.clear();
      qc.setQueryData(keys.me, null);
    },
  });
}

export function useAcceptInvite(token: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (password: string) =>
      api<User>(`/auth/invites/${encodeURIComponent(token)}/accept`, {
        method: "POST",
        body: { password },
      }),
    onSuccess: (user) => {
      qc.clear();
      qc.setQueryData(keys.me, user);
    },
  });
}

export function useChangePassword() {
  return useMutation({
    mutationFn: (body: { currentPassword: string; newPassword: string }) =>
      api<void>("/me/password", { method: "POST", body }),
  });
}

export function useSaveServer() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ id, input }: { id?: string; input: Partial<ServerInput> }) =>
      id
        ? api<Server>(`/servers/${id}`, { method: "PATCH", body: input })
        : api<Server>("/servers", { method: "POST", body: input }),
    onSuccess: () => invalidate(keys.servers, keys.tools),
  });
}

export function useDeleteServer() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (id: string) => api<void>(`/servers/${id}`, { method: "DELETE" }),
    onSuccess: () => invalidate(keys.servers, keys.tools),
  });
}

export function useRefreshServer() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (id: string) => api<Server>(`/servers/${id}/refresh`, { method: "POST" }),
    onSuccess: () => invalidate(keys.servers, keys.tools),
  });
}

/** Set a rule (allow/deny), or clear it (null) so the target goes back to inheriting. */
export function useSetRule() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: async (v: {
      subject: PermissionSubject;
      serverSlug: string;
      toolName: string | null;
      effect: RuleEffect | null;
      existingId?: string;
    }) => {
      if (v.effect === null) {
        if (v.existingId) await api<void>(`/permissions/${v.existingId}`, { method: "DELETE" });
        return;
      }
      await api("/permissions", {
        method: "PUT",
        body: { ...v.subject, serverSlug: v.serverSlug, toolName: v.toolName, effect: v.effect },
      });
    },
    onSuccess: () => invalidate(keys.permissions, keys.tools),
  });
}

export function useCreateKey(userId: string) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (name: string) =>
      api<NewApiKey>(`/users/${userId}/keys`, { method: "POST", body: { name } }),
    onSuccess: () => invalidate(keys.userKeys(userId)),
  });
}

export function useRevokeKey(userId: string) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (keyId: string) => api<ApiKey>(`/keys/${keyId}`, { method: "DELETE" }),
    onSuccess: () => invalidate(keys.userKeys(userId)),
  });
}

export function useInviteUser() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (body: { email: string; name: string; role: Role }) =>
      api<User & Invite>("/users", { method: "POST", body }),
    onSuccess: () => invalidate(keys.users),
  });
}

export function useReinvite() {
  return useMutation({
    mutationFn: (userId: string) => api<Invite>(`/users/${userId}/invite`, { method: "POST" }),
  });
}

export function useUpdateUser() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({
      id,
      changes,
    }: {
      id: string;
      changes: { name?: string; role?: Role; disabled?: boolean };
    }) => api<User>(`/users/${id}`, { method: "PATCH", body: changes }),
    onSuccess: () => invalidate(keys.users, keys.me),
  });
}

/** The user's pending write requests from MCP clients; polled so a new one shows up while they watch. */
export function useApprovals() {
  return useQuery({
    queryKey: keys.approvals,
    queryFn: () => api<WriteApproval[]>("/approvals"),
    refetchInterval: POLL_MS,
  });
}

export function useDecideApproval() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ id, approve }: { id: string; approve: boolean }) =>
      api<void>(`/approvals/${id}/${approve ? "approve" : "deny"}`, { method: "POST" }),
    onSuccess: () => invalidate(keys.approvals),
  });
}

const STORE_POLL_MS = 3_000;

/** Polled quickly while any store is still changing, slowly otherwise. */
export function useStores() {
  return useQuery({
    queryKey: keys.stores,
    queryFn: () => api<StoreList>("/stores"),
    refetchInterval: (query) =>
      query.state.data?.stores.some((s) => s.status === "provisioning" || s.status === "deleting")
        ? STORE_POLL_MS
        : POLL_MS * 3,
  });
}

export function useCreateStore() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (input: { name: string }) => api<Store>("/stores", { method: "POST", body: input }),
    onSuccess: () => invalidate(keys.stores),
  });
}

export function useDeleteStore() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (id: string) => api<Store>(`/stores/${id}`, { method: "DELETE" }),
    onSuccess: () => invalidate(keys.stores, keys.servers, keys.tools),
  });
}

export function useRetryStore() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (id: string) => api<Store>(`/stores/${id}/retry`, { method: "POST" }),
    onSuccess: () => invalidate(keys.stores),
  });
}

/** Admins only. Polled quickly while any hosted server is still changing. */
export function useHosted(enabled = true) {
  return useQuery({
    queryKey: keys.hosted,
    queryFn: () => api<HostedList>("/hosted"),
    enabled,
    refetchInterval: (query) =>
      query.state.data?.servers.some((s) => s.status === "provisioning" || s.status === "deleting")
        ? STORE_POLL_MS
        : POLL_MS,
  });
}

export function useSaveHosted() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ id, input }: { id?: string; input: Partial<HostedInput> }) =>
      id
        ? api<Hosted>(`/hosted/${id}`, { method: "PATCH", body: input })
        : api<Hosted>("/hosted", { method: "POST", body: input }),
    onSuccess: () => invalidate(keys.hosted),
  });
}

export function useDeleteHosted() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (id: string) => api<Hosted>(`/hosted/${id}`, { method: "DELETE" }),
    onSuccess: () => invalidate(keys.hosted, keys.servers, keys.tools),
  });
}

export function useRetryHosted() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (id: string) => api<Hosted>(`/hosted/${id}/retry`, { method: "POST" }),
    onSuccess: () => invalidate(keys.hosted),
  });
}

export function useOAuthRequest(id: string) {
  return useQuery({
    queryKey: keys.oauthRequest(id),
    queryFn: () => api<OAuthRequest>(`/oauth/requests/${encodeURIComponent(id)}`),
    enabled: id !== "",
    retry: false,
  });
}

/** Approve or deny; the gateway answers with where to send the browser (back to the client). */
export function useDecideOAuth(id: string) {
  return useMutation({
    mutationFn: (body: { approve: boolean; scopes?: OAuthScope[] }) =>
      api<{ redirectUrl: string }>(`/oauth/requests/${encodeURIComponent(id)}`, {
        method: "POST",
        body,
      }),
  });
}

export function useConnectedApps(enabled: boolean) {
  return useQuery({
    queryKey: keys.connectedApps,
    queryFn: () => api<ConnectedApp[]>("/oauth/apps"),
    enabled,
  });
}

export function useRevokeApp() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (id: string) => api<void>(`/oauth/apps/${id}`, { method: "DELETE" }),
    onSuccess: () => invalidate(keys.connectedApps),
  });
}
