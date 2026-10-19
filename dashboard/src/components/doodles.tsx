import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** The gateway logo: a gradient tile with two linked nodes. */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 40 40" className={cn("size-9 shrink-0", className)} aria-hidden fill="none">
      <defs>
        <linearGradient id="logo-fill" x1="4" y1="2" x2="36" y2="38" gradientUnits="userSpaceOnUse">
          <stop stopColor="oklch(0.72 0.17 250)" />
          <stop offset="1" stopColor="oklch(0.55 0.22 285)" />
        </linearGradient>
      </defs>
      <rect x="2" y="2" width="36" height="36" rx="12" fill="url(#logo-fill)" />
      <path
        d="M13 24 L20 14 L27 24"
        stroke="white"
        strokeWidth="2.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity="0.9"
      />
      <circle cx="13" cy="25" r="3.2" fill="white" />
      <circle cx="27" cy="25" r="3.2" fill="white" />
      <circle cx="20" cy="13.5" r="3.2" fill="white" />
    </svg>
  );
}

/** The glowing assistant orb. */
export function Orb({ className }: { className?: string }) {
  return <div className={cn("orb size-28", className)} aria-hidden />;
}

/** A soft rounded icon tile for empty states. */
export function IconBubble({ children }: { children: ReactNode }) {
  return (
    <div className="relative flex size-16 items-center justify-center rounded-3xl bg-gradient-to-br from-[oklch(0.93_0.05_285)] to-[oklch(0.92_0.06_230)] text-[oklch(0.45_0.18_270)] shadow-[0_12px_28px_-12px_oklch(0.5_0.2_270/45%)] ring-1 ring-white/70 dark:from-[oklch(0.32_0.08_285)] dark:to-[oklch(0.3_0.07_235)] dark:text-[oklch(0.85_0.1_270)] dark:ring-white/10">
      {children}
    </div>
  );
}

/** A quiet placeholder line chart for empty chart panels. */
export function ChartDoodle() {
  return (
    <svg
      viewBox="0 0 160 70"
      className="h-14 w-32 text-primary/50"
      aria-hidden
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path
        d="M6 54 C28 54 30 22 52 28 C74 34 76 50 98 40 C120 30 122 12 154 14"
        strokeDasharray="1 7"
      />
      <circle cx="154" cy="14" r="4" fill="currentColor" stroke="none" />
    </svg>
  );
}
