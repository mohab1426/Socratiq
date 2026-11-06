import { Link } from "react-router-dom"
import { AlertTriangle, ClipboardCheck, CalendarClock, ChevronRight } from "lucide-react"
import type { AttentionItem } from "@/types"
import { cn } from "@/lib/utils"

const iconFor: Record<AttentionItem["kind"], typeof AlertTriangle> = {
  review: ClipboardCheck,
  signal: AlertTriangle,
  deadline: CalendarClock,
}

const toneStyles: Record<AttentionItem["tone"], string> = {
  warning: "bg-[var(--color-warning-light)] text-[var(--color-warning-ink)]",
  danger: "bg-[var(--color-danger-light)] text-[var(--color-danger-ink)]",
  neutral: "bg-[var(--color-slate-light)] text-[var(--color-ink-muted)]",
}

export function AttentionList({ items, title = "Needs your attention" }: { items: AttentionItem[]; title?: string }) {
  if (items.length === 0) return null

  return (
    <div className="rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-white">
      <div className="flex items-center justify-between border-b border-[var(--color-border)] px-5 py-3.5">
        <h2 className="text-sm font-semibold text-[var(--color-ink)]">{title}</h2>
        <span className="text-xs text-[var(--color-ink-muted)]">{items.length} item{items.length > 1 ? "s" : ""}</span>
      </div>
      <ul className="divide-y divide-[var(--color-border)]">
        {items.map((item) => {
          const Icon = iconFor[item.kind]
          return (
            <li key={item.id}>
              <Link
                to={item.to}
                className="flex items-center gap-3 px-5 py-3.5 transition-colors hover:bg-[var(--color-surface-muted)]"
              >
                <span className={cn("flex h-8 w-8 shrink-0 items-center justify-center rounded-full", toneStyles[item.tone])}>
                  <Icon className="h-4 w-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-[var(--color-ink)]">{item.title}</p>
                  <p className="truncate text-xs text-[var(--color-ink-muted)]">{item.description}</p>
                </div>
                <ChevronRight className="h-4 w-4 shrink-0 text-[var(--color-ink-muted)]" />
              </Link>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
