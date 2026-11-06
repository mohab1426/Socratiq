import { Link } from "react-router-dom"
import { AlertCircle, AlertTriangle, CheckCircle2, ChevronRight, Clock } from "lucide-react"
import type { RiskAssessment, RiskLevel } from "@/types"
import { Panel } from "@/components/ui/Panel"
import { formatDateTime } from "@/lib/time"
import { cn } from "@/lib/utils"

/**
 * Four review levels. Meaning is carried by icon + text + tint together, never by colour alone. The level itself is decided by the
 * backend (app/risk.py); this file only presents it. `blurb` is fixed UI copy for each level, not a data value.
 */
const LEVELS: Record<RiskLevel, { icon: typeof AlertTriangle; badge: string; tile: string; text: string; blurb: string }> = {
  low: {
    icon: CheckCircle2, text: "Low",
    badge: "bg-[var(--color-success-light)] text-[var(--color-success-ink)]",
    tile: "border-[var(--color-success)]/40 bg-[var(--color-success-light)]/60 text-[var(--color-success-ink)]",
    blurb: "Nothing in the recorded activity needs follow-up.",
  },
  moderate: {
    icon: AlertCircle, text: "Moderate",
    badge: "bg-[var(--color-warning-light)] text-[var(--color-warning-ink)]",
    tile: "border-[var(--color-warning)]/50 bg-[var(--color-warning-light)]/70 text-[var(--color-warning-ink)]",
    blurb: "Some patterns are worth a closer look.",
  },
  high: {
    icon: AlertTriangle, text: "High",
    badge: "bg-[var(--color-danger-light)] text-[var(--color-danger-ink)]",
    tile: "border-[var(--color-danger)]/50 bg-[var(--color-danger-light)]/70 text-[var(--color-danger-ink)]",
    blurb: "Several patterns are worth reviewing together.",
  },
  insufficient: {
    icon: Clock, text: "Insufficient evidence",
    badge: "bg-[var(--color-surface-muted)] text-[var(--color-ink-muted)]",
    tile: "border-dashed border-[var(--color-border-strong)] bg-[var(--color-surface-muted)] text-[var(--color-ink-muted)]",
    blurb: "Too little recorded activity to rate this student yet.",
  },
}

/** Icon + text label + tint. The hidden prefix makes a screen reader say "Review level: Moderate". */
export function RiskBadge({ level, label, className }: { level: RiskLevel; label?: string; className?: string }) {
  const s = LEVELS[level]
  const Icon = s.icon
  return (
    <span className={cn("inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium", s.badge, className)}>
      <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span className="sr-only">Review level: </span>
      {label ?? s.text}
    </span>
  )
}

const SOURCE_TEXT = { risk_signal: "Observed in a Coach conversation", verification: "From a learning verification", submission: "From the submission" } as const

function Stat({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <div className="rounded-[var(--radius-md)] border border-[var(--color-border)] px-4 py-3" title={hint}>
      <dt className="text-xs text-[var(--color-ink-muted)]">{label}</dt>
      <dd className="mt-1">{children}</dd>
    </div>
  )
}

function Bar({ pct }: { pct: number }) {
  return (
    <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-[var(--color-surface-muted)]" aria-hidden="true">
      <div className="h-full rounded-full bg-[var(--color-teal-dark)] transition-[width] duration-500 motion-reduce:transition-none" style={{ width: `${Math.min(100, Math.max(0, pct))}%` }} />
    </div>
  )
}

/**
 * Review overview: level, how sure we are, how much evidence, and WHY. Every reason opens to the rows it came from.
 * `submissionLink` maps an assignment id to its submission-review page (or null when unknown).
 */
