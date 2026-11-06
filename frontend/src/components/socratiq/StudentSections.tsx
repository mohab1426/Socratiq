import { useState } from "react"
import { Link } from "react-router-dom"
import { Circle, FileCheck2, MessageCircle, Minus, Pencil, RotateCcw, ShieldCheck, TrendingDown, TrendingUp } from "lucide-react"
import type { AiUsage, StudentAssignmentProgress, StudentConcept, StudentVerificationRun, TimelineEntry } from "@/types"
import { Badge } from "@/components/ui/Badge"
import { Panel } from "@/components/ui/Panel"
import { MasteryBadge } from "@/components/socratiq/MasteryBadge"
import { formatDateTime, formatDay, formatTime } from "@/lib/time"
import { cn } from "@/lib/utils"

const OUTCOME: Record<string, { text: string; tone: "success" | "warning" | "neutral" }> = {
  PASS: { text: "Passed", tone: "success" },
  PARTIAL: { text: "Partly demonstrated", tone: "warning" },
  NEEDS_RETRY: { text: "Needs retry", tone: "warning" },
  INSUFFICIENT_EVIDENCE: { text: "Not enough evidence", tone: "neutral" },
}
const STEP: Record<string, string> = { EXPLAIN: "Explain", MODIFY: "Modify", TRANSFER: "Transfer" }

export function OutcomeBadge({ outcome }: { outcome: string | null }) {
  if (!outcome) return <Badge tone="neutral">Not finished</Badge>
  const o = OUTCOME[outcome] ?? { text: outcome, tone: "neutral" as const }
  return <Badge tone={o.tone}>{o.text}</Badge>
}

export const reviewPath = (courseId: string, assignmentId: string, studentId: string) => `/teacher/courses/${courseId}/assignments/${assignmentId}/submissions/${studentId}`

const emptyText = "px-5 py-6 text-sm text-[var(--color-ink-muted)]"

// ------------------------------------------------------------------ learning process (timeline)
const KIND: Record<TimelineEntry["kind"], { icon: typeof Circle; tone: string }> = {
  attempt: { icon: Pencil, tone: "border-[var(--color-border-strong)] text-[var(--color-ink)]" },
  coach: { icon: MessageCircle, tone: "border-[var(--color-teal-dark)] text-[var(--color-teal-dark)]" },
  submission: { icon: FileCheck2, tone: "border-[var(--color-ink)] text-[var(--color-ink)]" },
  revision: { icon: RotateCcw, tone: "border-[var(--color-warning)] text-[var(--color-warning-ink)]" },
  verification: { icon: ShieldCheck, tone: "border-[var(--color-success)] text-[var(--color-success-ink)]" },
  other: { icon: Circle, tone: "border-[var(--color-border-strong)] text-[var(--color-ink-muted)]" },
}
const PAGE = 12

