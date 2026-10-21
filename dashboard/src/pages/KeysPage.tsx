import { ConnectedApps } from "@/components/ConnectedApps";
import { KeyManager } from "@/components/KeyManager";
import { PageHeader } from "@/components/PageHeader";

export function KeysPage() {
  return (
    <>
      <PageHeader
        title="API keys"
        description="Your personal keys for MCP clients (Claude Code, Cursor, MCP Inspector). Every call made with a key is logged under your name."
      />
      <div className="space-y-10">
        <KeyManager userId="me" />
        <ConnectedApps />
      </div>
    </>
  );
}
