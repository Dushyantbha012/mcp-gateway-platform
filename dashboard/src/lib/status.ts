import type { AuditOutcome, ServerStatus } from "@/api/types";

/**
 * The brief's three states plus "checking" for a server the health loop
 * hasn't reached yet. The gateway already resolves "disabled wins over the
 * last health result" (displayStatus in gateway/src/upstreams/health.ts).
 * Colours come from the semantic tokens in index.css, so they follow the theme.
 */
const SUCCESS = "bg-success-soft text-success";
const WARNING = "bg-warning-soft text-warning";
const DANGER = "bg-danger-soft text-destructive";
const NEUTRAL = "bg-muted text-muted-foreground";

export const STATUS: Record<ServerStatus, { label: string; className: string }> = {
  connected: { label: "Connected", className: SUCCESS },
  unreachable: { label: "Unreachable", className: DANGER },
  disabled: { label: "Disabled", className: NEUTRAL },
  unknown: { label: "Checking…", className: WARNING },
};

export const OUTCOME: Record<AuditOutcome, { label: string; className: string }> = {
  success: { label: "Success", className: SUCCESS },
  tool_error: { label: "Tool error", className: WARNING },
  timeout: { label: "Timeout", className: DANGER },
  unreachable: { label: "Unreachable", className: DANGER },
  rejected: { label: "Rejected", className: NEUTRAL },
  denied: { label: "Denied", className: "bg-info-soft text-info" },
  held: { label: "Awaiting approval", className: WARNING },
};
