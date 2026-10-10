import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { ServerStatus } from "@/api/types";
import { STATUS } from "@/lib/status";
import { cn } from "@/lib/utils";

export function StatusBadge({ status, reason }: { status: ServerStatus; reason?: string | null }) {
  const { label, className } = STATUS[status];
  const badge = (
    <Badge className={cn("border-transparent", className)} data-status={status}>
      {label}
    </Badge>
  );
  if (status !== "unreachable" || !reason) return badge;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0} aria-label={`${label}: ${reason}`}>
          {badge}
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-sm">{reason}</TooltipContent>
    </Tooltip>
  );
}
