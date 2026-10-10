import { useMemo, useState } from "react";
import { Link } from "react-router";
import { errorMessage } from "@/api/client";
import { useMeta, useTools } from "@/api/hooks";
import { CopyField } from "@/components/CopyField";
import { PageHeader } from "@/components/PageHeader";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { claudeCodeCommand, slugOfTool } from "@/lib/mcp";

export function ToolsPage() {
  const tools = useTools();
  const meta = useMeta();
  const [search, setSearch] = useState("");
  const mcpUrl = meta.data?.mcpUrl ?? `${window.location.protocol}//<gateway host>/mcp`;

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (tools.data ?? []).filter(
      (t) => !q || t.name.toLowerCase().includes(q) || t.description?.toLowerCase().includes(q),
    );
  }, [tools.data, search]);

  return (
    <>
      <PageHeader
        title="Tools"
        description="Exactly what your MCP client gets from tools/list right now: every enabled, connected server's tools, named <server>__<tool>."
      />
      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="text-base">
            <h2>Connect your MCP client</h2>
          </CardTitle>
          <CardDescription>
            One URL and your own key - no upstream server or credential to configure. Create a key
            on the{" "}
            <Link to="/keys" className="underline">
              API keys
            </Link>{" "}
            page.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          <div className="space-y-1">
            <p className="font-medium">Gateway MCP endpoint (Streamable HTTP)</p>
            <CopyField label="MCP endpoint URL" value={mcpUrl} />
          </div>
          <div className="space-y-1">
            <p className="font-medium">Claude Code</p>
            <CopyField label="Claude Code command" value={claudeCodeCommand(mcpUrl)} />
          </div>
          <p className="text-muted-foreground">
            MCP Inspector / Cursor: transport <strong>Streamable HTTP</strong>, the URL above, and
            the header <code>Authorization: Bearer &lt;your API key&gt;</code>.
          </p>
        </CardContent>
      </Card>

      <div className="mb-3 flex items-center justify-between gap-4">
        <p className="text-sm text-muted-foreground" aria-live="polite">
          {tools.data ? `${shown.length} of ${tools.data.length} tools` : "Loading…"}
        </p>
        <Input
          className="max-w-xs"
          placeholder="Search tools"
          aria-label="Search tools"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      {tools.isError && <p role="alert">Couldn't load tools: {errorMessage(tools.error)}</p>}
      <div className="rounded-md border bg-background">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Tool</TableHead>
              <TableHead>Server</TableHead>
              <TableHead>Description</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {shown.map((tool) => (
              <TableRow key={tool.name}>
                <TableCell>
                  <code className="text-xs">{tool.name}</code>
                </TableCell>
                <TableCell>{slugOfTool(tool.name)}</TableCell>
                <TableCell className="whitespace-normal text-muted-foreground">
                  {tool.description}
                </TableCell>
              </TableRow>
            ))}
            {tools.data && shown.length === 0 && (
              <TableRow>
                <TableCell colSpan={3} className="text-center text-muted-foreground">
                  {tools.data.length === 0
                    ? "No tools available - no enabled server is connected."
                    : "No match."}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </>
  );
}
