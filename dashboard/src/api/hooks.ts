import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./client";
import type {
  ApiKey,
  AuditEntry,
  AuditFilters,
  Invite,
  McpTool,
  Meta,
  NewApiKey,
  Role,
  Server,
  ServerInput,
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
  meta: ["meta"] as const,
  servers: ["servers"] as const,
  tools: ["tools"] as const,
  users: ["users"] as const,
  userKeys: (userId: string) => ["users", userId, "keys"] as const,
  audit: (filters: AuditFilters) => ["audit", filters] as const,
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
