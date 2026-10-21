import {
  Box,
  Clock,
  KeyRound,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  Server as ServerIcon,
  ShieldAlert,
  Timer,
  Trash2,
  Wrench,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useLocation } from "react-router";
import { toast } from "sonner";
import { errorMessage } from "@/api/client";
import {
  useDeleteHosted,
  useDeleteServer,
  useHosted,
  useMe,
  useRefreshServer,
  useRetryHosted,
  useSaveServer,
  useServers,
} from "@/api/hooks";
import type { Hosted, Server, StoreStatus } from "@/api/types";
import { ConfirmButton } from "@/components/ConfirmButton";
import { EmptyState } from "@/components/EmptyState";
import { PageHeader } from "@/components/PageHeader";
import { ServerFormDialog } from "@/components/ServerFormDialog";
import { StatusBadge } from "@/components/StatusBadge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { timeAgo } from "@/lib/format";
import { cn } from "@/lib/utils";

const DOT: Record<Server["status"], string> = {
  connected: "bg-success",
  unreachable: "bg-destructive",
  unknown: "bg-warning",
  disabled: "bg-muted-foreground",
};

function StatusDot({ status }: { status: Server["status"] }) {
  return (
    <span className="relative flex size-2.5 shrink-0" aria-hidden>
      {status === "connected" && (
        <span className="absolute inline-flex size-full animate-ping rounded-full bg-success opacity-60" />
      )}
      <span className={cn("relative inline-flex size-2.5 rounded-full", DOT[status])} />
    </span>
  );
}

const AUTH_LABEL = { none: "No auth", bearer: "Bearer token", header: "Custom header" };

const HOSTED_STATUS: Record<StoreStatus, { label: string; className: string }> = {
  provisioning: { label: "Deploying", className: "bg-warning-soft text-warning" },
  ready: { label: "Running", className: "bg-success-soft text-success" },
  failed: { label: "Deploy failed", className: "bg-danger-soft text-destructive" },
  deleting: { label: "Deleting", className: "bg-muted text-muted-foreground" },
};

/** The provisioner's hosted steps (gateway/src/provisioner/hostedReconciler.ts), in words. */
const HOSTED_STEP: Record<string, string> = {
  queued: "Queued",
  updating: "Queued to redeploy",
  retry: "Retrying",
  namespace: "Creating namespace",
  secrets: "Writing secrets",
  resources: "Creating resources",
  server: "Starting the server",
  register: "Registering with the gateway",
  deleting: "Queued for deletion",
  "deleting-namespace": "Removing namespace",
};

function HostedStatusBadge({ status }: { status: StoreStatus }) {
  const { label, className } = HOSTED_STATUS[status];
  const busy = status === "provisioning" || status === "deleting";
  return (
    <Badge className={cn("gap-1 border-transparent", className)} data-status={status}>
      {busy && <Loader2 className="size-3 animate-spin" aria-hidden />}
      {label}
    </Badge>
  );
}

