import { useMemo, useState } from "react";
import { errorMessage } from "@/api/client";
import { useAudit, useServers, useUsers } from "@/api/hooks";
import type { AuditFilters, AuditOutcome, AuditSource } from "@/api/types";
import { OUTCOME } from "@/lib/status";
import { NativeSelect } from "@/components/NativeSelect";
import { PageHeader } from "@/components/PageHeader";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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

const SOURCE_LABELS: Record<AuditSource, string> = { mcp: "MCP", chat: "Chat", dashboard: "Dashboard" };

export function AuditPage() {
  const [filters, setFilters] = useState<AuditFilters>({});
  const [live, setLive] = useState(true);
  const audit = useAudit(filters, live);
  const users = useUsers();
  const servers = useServers();
  const entries = useMemo(() => audit.data?.pages.flat() ?? [], [audit.data]);
  const set = (patch: Partial<AuditFilters>) => setFilters((f) => ({ ...f, ...patch }));
  const [requestIdText, setRequestIdText] = useState("");

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
      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-5">
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
          <option value="dashboard">Dashboard</option>
        </NativeSelect>
        <Input
          aria-label="Filter by request ID"
          placeholder="Request ID"
          value={requestIdText}
          onChange={(e) => {
            const text = e.target.value.trim();
            setRequestIdText(e.target.value);
            // Only well-formed IDs reach the gateway, which rejects the rest.
            set({ requestId: /^[A-Za-z0-9._-]{1,128}$/.test(text) ? text : undefined });
          }}
        />
      </div>
      {audit.isError && (
        <p role="alert">Couldn't load the audit log: {errorMessage(audit.error)}</p>
      )}
      <div className="overflow-hidden rounded-xl border bg-card shadow-xs">
        <Table className="stack-table">
          <TableHeader>
            <TableRow>
              <TableHead>Time</TableHead>
              <TableHead>User</TableHead>
              <TableHead>Source</TableHead>
              <TableHead>Server</TableHead>
              <TableHead>Tool</TableHead>
              <TableHead>Request ID</TableHead>
              <TableHead className="text-right">Duration</TableHead>
              <TableHead>Outcome</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {entries.map((e) => (
              <TableRow key={e.id} data-testid="audit-row">
                <TableCell data-label="Time" className="whitespace-nowrap">
                  {dateTime(e.ts)}
                </TableCell>
                <TableCell data-label="User">{e.userEmail}</TableCell>
                <TableCell data-label="Source">{SOURCE_LABELS[e.source]}</TableCell>
                <TableCell data-label="Server">{e.server ?? "-"}</TableCell>
                <TableCell data-label="Tool">
                  <code className="text-xs">{e.tool}</code>
                  {e.detail && (
                    <p className="mt-1 max-w-xs text-xs text-muted-foreground">{e.detail}</p>
                  )}
                </TableCell>
                <TableCell data-label="Request ID">
                  {e.requestId ? (
                    <code className="text-xs" title={e.requestId}>
                      {e.requestId.slice(0, 8)}
                    </code>
                  ) : (
                    "-"
                  )}
                </TableCell>
                <TableCell data-label="Duration" className="text-right tabular-nums">
                  {duration(e.durationMs)}
                </TableCell>
                <TableCell data-label="Outcome" className="whitespace-normal">
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
                <TableCell colSpan={8} className="text-center text-muted-foreground">
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
