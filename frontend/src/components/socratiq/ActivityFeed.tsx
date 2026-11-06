import { Link } from "react-router-dom"
import { FileCheck2, RotateCcw, ShieldCheck, MessageCircle } from "lucide-react"
import type { ActivityEntry } from "@/types"
import { cn } from "@/lib/utils"
import { formatWhen } from "@/lib/dates"

const iconFor: Record<ActivityEntry["kind"], typeof FileCheck2> = {
  submission: FileCheck2,
  revision: RotateCcw,
  verification: ShieldCheck,
  coach_session: MessageCircle,
}

const iconTone: Record<ActivityEntry["kind"], string> = {
  submission: "bg-[var(--color-teal-light)] text-[var(--color-teal-dark)]",
  revision: "bg-[var(--color-warning-light)] text-[var(--color-warning-ink)]",
  verification: "bg-[var(--color-success-light)] text-[var(--color-success-ink)]",
  coach_session: "bg-[var(--color-slate-light)] text-[var(--color-ink)]",
}

export interface ActivityFeedEntry extends ActivityEntry {
  studentId?: string
  studentName?: string
}

export function ActivityFeed({ entries, emptyLabel = "No recent activity." }: { entries: ActivityFeedEntry[]; emptyLabel?: string }) {
  if (entries.length === 0) {
    return <p className="text-sm text-[var(--color-ink-muted)]">{emptyLabel}</p>
  }

  return (
    <ul className="space-y-3">
      {entries.map((entry) => {
        const Icon = iconFor[entry.kind]
        const content = (
          <>
            <span className={cn("flex h-7 w-7 shrink-0 items-center justify-center rounded-full", iconTone[entry.kind])}>
              <Icon className="h-3.5 w-3.5" aria-hidden="true" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm text-[var(--color-ink)]">
                {entry.studentName && <span className="font-medium">{entry.studentName} · </span>}
                {entry.assignmentTitle}
              </p>
              <p className="mt-0.5 text-xs text-[var(--color-ink-muted)]">{entry.detail}</p>
              <p className="mt-0.5 text-xs text-[var(--color-ink-muted)]"><time dateTime={entry.date}>{formatWhen(entry.date)}</time></p>
            </div>
          </>
        )
        return (
          <li key={entry.id} className="flex items-start gap-3">
            {entry.studentId ? (
              <Link to={`/teacher/students/${entry.studentId}`} className="flex flex-1 items-start gap-3 rounded-[var(--radius-md)] -m-1.5 p-1.5 transition-colors hover:bg-[var(--color-surface-muted)]">
                {content}
              </Link>
            ) : (
              content
            )}
          </li>
        )
      })}
    </ul>
  )
}
