import type { AuditOutcome, ServerStatus } from "@/api/types";

/**
 * The brief's three states plus "checking" for a server the health loop
 * hasn't reached yet. The gateway already resolves "disabled wins over the
 * last health result" (displayStatus in gateway/src/upstreams/health.ts).
 */
export const STATUS: Record<ServerStatus, { label: string; className: string }> = {
  connected: { label: "Connected", className: "bg-emerald-100 text-emerald-800" },
  unreachable: { label: "Unreachable", className: "bg-red-100 text-red-800" },
  disabled: { label: "Disabled", className: "bg-zinc-200 text-zinc-700" },
  unknown: { label: "Checking…", className: "bg-amber-100 text-amber-800" },
};

export const OUTCOME: Record<AuditOutcome, { label: string; className: string }> = {
  success: { label: "Success", className: "bg-emerald-100 text-emerald-800" },
  tool_error: { label: "Tool error", className: "bg-amber-100 text-amber-800" },
  timeout: { label: "Timeout", className: "bg-red-100 text-red-800" },
  unreachable: { label: "Unreachable", className: "bg-red-100 text-red-800" },
  rejected: { label: "Rejected", className: "bg-zinc-200 text-zinc-700" },
  denied: { label: "Denied", className: "bg-orange-100 text-orange-800" },
};