/** Real recorded events grouped by day, newest first. A flagged event carries the review indicator that was raised on it. */
export function LearningTimeline({ entries, studentId }: { entries: TimelineEntry[]; studentId: string }) {
  const [all, setAll] = useState(false)
  const shown = all ? entries : entries.slice(0, PAGE)
  const days: { day: string; items: TimelineEntry[] }[] = []
  for (const e of shown) {
    const day = formatDay(e.at)
    const last = days[days.length - 1]
    if (last && last.day === day) last.items.push(e)
    else days.push({ day, items: [e] })
  }

  return (
    <Panel id="timeline" title="Learning process" description="What the student did, in order. Events with a review indicator are marked." right={entries.length > 0 ? <span className="text-xs text-[var(--color-ink-muted)]">{entries.length} event{entries.length === 1 ? "" : "s"}</span> : undefined}>
      {entries.length === 0 ? (
        <p className="text-sm text-[var(--color-ink-muted)]">No recorded activity yet. Events appear as the student works on an assignment.</p>
      ) : (
        <>
          <div className="space-y-5">
            {days.map((g) => (
              <div key={g.day}>
                <h3 className="mb-3 text-xs font-semibold text-[var(--color-ink-muted)]">{g.day}</h3>
                <ol>
                  {g.items.map((e, i) => {
                    const k = KIND[e.kind]
                    const Icon = k.icon
                    const last = i === g.items.length - 1
                    return (
                      <li key={e.id} className="grid grid-cols-[3.25rem_1fr] gap-x-3">
                        <time dateTime={e.at ?? undefined} className="pt-0.5 text-right text-xs tabular-nums text-[var(--color-ink-muted)]">{formatTime(e.at)}</time>
                        <div className={cn("relative min-w-0 pl-9", last ? "pb-1" : "pb-5")}>
                          <span aria-hidden="true" className={cn("absolute left-0 top-0 flex h-6 w-6 items-center justify-center rounded-full border-2 bg-white", k.tone, e.flagged && "border-[var(--color-warning)] ring-4 ring-[var(--color-warning-light)]")}>
                            <Icon className="h-3 w-3" />
                          </span>
                          {!last && <span aria-hidden="true" className="absolute bottom-0 left-[11px] top-7 w-0.5 bg-[var(--color-border)]" />}
                          <p className="text-sm font-medium text-[var(--color-ink)]">{e.label}</p>
                          {e.assignmentId && e.assignmentTitle && (
                            <Link to={reviewPath(e.courseId, e.assignmentId, studentId)} className="inline-block py-1 text-xs text-[var(--color-ink-muted)] hover:text-[var(--color-teal-dark)] hover:underline">{e.assignmentTitle}</Link>
                          )}
                          {e.flagged && (
                            <p className="mt-1.5 inline-block rounded-full bg-[var(--color-warning-light)] px-2.5 py-0.5 text-xs font-medium text-[var(--color-warning-ink)]">
                              Review indicator: {e.signals.join(", ")}
                            </p>
                          )}
                        </div>
                      </li>
                    )
                  })}
                </ol>
              </div>
            ))}
          </div>
          {entries.length > PAGE && (
            <button type="button" onClick={() => setAll((v) => !v)} className="mt-4 rounded-full border border-[var(--color-border-strong)] px-3.5 py-1.5 text-sm font-medium text-[var(--color-ink)] transition-colors hover:bg-[var(--color-surface-muted)]">
              {all ? "Show fewer events" : `Show all ${entries.length} events`}
            </button>
          )}
        </>
      )}
    </Panel>
  )
}

