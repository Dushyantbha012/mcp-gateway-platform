import { useMemo, useState } from "react";
import { errorMessage } from "@/api/client";
import { useAudit, useServers, useUsers } from "@/api/hooks";
import type { AuditFilters, AuditOutcome, AuditSource } from "@/api/types";
import { OUTCOME } from "@/lib/status";
import { NativeSelect } from "@/components/NativeSelect";
import { PageHeader } from "@/components/PageHeader";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { dateTime, duration } from "@/lib/format";
import { cn } from "@/lib/utils";

export function AuditPage() {
  const [filters, setFilters] = useState<AuditFilters>({});
  const [live, setLive] = useState(true);
  const audit = useAudit(filters, live);
  const users = useUsers();
  const servers = useServers();
  const entries = useMemo(() => audit.data?.pages.flat() ?? [], [audit.data]);
  const set = (patch: Partial<AuditFilters>) => setFilters((f) => ({ ...f, ...patch }));

  return (
    <>
      <PageHeader
        title="Audit log"
        description="Every tool call through the gateway - from MCP clients and the chat agent - with who made it, where it went, how long it took and how it ended."
        actions={
          <label className="flex items-center gap-2 text-sm">
            <Switch checked={live} onCheckedChange={setLive} aria-label="Live updates" />
            Live
          </label>
        }
      />
      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <NativeSelect
          aria-label="Filter by user"
          value={filters.userId ?? ""}
          onChange={(e) => set({ userId: e.target.value || undefined })}
        >
          <option value="">All users</option>
          {users.data?.map((u) => (
            <option key={u.id} value={u.id}>
              {u.email}
            </option>
          ))}
        </NativeSelect>
        <NativeSelect
          aria-label="Filter by server"
          value={filters.server ?? ""}
          onChange={(e) => set({ server: e.target.value || undefined })}
        >
          <option value="">All servers</option>
          {servers.data?.map((s) => (
            <option key={s.id} value={s.slug}>
              {s.slug}
            </option>
          ))}
        </NativeSelect>
        <NativeSelect
          aria-label="Filter by outcome"
          value={filters.outcome ?? ""}
          onChange={(e) =>
            set({ outcome: (e.target.value || undefined) as AuditOutcome | undefined })
          }
        >
          <option value="">All outcomes</option>
          {Object.entries(OUTCOME).map(([value, { label }]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </NativeSelect>
        <NativeSelect
          aria-label="Filter by source"
          value={filters.source ?? ""}
          onChange={(e) =>
            set({ source: (e.target.value || undefined) as AuditSource | undefined })
          }
        >
          <option value="">All sources</option>
          <option value="mcp">MCP client</option>
          <option value="chat">Chat agent</option>
        </NativeSelect>
      </div>
      {audit.isError && (
        <p role="alert">Couldn't load the audit log: {errorMessage(audit.error)}</p>
      )}
      <div className="rounded-md border bg-background">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Time</TableHead>
              <TableHead>User</TableHead>
              <TableHead>Source</TableHead>
              <TableHead>Server</TableHead>
              <TableHead>Tool</TableHead>
              <TableHead className="text-right">Duration</TableHead>
              <TableHead>Outcome</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {entries.map((e) => (
              <TableRow key={e.id} data-testid="audit-row">
                <TableCell className="whitespace-nowrap">{dateTime(e.ts)}</TableCell>
                <TableCell>{e.userEmail}</TableCell>
                <TableCell>{e.source === "chat" ? "Chat" : "MCP"}</TableCell>
                <TableCell>{e.server ?? "-"}</TableCell>
                <TableCell>
                  <code className="text-xs">{e.tool}</code>
                </TableCell>
                <TableCell className="text-right tabular-nums">{duration(e.durationMs)}</TableCell>
                <TableCell className="whitespace-normal">
                  <Badge className={cn("border-transparent", OUTCOME[e.outcome].className)}>
                    {OUTCOME[e.outcome].label}
                  </Badge>
                  {e.error && (
                    <p className="mt-1 max-w-xs text-xs text-muted-foreground">{e.error}</p>
                  )}
                </TableCell>
              </TableRow>
            ))}
            {audit.data && entries.length === 0 && (
              <TableRow>
                <TableCell colSpan={7} className="text-center text-muted-foreground">
                  No tool calls match.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
      {audit.hasNextPage && (
        <div className="mt-4 flex justify-center">
          <Button
            variant="outline"
            onClick={() => audit.fetchNextPage()}
            disabled={audit.isFetchingNextPage}
          >
            {audit.isFetchingNextPage ? "Loading…" : "Load older entries"}
          </Button>
        </div>
      )}
    </>
  );
}