/** Image, deploy progress or failure reason, and the admin actions for a hosted server. */
function HostedDetails({ hosted, onEdit }: { hosted: Hosted; onEdit: () => void }) {
  const retry = useRetryHosted();
  const remove = useDeleteHosted();
  const fail = (err: unknown) => toast.error(errorMessage(err));
  const step = hosted.step ? (HOSTED_STEP[hosted.step] ?? hosted.step) : "Queued";
  return (
    <div className="space-y-2 text-xs" data-testid={`hosted-${hosted.slug}`}>
      <p className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
        <Box className="size-3.5 shrink-0" aria-hidden />
        <code className="truncate" title={hosted.image}>
          {hosted.image}
        </code>
      </p>
      {hosted.status !== "ready" && (
        <div className="flex items-start gap-2">
          <HostedStatusBadge status={hosted.status} />
          {hosted.status === "failed" ? (
            <span className="text-destructive">{hosted.reason ?? "Failed"}</span>
          ) : (
            <span>
              {step}
              {hosted.reason && (
                <span className="block text-muted-foreground">{hosted.reason}</span>
              )}
            </span>
          )}
        </div>
      )}
      {hosted.status !== "deleting" && (
        <div className="flex items-center gap-1">
          {hosted.status === "failed" && (
            <Button
              variant="ghost"
              size="sm"
              disabled={retry.isPending}
              onClick={() =>
                retry.mutate(hosted.id, {
                  onSuccess: () => toast.success(`Retrying ${hosted.name}`),
                  onError: fail,
                })
              }
            >
              <RotateCcw /> Retry
            </Button>
          )}
          <Button variant="ghost" size="icon" onClick={onEdit} aria-label={`Edit ${hosted.name}`}>
            <Pencil />
          </Button>
          <ConfirmButton
            variant="ghost"
            title={`Delete ${hosted.name}?`}
            description={
              <>
                Its pod, namespace and secret variables are deleted and its tools disappear for
                everyone. Past audit entries are kept.
              </>
            }
            confirmLabel="Delete"
            onConfirm={() =>
              remove.mutate(hosted.id, {
                onSuccess: () => toast.success(`${hosted.name} is being deleted`),
                onError: fail,
              })
            }
          >
            <Trash2 /> <span className="sr-only">Delete {hosted.name}</span>
          </ConfirmButton>
        </div>
      )}
    </div>
  );
}

/** A hosted server the gateway can't route to yet (or any more): not in the servers list. */
function PendingHostedCard({ hosted, onEdit }: { hosted: Hosted; onEdit: () => void }) {
  return (
    <Card data-testid={`server-${hosted.slug}`} className="gap-4">
      <CardHeader className="gap-1">
        <div className="flex items-start justify-between gap-2">
          <CardTitle className="truncate text-base">
            <h2>{hosted.name}</h2>
          </CardTitle>
          <Badge variant="secondary">Hosted</Badge>
        </div>
        <p className="truncate text-xs text-muted-foreground">
          <code>{hosted.slug}</code> · {hosted.transport === "stdio" ? "stdio, bridged" : "HTTP"}
        </p>
      </CardHeader>
      <CardContent>
        <HostedDetails hosted={hosted} onEdit={onEdit} />
      </CardContent>
    </Card>
  );
}