// ------------------------------------------------------------------ Socratic Coach use (context, NOT external-AI risk)
export function AiUsagePanel({ usage }: { usage: AiUsage }) {
  const max = Math.max(1, ...usage.byIntervention.map((i) => i.count))
  return (
    <Panel id="coach" title="Socratic Coach activity" description="Normal use of the Coach is expected. It is context and is never counted as a risk indicator.">
      {usage.interactions === 0 ? (
        <p className="text-sm text-[var(--color-ink-muted)]">This student hasn't used the Coach on these assignments.</p>
      ) : (
        <div className="space-y-4">
          <dl className="grid grid-cols-2 gap-3">
            <div className="rounded-[var(--radius-md)] bg-[var(--color-surface-muted)] px-3 py-2.5"><dt className="text-xs text-[var(--color-ink-muted)]">Coach turns</dt><dd className="text-xl font-semibold tabular-nums text-[var(--color-ink)]">{usage.interactions}</dd></div>
            <div className="rounded-[var(--radius-md)] bg-[var(--color-surface-muted)] px-3 py-2.5"><dt className="text-xs text-[var(--color-ink-muted)]">Conversations</dt><dd className="text-xl font-semibold tabular-nums text-[var(--color-ink)]">{usage.sessions}</dd></div>
          </dl>
          {usage.lastAt && <p className="text-xs text-[var(--color-ink-muted)]">Last used {formatDateTime(usage.lastAt)}</p>}
          <div>
            <h3 className="text-xs font-semibold text-[var(--color-ink-muted)]">What the Coach did</h3>
            <ul className="mt-2 space-y-2">
              {usage.byIntervention.map((i) => (
                <li key={i.type} className="flex items-center gap-3 text-sm">
                  <span className="w-32 shrink-0 truncate text-[var(--color-ink)]">{i.label}</span>
                  <div className="h-2 flex-1 overflow-hidden rounded-full bg-[var(--color-surface-muted)]" aria-hidden="true"><div className="h-full rounded-full bg-[var(--color-teal-dark)]" style={{ width: `${Math.round((100 * i.count) / max)}%` }} /></div>
                  <span className="w-6 text-right tabular-nums text-[var(--color-ink-muted)]">{i.count}</span>
                </li>
              ))}
            </ul>
          </div>
          {usage.byDiagnosis.length > 0 && (
            <div>
              <h3 className="text-xs font-semibold text-[var(--color-ink-muted)]">What the Coach diagnosed</h3>
              <p className="mt-2 flex flex-wrap gap-1.5">{usage.byDiagnosis.map((d) => <Badge key={d.type} tone="slate">{d.label} · {d.count}</Badge>)}</p>
            </div>
          )}
          {usage.notTracked && usage.notTracked.length > 0 && <p className="text-xs text-[var(--color-ink-muted)]">Not measured by SocratiQ: {usage.notTracked.join("; ").toLowerCase()}.</p>}
        </div>
      )}
    </Panel>
  )
}

