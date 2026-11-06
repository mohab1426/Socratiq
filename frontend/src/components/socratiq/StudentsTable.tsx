import { Link } from "react-router-dom"
import { ChevronRight } from "lucide-react"
import type { StudentRow } from "@/types"
import { MasteryBadge } from "@/components/socratiq/MasteryBadge"
import { RiskBadge } from "@/components/socratiq/RiskPanel"
import { relativeTime } from "@/lib/time"

/** Thin proportion bar next to a percentage: makes a column of numbers scannable. */
function Meter({ value }: { value: number }) {
  return (
    <div className="flex items-center gap-2.5">
      <span className="w-10 shrink-0 tabular-nums text-[var(--color-ink)]">{value}%</span>
      <div className="hidden h-1.5 w-16 overflow-hidden rounded-full bg-[var(--color-surface-muted)] lg:block" aria-hidden="true">
        <div className="h-full rounded-full bg-[var(--color-teal-dark)]" style={{ width: `${Math.min(Math.max(value, 0), 100)}%` }} />
      </div>
    </div>
  )
}

/** Class roster. Table from md up, tappable cards below. Every value is one of the fields the dashboard API returns. */
export function StudentsTable({ students }: { students: StudentRow[] }) {
  return (
    <>
      <div className="hidden overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-white shadow-[var(--shadow-panel)] md:block">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="bg-[var(--color-surface-muted)] text-xs text-[var(--color-ink-muted)]">
              <th scope="col" className="px-5 py-2.5 font-semibold">Student</th>
              <th scope="col" className="px-3 py-2.5 font-semibold">Review level</th>
              <th scope="col" className="px-3 py-2.5 font-semibold">Task submission</th>
              <th scope="col" className="px-3 py-2.5 font-semibold">Coach use</th>
              <th scope="col" className="px-3 py-2.5 font-semibold">Mastery</th>
              <th scope="col" className="hidden px-3 py-2.5 font-semibold xl:table-cell">Last activity</th>
              <th scope="col" className="px-4 py-2.5"><span className="sr-only">Open</span></th>
            </tr>
          </thead>
          <tbody>
            {students.map((s) => (
              <tr key={s.id} className="border-t border-[var(--color-border)] transition-colors hover:bg-[var(--color-surface-muted)]">
                <td className="p-0 font-medium text-[var(--color-ink)]">
                  <Link to={`/teacher/students/${s.id}`} className="block px-5 py-3 hover:text-[var(--color-teal-dark)] hover:underline">{s.name}</Link>
                </td>
                <td className="px-3 py-3"><RiskBadge level={s.risk.level} label={s.risk.levelLabel} /></td>
                <td className="px-3 py-3"><Meter value={s.taskSubmission} /></td>
                <td className="px-3 py-3"><Meter value={s.socraticAiUsage} /></td>
                <td className="px-3 py-3"><MasteryBadge level={s.mastery} /></td>
                <td className="hidden whitespace-nowrap px-3 py-3 text-[var(--color-ink-muted)] xl:table-cell">{relativeTime(s.risk.lastActivityAt)}</td>
                <td className="w-10 px-4 py-3">
                  <Link to={`/teacher/students/${s.id}`} aria-label={`View ${s.name}`} className="inline-flex h-8 w-8 items-center justify-center rounded-full hover:bg-[var(--color-surface-muted)]"><ChevronRight className="h-4 w-4 text-[var(--color-ink-muted)]" aria-hidden="true" /></Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <ul className="space-y-2 md:hidden">
        {students.map((s) => (
          <li key={s.id}>
            <Link to={`/teacher/students/${s.id}`} className="block rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-white p-4 shadow-[var(--shadow-panel)] transition-colors hover:bg-[var(--color-surface-muted)]">
              <span className="flex items-start justify-between gap-2">
                <span className="font-medium text-[var(--color-ink)]">{s.name}</span>
                <RiskBadge level={s.risk.level} label={s.risk.levelLabel} />
              </span>
              <span className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-[var(--color-ink-muted)]">
                <span>Submission {s.taskSubmission}%</span>
                <span>Coach use {s.socraticAiUsage}%</span>
                <MasteryBadge level={s.mastery} />
                <span>{relativeTime(s.risk.lastActivityAt)}</span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </>
  )
}
