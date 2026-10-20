import type { ToolHints as Hints } from "@/api/types";

/** The upstream's own description of a tool plus its hints: what it will do, beyond the arguments. */
export function ToolHints({ info }: { info?: Hints | null }) {
  if (!info) return null;
  return (
    <div className="mt-1 space-y-1 text-xs text-muted-foreground">
      {info.description && <p className="line-clamp-4 whitespace-pre-line">{info.description}</p>}
      {(info.destructive || info.idempotent) && (
        <p className="font-medium">
          {info.destructive && <span className="text-destructive">Marked destructive. </span>}
          {info.idempotent && <span>Safe to repeat.</span>}
        </p>
      )}
    </div>
  );
}
