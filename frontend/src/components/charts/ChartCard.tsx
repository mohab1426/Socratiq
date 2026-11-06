import type { ReactNode } from "react"
import { BarChart3 } from "lucide-react"
import { cn } from "@/lib/utils"

export type ChartState = "loading" | "error" | "empty" | "ready"

/** Shared frame for a chart: title, one-line explanation, and consistent loading / error / no-data states. */
export function ChartCard({
  title,
  description,
  state,
  emptyText = "No data available yet",
  emptyHint,
  footnote,
  children,
  className,
}: {
  title: string
  description: string
  state: ChartState
  emptyText?: string
  emptyHint?: string
  footnote?: string
  children: ReactNode
  className?: string
}) {
  return (
    <section className={cn("flex flex-col rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-white p-5", className)}>
      <h3 className="text-sm font-semibold text-[var(--color-ink)]">{title}</h3>
      <p className="mt-0.5 text-xs text-[var(--color-ink-muted)]">{description}</p>

      <div className="mt-4 flex min-h-[13rem] flex-1 flex-col justify-center">
        {state === "loading" && (
          <div role="status" aria-label={`Loading ${title}`} className="space-y-3 motion-safe:animate-pulse">
            {[72, 54, 88, 40].map((w) => (
              <div key={w} className="h-5 rounded-full bg-[var(--color-surface-muted)]" style={{ width: `${w}%` }} />
            ))}
          </div>
        )}
        {state === "error" && <p className="text-center text-sm text-[var(--color-danger-ink)]">Couldn't load this chart. Refresh to try again.</p>}
        {state === "empty" && (
          <div className="flex flex-col items-center py-6 text-center">
            <span className="flex h-10 w-10 items-center justify-center rounded-full bg-[var(--color-surface-muted)] text-[var(--color-ink-muted)]">
              <BarChart3 className="h-5 w-5" aria-hidden="true" />
            </span>
            <p className="mt-3 text-sm font-medium text-[var(--color-ink)]">{emptyText}</p>
            {emptyHint && <p className="mt-1 max-w-xs text-xs text-[var(--color-ink-muted)]">{emptyHint}</p>}
          </div>
        )}
        {state === "ready" && children}
      </div>
      {state === "ready" && footnote && <p className="mt-3 text-xs text-[var(--color-ink-muted)]">{footnote}</p>}
    </section>
  )
}
