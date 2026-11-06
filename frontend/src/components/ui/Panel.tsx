import type { ReactNode } from "react"
import { cn } from "@/lib/utils"

/**
 * The one container for every section on the teacher pages: white surface, hairline border, radius-lg, a barely-there shadow.
 * Header = title (+ optional description and right-hand slot). `id` gives an in-page anchor and labels the region.
 * `accent` adds a brand-coloured left edge; use it for at most one panel per page (the one that asks for action).
 */
export function Panel({ id, title, description, right, children, className, accent, flush }: {
  id?: string
  title: ReactNode
  description?: ReactNode
  right?: ReactNode
  children: ReactNode
  className?: string
  accent?: boolean
  /** No inner padding: for tables and lists that run edge to edge. */
  flush?: boolean
}) {
  const heading = id ? `${id}-heading` : undefined
  return (
    <section id={id} aria-labelledby={heading} className={cn("scroll-mt-20 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-white shadow-[var(--shadow-panel)]", accent && "border-l-4 border-l-[var(--color-plum)]", className)}>
      <header className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1 border-b border-[var(--color-border)] px-5 py-3.5">
        <div className="min-w-0">
          <h2 id={heading} className="text-base font-semibold text-[var(--color-ink)]">{title}</h2>
          {description && <p className="mt-0.5 text-sm text-[var(--color-ink-muted)]">{description}</p>}
        </div>
        {right}
      </header>
      <div className={cn(!flush && "px-5 py-4")}>{children}</div>
    </section>
  )
}
