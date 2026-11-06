import type { ReactNode } from "react"
import { cn } from "@/lib/utils"

/** Section title used above lists and grids. Sentence case and AA-contrast text (replaces the small all-caps grey labels). */
export function SectionHeading({ children, count, right, className }: { children: ReactNode; count?: number; right?: ReactNode; className?: string }) {
  return (
    <div className={cn("mb-3 mt-8 flex items-baseline justify-between gap-3", className)}>
      <h2 className="text-base font-semibold text-[var(--color-ink)]">
        {children}
        {count !== undefined && <span className="ml-2 text-sm font-normal text-[var(--color-ink-muted)]">{count}</span>}
      </h2>
      {right}
    </div>
  )
}
