import type { ReactNode } from "react"
import { Link } from "react-router-dom"
import { Badge } from "@/components/ui/Badge"
import { DueDate } from "@/components/socratiq/DueDate"
import { assignmentStatusLabel, isDone } from "@/lib/assignments"
import type { AssignmentStatus } from "@/types"

const statusTone: Record<AssignmentStatus, "neutral" | "warning" | "teal" | "success"> = {
  not_started: "neutral",
  in_progress: "warning",
  submitted: "teal",
  verified: "success",
}

const rowClass =
  "flex items-center justify-between gap-4 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-white px-4 py-3.5 transition-colors hover:border-[var(--color-border-strong)] hover:bg-[var(--color-surface-muted)]"

export function AssignmentRow({
  to,
  title,
  topic,
  status,
  badge,
  dueDate,
  done,
}: {
  to: string
  title: string
  topic: string
  status?: AssignmentStatus
  /** Replaces the student-progress badge (e.g. Draft / Published for instructors). */
  badge?: ReactNode
  /** `undefined` hides the due-date line; `null` shows "No due date". */
  dueDate?: string | null
  /** Work already handed in, so the deadline is shown as met rather than as a warning. */
  done?: boolean
}) {
  return (
    <Link to={to} className={rowClass}>
      <div className="min-w-0">
        <p className="truncate font-medium text-[var(--color-ink)]">{title}</p>
        <p className="truncate text-sm text-[var(--color-ink-muted)]">{topic}</p>
        {dueDate !== undefined && (
          <div className="mt-1.5">
            <DueDate dueDate={dueDate} done={done ?? isDone(status)} />
          </div>
        )}
      </div>
      {badge ?? (status && <Badge tone={statusTone[status]}>{assignmentStatusLabel[status]}</Badge>)}
    </Link>
  )
}

export function MaterialRow({ to, title, summary, badge }: { to: string; title: string; summary: string; badge?: ReactNode }) {
  return (
    <Link to={to} className={rowClass}>
      <div className="min-w-0">
        <p className="truncate font-medium text-[var(--color-ink)]">{title}</p>
        <p className="truncate text-sm text-[var(--color-ink-muted)]">{summary}</p>
      </div>
      {badge ?? <Badge tone="slate">Material</Badge>}
    </Link>
  )
}
