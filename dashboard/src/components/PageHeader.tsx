import type { ReactNode } from "react";

export function PageHeader(props: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{props.title}</h1>
        {props.description && (
          <p className="mt-1 text-sm text-muted-foreground">{props.description}</p>
        )}
      </div>
      {props.actions && <div className="flex gap-2">{props.actions}</div>}
    </div>
  );
}
