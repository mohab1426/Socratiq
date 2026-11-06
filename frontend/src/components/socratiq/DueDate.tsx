import { AlertCircle, CalendarDays, CheckCircle2, Clock } from "lucide-react"
import { cn } from "@/lib/utils"
import { dueInfo, type DueState } from "@/lib/dates"

const styles: Record<DueState, string> = {
  none: "text-[var(--color-ink-muted)]",
  upcoming: "bg-[var(--color-teal-light)] text-[var(--color-teal-dark)]",
  soon: "bg-[var(--color-plum-light)] text-[var(--color-ink)] ring-1 ring-inset ring-[var(--color-plum)]/60 font-semibold",
  overdue: "bg-[var(--color-danger-light)] text-[var(--color-danger-ink)] ring-1 ring-inset ring-[var(--color-danger)]/40 font-semibold",
  done: "bg-[var(--color-success-light)] text-[var(--color-success-ink)]",
}
const icons: Record<DueState, typeof Clock> = { none: CalendarDays, upcoming: CalendarDays, soon: Clock, overdue: AlertCircle, done: CheckCircle2 }
const stateName: Record<DueState, string> = { none: "", upcoming: "", soon: "Due soon. ", overdue: "Overdue. ", done: "Completed. " }

/**
 * Due date with its own visual treatment. State is never carried by colour alone: each state has its own icon and wording.
 * `done` = the student has already submitted, so the deadline stops being a warning.
 */
export function DueDate({ dueDate, done = false, className }: { dueDate: string | null | undefined; done?: boolean; className?: string }) {
  const info = dueInfo(dueDate, done)
  const Icon = icons[info.state]
  return (
    <span
      title={info.full ? `${stateName[info.state]}${info.full}` : undefined}
      className={cn("inline-flex max-w-full items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium", styles[info.state], info.state === "none" && "px-0", className)}
    >
      <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      {info.iso ? (
        <time dateTime={info.iso} className="truncate">
          <span className="sr-only">{stateName[info.state]}</span>
          {info.label}
        </time>
      ) : (
        <span className="truncate">{info.label}</span>
      )}
    </span>
  )
}
