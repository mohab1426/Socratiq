import type { ReactNode } from "react"
import { Card } from "@/components/ui/Card"
import { cn } from "@/lib/utils"

/** One number that is counted from real rows. `hint` is visible helper text (not a hover-only tooltip); `emphasis` marks the number that asks for action. */
export function MetricCard({ value, label, hint, percent, tone = "teal-dark", icon, emphasis }: { value: string; label: string; hint?: string; percent?: number; tone?: "teal-dark" | "clay"; icon?: ReactNode; emphasis?: boolean }) {
  return (
    <Card className={cn("p-4 shadow-[var(--shadow-panel)]", emphasis && "border-[var(--color-plum)] bg-[var(--color-plum-light)]/50")}>
      <div className="flex items-center justify-between gap-2">
        <p className="min-w-0 text-sm text-[var(--color-ink-muted)]">{label}</p>
        {icon && <span className="shrink-0 text-[var(--color-teal-dark)]" aria-hidden="true">{icon}</span>}
      </div>
      <p className="mt-2 text-3xl font-semibold tabular-nums text-[var(--color-ink)]">{value}</p>
      {hint && <p className="mt-1 text-xs text-[var(--color-ink-muted)]">{hint}</p>}
      {percent !== undefined && (
        <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-[var(--color-surface-muted)]" aria-hidden="true">
          <div className="h-full rounded-full transition-[width] duration-700 motion-reduce:transition-none" style={{ width: `${Math.min(Math.max(percent, 0), 100)}%`, background: `var(--color-${tone})` }} />
        </div>
      )}
    </Card>
  )
}
