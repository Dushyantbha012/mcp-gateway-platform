import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

/**
 * A native <select> styled like the shadcn Input. Native on purpose: fully
 * accessible and keyboard-friendly out of the box, and simple to drive in
 * tests (Radix Select needs pointer-event polyfills under jsdom).
 */
export function NativeSelect({ className, ...props }: ComponentProps<"select">) {
  return (
    <select
      className={cn(
        "h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive",
        className,
      )}
      {...props}
    />
  );
}