function ServerCard({
  server,
  hosted,
  isAdmin,
  index,
  onEdit,
  onEditHosted,
  onOpen,
}: {
  server: Server;
  /** Its hosted_servers row, for a hosted server (admins only). */
  hosted?: Hosted;
  isAdmin: boolean;
  index: number;
  onEdit: () => void;
  onEditHosted: () => void;
  onOpen: () => void;
}) {
  const save = useSaveServer();
  const refresh = useRefreshServer();
  const remove = useDeleteServer();
  const fail = (err: unknown) => toast.error(errorMessage(err));

  return (
    <Card
      data-testid={`server-${server.slug}`}
      className="group gap-4 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md animate-in fade-in slide-in-from-bottom-2 fill-mode-both"
      style={{ animationDelay: `${Math.min(index, 8) * 50}ms` }}
    >
      <CardHeader className="gap-1">
        <div className="flex items-start justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2.5">
            <StatusDot status={server.status} />
            <CardTitle className="truncate text-base">
              <h2>{server.name}</h2>
            </CardTitle>
          </div>
          <StatusBadge status={server.status} reason={server.lastError} />
        </div>
        <p className="truncate text-xs text-muted-foreground">
          <code>{server.slug}</code>
          {server.url && <> · {server.url}</>}
        </p>
        {server.managedBy && (
          <Badge variant="secondary" className="w-fit">
            {server.managedBy === "store" ? "Managed by Stores" : "Hosted"}
          </Badge>
        )}
      </CardHeader>
      <CardContent className="flex-1 space-y-3 text-sm">
        {server.status === "unreachable" && server.lastError && (
          <p className="flex gap-2 rounded-md bg-danger-soft px-3 py-2 text-xs text-destructive">
            <ShieldAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            <span className="line-clamp-3">{server.lastError}</span>
          </p>
        )}
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs text-muted-foreground">
          <div className="flex items-center gap-1.5">
            <KeyRound className="size-3.5" aria-hidden />
            <dt className="sr-only">Auth</dt>
            <dd className="truncate">
              {AUTH_LABEL[server.authType]}
              {server.hasCredential && " ✓"}
            </dd>
          </div>
          <div className="flex items-center gap-1.5">
            <Timer className="size-3.5" aria-hidden />
            <dt className="sr-only">Timeout</dt>
            <dd>{server.timeoutMs} ms</dd>
          </div>
          <div className="col-span-2 flex items-center gap-1.5">
            <Clock className="size-3.5" aria-hidden />
            <dt className="sr-only">Last check</dt>
            <dd>Checked {server.enabled ? timeAgo(server.lastCheckedAt) : "-"}</dd>
          </div>
        </dl>
        {isAdmin && hosted && <HostedDetails hosted={hosted} onEdit={onEditHosted} />}
      </CardContent>
      <CardFooter className="flex flex-wrap items-center justify-between gap-2 border-t pt-4">
        <Button variant="secondary" size="sm" onClick={onOpen}>
          <Wrench /> {server.tools.length} {server.tools.length === 1 ? "tool" : "tools"}
        </Button>
        {isAdmin && server.managedBy && (
          <Button
            variant="ghost"
            size="icon"
            disabled={!server.enabled || refresh.isPending}
            onClick={() => refresh.mutate(server.id, { onError: fail })}
            aria-label={`Check ${server.name} now`}
          >
            <RefreshCw className={refresh.isPending ? "animate-spin" : undefined} />
          </Button>
        )}
        {isAdmin && !server.managedBy && (
          <div className="flex items-center gap-1">
            <Switch
              checked={server.enabled}
              disabled={save.isPending}
              aria-label={`${server.name} enabled`}
              onCheckedChange={(enabled) =>
                save.mutate(
                  { id: server.id, input: { enabled } },
                  {
                    onSuccess: () =>
                      toast.success(`${server.name} ${enabled ? "enabled" : "disabled"}`),
                    onError: fail,
                  },
                )
              }
            />
            <Button
              variant="ghost"
              size="icon"
              disabled={!server.enabled || refresh.isPending}
              onClick={() => refresh.mutate(server.id, { onError: fail })}
              aria-label={`Check ${server.name} now`}
            >
              <RefreshCw className={refresh.isPending ? "animate-spin" : undefined} />
            </Button>
            <Button variant="ghost" size="icon" onClick={onEdit} aria-label={`Edit ${server.name}`}>
              <Pencil />
            </Button>
            <ConfirmButton
              variant="ghost"
              title={`Remove ${server.name}?`}
              description={
                <>
                  Its tools disappear for everyone at once and its stored credential is deleted.
                  Past audit entries are kept.
                </>
              }
              confirmLabel="Remove"
              onConfirm={() =>
                remove.mutate(server.id, {
                  onSuccess: () => toast.success(`${server.name} removed`),
                  onError: fail,
                })
              }
            >
              <Trash2 /> <span className="sr-only">Remove</span>
            </ConfirmButton>
          </div>
        )}
      </CardFooter>
    </Card>
  );
}