export function RiskPanel({ id = "review", risk, assignmentTitles = {}, submissionLink }: { id?: string; risk: RiskAssessment; assignmentTitles?: Record<string, string>; submissionLink?: (assignmentId: string) => string | null }) {
  const lv = LEVELS[risk.level]
  const Icon = lv.icon
  const conf = Math.round(risk.confidence * 100)
  const rated = risk.level !== "insufficient"
  return (
    <Panel id={id} title="Review overview" description="An indicator for instructor review of possible reliance on outside AI. Not proof of anything.">
      <div className="grid gap-3 md:grid-cols-4">
        <div className={cn("flex items-center gap-4 rounded-[var(--radius-md)] border p-4 md:col-span-2", lv.tile)}>
          <Icon className="h-9 w-9 shrink-0" aria-hidden="true" />
          <div className="min-w-0">
            <p className="text-xs font-medium opacity-80">Review level</p>
            <p className="text-2xl font-semibold leading-tight">{risk.levelLabel}</p>
            <p className="mt-0.5 text-sm">{lv.blurb}</p>
          </div>
        </div>
        <dl className="contents">
          <Stat label="Confidence in this assessment" hint="How much and what kind of activity backs the assessment. It is not the likelihood of misconduct.">
            <p className="text-xl font-semibold tabular-nums text-[var(--color-ink)]">{conf}% <span className="text-sm font-normal text-[var(--color-ink-muted)]">{risk.confidenceLabel}</span></p>
            <Bar pct={conf} />
          </Stat>
          <Stat label="Evidence" hint="Observations found in the recorded activity">
            <p className="text-xl font-semibold tabular-nums text-[var(--color-ink)]">{risk.evidenceCount} <span className="text-sm font-normal text-[var(--color-ink-muted)]">signal{risk.evidenceCount === 1 ? "" : "s"}</span></p>
            <p className="mt-1 text-xs text-[var(--color-ink-muted)]">Last: {formatDateTime(risk.lastEvidenceAt)}</p>
          </Stat>
        </dl>
      </div>

      {!rated && (
        <div className="mt-3 rounded-[var(--radius-md)] bg-[var(--color-surface-muted)] px-4 py-3 text-sm text-[var(--color-ink)]">
          <p>{risk.explanation}</p>
          <Bar pct={(100 * risk.activityUnits) / Math.max(1, risk.minActivityUnits)} />
          <p className="mt-1 text-xs text-[var(--color-ink-muted)]">{risk.activityUnits} of {risk.minActivityUnits} activity units recorded (Coach turns, submissions and verification answers).</p>
        </div>
      )}

      {risk.topSignals.length > 0 && (
        <div className="mt-5">
          <h3 className="text-sm font-semibold text-[var(--color-ink)]">{rated ? "Why this needs review" : "Observations so far (shown for context, not rated)"}</h3>
          <ul className="mt-2 divide-y divide-[var(--color-border)] overflow-hidden rounded-[var(--radius-md)] border border-[var(--color-border)]">
            {risk.topSignals.map((s) => (
              <li key={s.signal}>
                <details className="group">
                  <summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-3 transition-colors hover:bg-[var(--color-surface-muted)]">
                    <ChevronRight className="h-4 w-4 shrink-0 text-[var(--color-ink-muted)] transition-transform group-open:rotate-90 motion-reduce:transition-none" aria-hidden="true" />
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium text-[var(--color-ink)]">{s.label}{s.count > 1 ? ` · ${s.count}×` : ""}</span>
                      <span className="block text-xs text-[var(--color-ink-muted)]">{s.categoryLabel}{s.mitigatedCount === s.count ? " · counted less because verification later passed" : ""}</span>
                    </span>
                    <span className="shrink-0 text-xs font-medium text-[var(--color-teal-dark)] group-open:hidden">View evidence</span>
                    <span className="hidden shrink-0 text-xs font-medium text-[var(--color-teal-dark)] group-open:inline">Hide evidence</span>
                  </summary>
                  <div className="border-t border-[var(--color-border)] bg-[var(--color-surface-muted)]/60 px-4 py-3">
                    <p className="text-sm text-[var(--color-ink-muted)]">{s.meaning}</p>
                    <ul className="mt-3 space-y-2">
                      {s.evidence.map((e) => {
                        const link = e.assignmentId && submissionLink ? submissionLink(e.assignmentId) : null
                        return (
                          <li key={`${e.source}-${e.refId}`} className="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-white p-3 text-sm">
                            <p className="text-xs text-[var(--color-ink-muted)]">
                              {formatDateTime(e.at)} · {SOURCE_TEXT[e.source]}
                              {e.assignmentId && assignmentTitles[e.assignmentId] ? ` · ${assignmentTitles[e.assignmentId]}` : ""}
                            </p>
                            {e.detail && <p className="mt-1 whitespace-pre-wrap text-[var(--color-ink)]">{e.detail}</p>}
                            {link && <Link to={link} className="mt-0.5 inline-block py-1 text-xs font-medium text-[var(--color-teal-dark)] hover:underline">Open this submission and its verification →</Link>}
                          </li>
                        )
                      })}
                    </ul>
                  </div>
                </details>
              </li>
            ))}
          </ul>
        </div>
      )}

      {(risk.mitigating.assignmentsWithPassedVerification > 0 || risk.mitigating.strongPositiveEvidence > 0) && (
        <p className="mt-3 text-sm text-[var(--color-ink-muted)]">
          Balancing evidence: {risk.mitigating.assignmentsWithPassedVerification} assignment{risk.mitigating.assignmentsWithPassedVerification === 1 ? "" : "s"} with a passed verification
          {risk.mitigating.strongPositiveEvidence > 0 ? `, ${risk.mitigating.strongPositiveEvidence} strong understanding or explanation record${risk.mitigating.strongPositiveEvidence === 1 ? "" : "s"}` : ""}.
        </p>
      )}
      <p className="mt-4 rounded-[var(--radius-md)] bg-[var(--color-surface-muted)] px-3 py-2 text-xs text-[var(--color-ink-muted)]">{risk.disclaimer}</p>
    </Panel>
  )
}
