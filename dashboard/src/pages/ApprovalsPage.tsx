import { CheckCheck } from "lucide-react";
import { toast } from "sonner";
import { useApprovals, useDecideApproval } from "@/api/hooks";
import { EmptyState } from "@/components/EmptyState";
import { PageHeader } from "@/components/PageHeader";
import { ToolHints } from "@/components/ToolHints";
import { Button } from "@/components/ui/button";

export function ApprovalsPage() {
  const approvals = useApprovals();
  const decide = useDecideApproval();
  const items = approvals.data ?? [];

  const answer = (id: string, approve: boolean) =>
    decide.mutate(
      { id, approve },
      {
        onSuccess: () =>
          toast.success(approve ? "Approved. Ask your client to retry." : "Declined."),
        onError: () => toast.error("That request has expired or was already answered."),
      },
    );

  return (
    <>
      <PageHeader
        title="Approvals"
        description="Writes your MCP clients asked for. Nothing runs until you approve it here; after approving, the client retries the same call and it runs once. Requests expire after 10 minutes."
      />
      {items.length === 0 ? (
        <EmptyState
          icon={CheckCheck}
          title="Nothing waiting"
          description="When an MCP client calls a tool that changes data, the request shows up here."
        />
      ) : (
        <ul className="space-y-3">
          {items.map((a) => (
            <li key={a.id} className="space-y-2 rounded-lg border bg-card p-4 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <code className="font-medium">{a.name}</code>
                {a.tool && (
                  <span className="text-xs text-muted-foreground">on {a.tool.server}</span>
                )}
                <span className="ml-auto text-xs text-muted-foreground">
                  asked {new Date(a.createdAt).toLocaleTimeString()}
                </span>
              </div>
              <ToolHints info={a.tool} />
              <pre className="max-h-48 overflow-auto rounded-md bg-muted p-2 font-mono text-xs whitespace-pre-wrap">
                {JSON.stringify(a.args, null, 2)}
              </pre>
              <div className="flex gap-2">
                <Button size="sm" disabled={decide.isPending} onClick={() => answer(a.id, true)}>
                  Approve
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={decide.isPending}
                  onClick={() => answer(a.id, false)}
                >
                  Decline
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
