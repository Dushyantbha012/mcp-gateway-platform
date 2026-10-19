import type { ReactNode } from "react";

export function PageHeader(props: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-8 flex flex-wrap items-end justify-between gap-4 animate-in fade-in slide-in-from-bottom-1 duration-300">
      <div className="min-w-0">
        <h1 className="text-3xl font-semibold leading-tight tracking-tight sm:text-4xl">
          {props.title}
        </h1>
        {props.description && (
          <p className="mt-1.5 max-w-xl text-[15px] leading-relaxed text-muted-foreground">
            {props.description}
          </p>
        )}
      </div>
      {props.actions && <div className="flex flex-wrap gap-2">{props.actions}</div>}
    </div>
  );
}