// ------------------------------------------------------------------ verification
export function VerificationPanel({ runs, studentId }: { runs: StudentVerificationRun[]; studentId: string }) {
  return (
    <Panel id="verification" flush title="Learning verification" description="A short check of the student's reasoning behind what they submitted. Separate from any grade.">
      {runs.length === 0 ? (
        <p className={emptyText}>No verification activity yet.</p>
      ) : (
        <ul className="divide-y divide-[var(--color-border)]">
          {runs.map((r) => (
            <li key={r.id}>
              <details className="group">
                <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-3 gap-y-1 px-5 py-3 transition-colors hover:bg-[var(--color-surface-muted)]">
                  <span className="min-w-0 flex-1 truncate text-sm font-medium text-[var(--color-ink)]">{r.assignmentTitle}</span>
                  <OutcomeBadge outcome={r.status === "COMPLETED" ? r.outcome : null} />
                  <span className="text-xs text-[var(--color-ink-muted)]">{formatDateTime(r.completedAt ?? r.startedAt)}</span>
                  <span className="text-xs font-medium text-[var(--color-teal-dark)] group-open:hidden">Details</span>
                  <span className="hidden text-xs font-medium text-[var(--color-teal-dark)] group-open:inline">Hide</span>
                </summary>
                <div className="space-y-2 border-t border-[var(--color-border)] bg-[var(--color-surface-muted)]/60 px-5 py-3">
                  {r.questions.map((q, i) => (
                    <div key={i} className="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-white p-3 text-sm">
                      <p className="flex flex-wrap items-center gap-2">
                        <span className="font-medium text-[var(--color-ink)]">{STEP[q.type] ?? q.type}</span>
                        {q.concept && <span className="text-xs text-[var(--color-ink-muted)]">Concept: {q.concept}</span>}
                        {q.outcome ? <OutcomeBadge outcome={q.outcome} /> : <span className="text-xs text-[var(--color-ink-muted)]">Not answered</span>}
                      </p>
                      {q.feedback && <p className="mt-1.5 text-[var(--color-ink-muted)]">{q.feedback}</p>}
                    </div>
                  ))}
                  <Link to={reviewPath(r.courseId, r.assignmentId, studentId)} className="py-1 inline-block text-xs font-medium text-[var(--color-teal-dark)] hover:underline">Open the submission and the student's answers →</Link>
                </div>
              </details>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  )
}

// ------------------------------------------------------------------ concepts
const TREND = { up: { text: "Improving", icon: TrendingUp }, down: { text: "Declining", icon: TrendingDown }, flat: { text: "Steady", icon: Minus } } as const
const BAR: Record<string, string> = { Strong: "var(--color-success)", Moderate: "var(--color-teal-dark)", Weak: "var(--color-danger)" }

export function ConceptPanel({ concepts }: { concepts: StudentConcept[] }) {
  return (
    <Panel id="concepts" flush title="Concept mastery" description="From completed verification answers only. Weakest first.">
      {concepts.length === 0 ? (
        <p className={emptyText}>No concept has enough verification evidence yet.</p>
      ) : (
        <ul className="divide-y divide-[var(--color-border)]">
          {concepts.map((c) => {
            const t = c.trend ? TREND[c.trend] : null
            const TIcon = t?.icon
            return (
              <li key={c.name} className="px-5 py-3">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="min-w-0 flex-1 truncate text-sm font-medium text-[var(--color-ink)]">{c.name}</span>
                  {t && TIcon && <span className="inline-flex items-center gap-1 text-xs text-[var(--color-ink-muted)]"><TIcon className="h-3.5 w-3.5" aria-hidden="true" />{t.text}</span>}
                  <MasteryBadge level={c.level} />
                </div>
                {c.mastery !== null && (
                  <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-[var(--color-surface-muted)]" aria-hidden="true">
                    <div className="h-full rounded-full" style={{ width: `${Math.round(c.mastery * 100)}%`, background: c.level ? BAR[c.level] : "var(--color-border-strong)" }} />
                  </div>
                )}
                <p className="mt-1.5 text-xs text-[var(--color-ink-muted)]">
                  {c.evidenceCount} verification answer{c.evidenceCount === 1 ? "" : "s"}
                  {c.coachMentions > 0 ? ` · ${c.coachMentions} Coach turn${c.coachMentions === 1 ? "" : "s"} on it` : ""}
                  {c.assignments.length > 0 ? ` · ${c.assignments.map((a) => a.title).join(", ")}` : ""}
                </p>
              </li>
            )
          })}
        </ul>
      )}
    </Panel>
  )
}

// ------------------------------------------------------------------ assignment progress
export function AssignmentProgress({ items, studentId }: { items: StudentAssignmentProgress[]; studentId: string }) {
  return (
    <Panel id="progress" flush title="Assignment progress">
      {items.length === 0 ? (
        <p className={emptyText}>No published assignments yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[480px] text-left text-sm">
            <thead>
              <tr className="bg-[var(--color-surface-muted)] text-xs text-[var(--color-ink-muted)]">
                <th scope="col" className="px-5 py-2.5 font-semibold">Assignment</th>
                <th scope="col" className="px-3 py-2.5 font-semibold">Submitted</th>
                <th scope="col" className="px-3 py-2.5 font-semibold">Verification</th>
                <th scope="col" className="px-5 py-2.5 font-semibold">Coach turns</th>
              </tr>
            </thead>
            <tbody>
              {items.map((a) => (
                <tr key={a.assignmentId} className="border-t border-[var(--color-border)] transition-colors hover:bg-[var(--color-surface-muted)]">
                  <td className="px-5 py-3"><Link to={reviewPath(a.courseId, a.assignmentId, studentId)} className="inline-block py-1 font-medium text-[var(--color-ink)] hover:text-[var(--color-teal-dark)] hover:underline">{a.title}</Link></td>
                  <td className="px-3 py-3">{a.submitted ? "Yes" : <span className="text-[var(--color-ink-muted)]">Not yet</span>}</td>
                  <td className="px-3 py-3">{a.verificationOutcome ? <OutcomeBadge outcome={a.verificationOutcome} /> : <span className="text-[var(--color-ink-muted)]">None yet</span>}</td>
                  <td className="px-5 py-3 tabular-nums">{a.coachTurns}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  )
}
