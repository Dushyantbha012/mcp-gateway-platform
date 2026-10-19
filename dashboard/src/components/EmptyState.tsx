import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { IconBubble } from "@/components/doodles";

/** Shown instead of a bare "nothing here" line: an icon, what's missing, and the next step. */
export function EmptyState(props: {
  icon: LucideIcon;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
}) {
  const Icon = props.icon;
  return (
    <div className="flex flex-col items-center justify-center rounded-3xl border border-dashed border-foreground/20 bg-card/50 px-6 py-10 text-center animate-in fade-in zoom-in-95 duration-300">
      <div className="mb-4">
        <IconBubble>
          <Icon className="size-7" strokeWidth={1.8} aria-hidden />
        </IconBubble>
      </div>
      <h3 className="text-lg font-semibold leading-tight">{props.title}</h3>
      {props.description && (
        <p className="mt-1.5 max-w-sm text-sm text-muted-foreground">{props.description}</p>
      )}
      {props.action && <div className="mt-5">{props.action}</div>}
    </div>
  );
}
