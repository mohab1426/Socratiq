import { Link } from "react-router-dom"
import { CheckCircle2, ChevronRight, GraduationCap } from "lucide-react"
import type { ReviewQueueRow, RiskFocus } from "@/types"
import { relativeTime } from "@/lib/time"
import { Badge } from "@/components/ui/Badge"
import { Panel } from "@/components/ui/Panel"
import { RiskBadge } from "@/components/socratiq/RiskPanel"

export const FOCUS_TEXT: Record<RiskFocus, string> = {
  work_pattern: "Work pattern", verification: "Verification issue", process: "Process record", learning_difficulty: "Learning support",
}

function Status({ r }: { r: ReviewQueueRow }) {
  return r.kind === "risk_review" && r.level ? (
    <RiskBadge level={r.level} />
  ) : (
    <Badge tone="slate" className="gap-1.5 whitespace-nowrap"><GraduationCap className="h-3.5 w-3.5" aria-hidden="true" />Learning support</Badge>
  )
}

const evidenceText = (r: ReviewQueueRow) => (r.evidenceCount === null ? "From verification" : `${r.evidenceCount} evidence signal${r.evidenceCount === 1 ? "" : "s"}`)

/**
 * The main section of the dashboard. Two kinds of row, kept visibly apart: review-level indicators and learning support.
 * Table from md up; stacked tappable cards below that, so nothing needs sideways scrolling on a phone.
 */
/** Where to inspect the underlying work: the student's submission for the assignment behind the signal, else the student overview. */
const workLink = (r: ReviewQueueRow, courseId?: string) =>
  r.assignmentId && courseId ? `/teacher/courses/${courseId}/assignments/${r.assignmentId}/submissions/${r.studentId}` : `/teacher/students/${r.studentId}`

export function AttentionCenter({ rows, disclaimer, courseId }: { rows: ReviewQueueRow[]; disclaimer?: string; courseId?: string }) {
  return (
    <Panel
      id="attention"
      accent
      flush
      title="Needs your review"
      description="Students with a moderate or high review level, or weak understanding in verification. Open one to see the evidence."
      right={rows.length > 0 ? <Badge tone="plum">{rows.length} student{rows.length === 1 ? "" : "s"}</Badge> : undefined}
    >
      {rows.length === 0 ? (
        <div className="flex flex-col items-center px-6 py-10 text-center">
          <span className="mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-[var(--color-success-light)] text-[var(--color-success-ink)]"><CheckCircle2 className="h-5 w-5" aria-hidden="true" /></span>
          <h3 className="text-base font-semibold text-[var(--color-ink)]">No students need review</h3>
          <p className="mt-1 max-w-sm text-sm text-[var(--color-ink-muted)]">There are currently no review indicators requiring your attention. Students with too little recorded activity are not rated.</p>
        </div>
      ) : (
        <>
          {/* Table where there is room: tablets without the sidebar (md) and wide screens (xl). Between lg and xl the sidebar leaves too little width, so the stacked list is used. */}
          <div className="hidden md:block lg:hidden xl:block">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="bg-[var(--color-surface-muted)] text-xs text-[var(--color-ink-muted)]">
                  <th scope="col" className="px-5 py-2.5 font-semibold">Student</th>
                  <th scope="col" className="px-3 py-2.5 font-semibold">Status</th>
                  <th scope="col" className="px-3 py-2.5 font-semibold">Main reason</th>
                  <th scope="col" className="px-3 py-2.5 font-semibold">Evidence</th>
                  <th scope="col" className="hidden px-3 py-2.5 font-semibold xl:table-cell">Last activity</th>
                  <th scope="col" className="px-5 py-2.5"><span className="sr-only">Open</span></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={`${r.kind}-${r.studentId}`} className="border-t border-[var(--color-border)] transition-colors hover:bg-[var(--color-surface-muted)]">
                    <td className="px-5 py-3 font-medium text-[var(--color-ink)]">{r.name}</td>
                    <td className="px-3 py-3"><Status r={r} /></td>
                    <td className="px-3 py-3 text-[var(--color-ink)]">
                      {r.primaryReason ?? "—"}
                      {r.focus && <span className="block text-xs text-[var(--color-ink-muted)]">{FOCUS_TEXT[r.focus]}{r.assignmentTitle ? ` · ${r.assignmentTitle}` : ""}</span>}
                    </td>
                    <td className="whitespace-nowrap px-3 py-3 tabular-nums text-[var(--color-ink-muted)]">{evidenceText(r)}</td>
                    <td className="hidden whitespace-nowrap px-3 py-3 text-[var(--color-ink-muted)] xl:table-cell">{relativeTime(r.lastActivityAt)}</td>
                    <td className="px-5 py-3 text-right">
                      <Link to={workLink(r, courseId)} aria-label={`Review ${r.name}${r.assignmentTitle ? `: ${r.assignmentTitle}` : ""}`} className="inline-flex items-center gap-1 whitespace-nowrap rounded-full border border-[var(--color-border-strong)] bg-white px-3 py-1 text-sm font-medium text-[var(--color-ink)] transition-colors hover:bg-[var(--color-plum-light)]">
                        {r.assignmentId && courseId ? "Review work" : "View student"} <ChevronRight className="h-4 w-4" aria-hidden="true" />
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <ul className="divide-y divide-[var(--color-border)] md:hidden lg:block xl:hidden">
            {rows.map((r) => (
              <li key={`${r.kind}-${r.studentId}`}>
                <Link to={workLink(r, courseId)} className="flex items-center gap-3 px-4 py-3.5 transition-colors hover:bg-[var(--color-surface-muted)]">
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-[var(--color-ink)]">{r.name}</span>
                      <Status r={r} />
                    </span>
                    <span className="mt-1 block text-sm text-[var(--color-ink)]">{r.primaryReason ?? "—"}{r.assignmentTitle ? ` · ${r.assignmentTitle}` : ""}</span>
                    <span className="mt-0.5 block text-xs text-[var(--color-ink-muted)]">{evidenceText(r)} · {relativeTime(r.lastActivityAt)}</span>
                  </span>
                  <ChevronRight className="h-4 w-4 shrink-0 text-[var(--color-ink-muted)]" aria-hidden="true" />
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}
      {disclaimer && <p className="border-t border-[var(--color-border)] px-5 py-2.5 text-xs text-[var(--color-ink-muted)]">{disclaimer}</p>}
    </Panel>
  )
}