function ServerDrawer({ server, onClose }: { server: Server | undefined; onClose: () => void }) {
  return (
    <Sheet open={server !== undefined} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-md">
        {server && (
          <>
            <SheetHeader>
              <div className="flex items-center gap-2">
                <StatusDot status={server.status} />
                <SheetTitle>{server.name}</SheetTitle>
              </div>
              <SheetDescription>
                <code>{server.slug}</code>
                {server.url && <> · {server.url}</>}
              </SheetDescription>
            </SheetHeader>
            <div className="space-y-4 px-4 pb-6 text-sm">
              <StatusBadge status={server.status} reason={server.lastError} />
              {server.lastError && (
                <p className="rounded-md bg-danger-soft px-3 py-2 text-destructive">
                  {server.lastError}
                </p>
              )}
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-muted-foreground">
                <dt>Auth</dt>
                <dd className="text-foreground">
                  {AUTH_LABEL[server.authType]}
                  {server.authType === "header" &&
                    server.authHeaderName &&
                    ` (${server.authHeaderName})`}
                  {server.hasCredential && " · credential stored"}
                </dd>
                <dt>Timeout</dt>
                <dd className="text-foreground">{server.timeoutMs} ms</dd>
                <dt>Last check</dt>
                <dd className="text-foreground">
                  {server.enabled ? timeAgo(server.lastCheckedAt) : "-"}
                </dd>
              </dl>
              <div>
                <h3 className="mb-2 font-medium">
                  {server.tools.length} {server.tools.length === 1 ? "tool" : "tools"}
                </h3>
                <ul className="divide-y rounded-lg border">
                  {server.tools.map((tool) => (
                    <li key={tool.name} className="px-3 py-2">
                      <code className="text-xs font-medium">{tool.name}</code>
                      {tool.description && (
                        <p className="mt-0.5 text-xs text-muted-foreground">{tool.description}</p>
                      )}
                    </li>
                  ))}
                  {server.tools.length === 0 && (
                    <li className="px-3 py-2 text-xs text-muted-foreground">
                      No tools known yet - they're listed after the first successful check.
                    </li>
                  )}
                </ul>
              </div>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

export function ServersPage() {
  const { data: me } = useMe();
  const servers = useServers();
  const isAdmin = me?.role === "admin";
  const hosted = useHosted(isAdmin);
  // undefined = closed, null = adding, a server = editing it
  const [editing, setEditing] = useState<Server | null | undefined>(undefined);
  const [editingHosted, setEditingHosted] = useState<Hosted | undefined>(undefined);
  const hostedById = new Map((hosted.data?.servers ?? []).map((h) => [h.id, h]));
  const registered = new Set(servers.data?.map((s) => s.id));
  const pending = (hosted.data?.servers ?? []).filter((h) => !registered.has(h.id));
  const [openId, setOpenId] = useState<string | undefined>(undefined);
  const location = useLocation();
  const requested = (location.state as { open?: string } | null)?.open;
  useEffect(() => {
    if (requested) setOpenId(requested);
  }, [requested]);
  const opened = servers.data?.find((s) => s.id === openId);

  return (
    <>
      <PageHeader
        title="MCP servers"
        description="Every enabled, connected server's tools are available through the one gateway endpoint. Status updates every few seconds."
        actions={
          isAdmin && (
            <Button onClick={() => setEditing(null)}>
              <Plus /> Add server
            </Button>
          )
        }
      />
      {servers.isPending && (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-52 w-full rounded-xl" />
          ))}
        </div>
      )}
      {servers.isError && <p role="alert">Couldn't load servers: {errorMessage(servers.error)}</p>}
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {servers.data?.map((server, i) => (
          <ServerCard
            key={server.id}
            server={server}
            hosted={hostedById.get(server.id)}
            isAdmin={isAdmin}
            index={i}
            onEdit={() => setEditing(server)}
            onEditHosted={() => setEditingHosted(hostedById.get(server.id))}
            onOpen={() => setOpenId(server.id)}
          />
        ))}
        {servers.data &&
          pending.map((h) => (
            <PendingHostedCard key={h.id} hosted={h} onEdit={() => setEditingHosted(h)} />
          ))}
      </div>
      {servers.data?.length === 0 && pending.length === 0 && (
        <EmptyState
          icon={ServerIcon}
          title="No MCP servers registered yet."
          description={
            isAdmin
              ? "Use “Add server” above to expose its tools through the gateway."
              : "Ask an admin to register a server."
          }
        />
      )}
      <ServerDrawer server={opened} onClose={() => setOpenId(undefined)} />
      {editing !== undefined && (
        <ServerFormDialog
          server={editing ?? undefined}
          hostedEnabled={hosted.data?.enabled}
          imageAllowlist={hosted.data?.imageAllowlist}
          onClose={() => setEditing(undefined)}
        />
      )}
      {editingHosted && (
        <ServerFormDialog
          hosted={editingHosted}
          imageAllowlist={hosted.data?.imageAllowlist}
          onClose={() => setEditingHosted(undefined)}
        />
      )}
    </>
  );
}
