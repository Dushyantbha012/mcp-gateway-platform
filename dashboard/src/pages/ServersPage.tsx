import { ChevronRight, Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { errorMessage } from "@/api/client";
import { useDeleteServer, useMe, useRefreshServer, useSaveServer, useServers } from "@/api/hooks";
import type { Server } from "@/api/types";
import { ConfirmButton } from "@/components/ConfirmButton";
import { PageHeader } from "@/components/PageHeader";
import { ServerFormDialog } from "@/components/ServerFormDialog";
import { StatusBadge } from "@/components/StatusBadge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { timeAgo } from "@/lib/format";

const AUTH_LABEL = { none: "No auth", bearer: "Bearer token", header: "Custom header" };

function ServerCard({
  server,
  isAdmin,
  onEdit,
}: {
  server: Server;
  isAdmin: boolean;
  onEdit: () => void;
}) {
  const save = useSaveServer();
  const refresh = useRefreshServer();
  const remove = useDeleteServer();
  const fail = (err: unknown) => toast.error(errorMessage(err));

  return (
    <Card data-testid={`server-${server.slug}`}>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="flex items-center gap-2">
            <CardTitle className="text-base">
              <h2>{server.name}</h2>
            </CardTitle>
            <StatusBadge status={server.status} reason={server.lastError} />
          </div>
          <p className="text-xs text-muted-foreground">
            <code>{server.slug}</code>
            {server.url && <> · {server.url}</>}
          </p>
        </div>
        {isAdmin && (
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-2 text-sm">
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
              Enabled
            </label>
            <Button
              variant="outline"
              size="sm"
              disabled={!server.enabled || refresh.isPending}
              onClick={() => refresh.mutate(server.id, { onError: fail })}
              aria-label={`Check ${server.name} now`}
            >
              <RefreshCw className={refresh.isPending ? "animate-spin" : undefined} /> Check
            </Button>
            <Button variant="outline" size="sm" onClick={onEdit} aria-label={`Edit ${server.name}`}>
              <Pencil /> Edit
            </Button>
            <ConfirmButton
              variant="outline"
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
              <Trash2 /> Remove
            </ConfirmButton>
          </div>
        )}
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {server.status === "unreachable" && server.lastError && (
          <p className="rounded-md bg-red-50 px-3 py-2 text-red-800">{server.lastError}</p>
        )}
        <dl className="flex flex-wrap gap-x-6 gap-y-1 text-muted-foreground">
          <div>
            <dt className="inline">Auth: </dt>
            <dd className="inline">
              {AUTH_LABEL[server.authType]}
              {server.authType === "header" &&
                server.authHeaderName &&
                ` (${server.authHeaderName})`}
              {server.hasCredential && " · credential stored"}
            </dd>
          </div>
          <div>
            <dt className="inline">Timeout: </dt>
            <dd className="inline">{server.timeoutMs} ms</dd>
          </div>
          <div>
            <dt className="inline">Last check: </dt>
            <dd className="inline">{server.enabled ? timeAgo(server.lastCheckedAt) : "-"}</dd>
          </div>
        </dl>
        <Collapsible>
          <CollapsibleTrigger className="group flex items-center gap-1 text-sm font-medium">
            <ChevronRight className="size-4 transition-transform group-data-[state=open]:rotate-90" />
            {server.tools.length} {server.tools.length === 1 ? "tool" : "tools"}
          </CollapsibleTrigger>
          <CollapsibleContent>
            <ul className="mt-2 divide-y rounded-md border">
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
          </CollapsibleContent>
        </Collapsible>
      </CardContent>
    </Card>
  );
}

export function ServersPage() {
  const { data: me } = useMe();
  const servers = useServers();
  const isAdmin = me?.role === "admin";
  // undefined = closed, null = adding, a server = editing it
  const [editing, setEditing] = useState<Server | null | undefined>(undefined);

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
      {servers.isPending && <Skeleton className="h-32 w-full" />}
      {servers.isError && <p role="alert">Couldn't load servers: {errorMessage(servers.error)}</p>}
      <div className="space-y-4">
        {servers.data?.map((server) => (
          <ServerCard
            key={server.id}
            server={server}
            isAdmin={isAdmin}
            onEdit={() => setEditing(server)}
          />
        ))}
        {servers.data?.length === 0 && (
          <p className="text-sm text-muted-foreground">No MCP servers registered yet.</p>
        )}
      </div>
      {editing !== undefined && (
        <ServerFormDialog server={editing ?? undefined} onClose={() => setEditing(undefined)} />
      )}
    </>
  );
}
