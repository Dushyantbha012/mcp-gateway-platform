import { toast } from "sonner";
import { errorMessage } from "@/api/client";
import { useConnectedApps, useMeta, useRevokeApp } from "@/api/hooks";
import { ConfirmButton } from "@/components/ConfirmButton";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { timeAgo } from "@/lib/format";

/** MCP clients the user signed in with OAuth, and a way to disconnect each. */
export function ConnectedApps() {
  const meta = useMeta();
  const enabled = meta.data?.oauthEnabled === true;
  const apps = useConnectedApps(enabled);
  const revoke = useRevokeApp();
  if (!enabled) return null;

  return (
    <section className="space-y-3" aria-labelledby="connected-apps">
      <div>
        <h2 id="connected-apps" className="text-lg font-semibold tracking-tight">
          Connected apps
        </h2>
        <p className="text-sm text-muted-foreground">
          MCP clients you signed in to with your gateway account, instead of an API key. Add one
          with just the URL, e.g.{" "}
          <code className="text-xs">
            claude mcp add --transport http gateway {meta.data?.mcpUrl ?? "<gateway>/mcp"}
          </code>
          .
        </p>
      </div>
      <div className="rounded-md border bg-background">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>App</TableHead>
              <TableHead>Access</TableHead>
              <TableHead>Connected</TableHead>
              <TableHead>Last used</TableHead>
              <TableHead className="text-right">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {apps.data?.map((app) => (
              <TableRow key={app.id}>
                <TableCell className="font-medium">{app.clientName}</TableCell>
                <TableCell>
                  {app.scopes.includes("mcp:write") ? (
                    <Badge variant="secondary">Read and change data</Badge>
                  ) : (
                    <Badge variant="outline">Read only</Badge>
                  )}
                </TableCell>
                <TableCell>{timeAgo(app.createdAt)}</TableCell>
                <TableCell>{timeAgo(app.lastUsedAt)}</TableCell>
                <TableCell className="text-right">
                  <ConfirmButton
                    title={`Disconnect ${app.clientName}?`}
                    description="Its access is cut off on its very next call. To use it again, connect it again."
                    confirmLabel="Disconnect"
                    onConfirm={() =>
                      revoke.mutate(app.id, {
                        onSuccess: () => toast.success(`${app.clientName} disconnected`),
                        onError: (err) => toast.error(errorMessage(err)),
                      })
                    }
                  >
                    Disconnect
                  </ConfirmButton>
                </TableCell>
              </TableRow>
            ))}
            {apps.data?.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="text-center text-muted-foreground">
                  No connected apps.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </section>
  );
}
