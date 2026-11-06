import { useState } from "react"
import { Button } from "@/components/ui/Button"
import { Field } from "@/components/ui/Field"
import { fieldProps } from "@/components/ui/fieldProps"
import { Input } from "@/components/ui/Input"
import { Panel } from "@/components/ui/Panel"
import { ApiError } from "@/lib/api"
import { formatNumber as fmt, gradeLabel } from "@/lib/grades"
import { useSetGrade, type Grade } from "@/lib/queries"


/** Teacher: enter, change or remove the grade for the student's latest submission. Saves to the one persisted grade the student also sees. */
export function GradePanel({ assignmentId, studentId, grade, hasSubmission }: { assignmentId: string; studentId: string; grade: Grade | null; hasSubmission: boolean }) {
  const { save, clear } = useSetGrade(assignmentId, studentId)
  const [score, setScore] = useState(grade ? fmt(grade.score) : "")
  const [max, setMax] = useState(grade ? fmt(grade.maxScore) : "100")
  const [feedback, setFeedback] = useState(grade?.feedback ?? "")
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  function validate(): { score: number; maxScore: number } | string {
    const s = Number(score), m = Number(max)
    if (score.trim() === "" || !Number.isFinite(s) || s < 0) return "Enter a score of 0 or more."
    if (max.trim() === "" || !Number.isFinite(m) || m <= 0) return "The maximum score must be greater than 0."
    if (s > m) return "The score can't be higher than the maximum."
    return { score: s, maxScore: m }
  }
  const problem = score.trim() === "" ? undefined : (() => { const v = validate(); return typeof v === "string" ? v : undefined })()
  const fail = (e: unknown) => setError(e instanceof ApiError ? e.message : "The grade couldn't be saved. Please try again.")

  function onSave() {
    const v = validate()
    if (typeof v === "string") return setError(v)
    setError(null); setSaved(false)
    save.mutate({ ...v, feedback: feedback.trim() }, { onSuccess: () => setSaved(true), onError: fail })
  }

  return (
    <Panel id="grade" title="Grade" description={!hasSubmission ? "You can grade once the student has submitted." : grade ? `Graded ${new Date(grade.gradedAt).toLocaleDateString()}${grade.gradedBy ? ` by ${grade.gradedBy}` : ""}. The student sees this grade and feedback.` : "Not graded yet. The student sees nothing until you save."}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="grade-score" label="Score" error={problem}>
          <Input {...fieldProps("grade-score", problem)} inputMode="decimal" value={score} disabled={!hasSubmission} onChange={(e) => { setScore(e.target.value); setSaved(false) }} />
        </Field>
        <Field id="grade-max" label="Out of">
          <Input id="grade-max" inputMode="decimal" value={max} disabled={!hasSubmission} onChange={(e) => { setMax(e.target.value); setSaved(false) }} />
        </Field>
      </div>
      <Field id="grade-feedback" label="Feedback (optional)" hint="Shown to the student with the grade." className="mt-4">
        <textarea id="grade-feedback" rows={4} maxLength={4000} value={feedback} disabled={!hasSubmission} onChange={(e) => { setFeedback(e.target.value); setSaved(false) }}
          className="w-full rounded-[var(--radius-md)] border border-[var(--color-control-border)] bg-white p-3 text-sm text-[var(--color-ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-teal-dark)]" />
      </Field>
      {error && <p role="alert" className="mt-3 text-sm text-[var(--color-danger-ink)]">{error}</p>}
      {saved && !error && <p role="status" className="mt-3 text-sm text-[var(--color-ink-muted)]">Saved.</p>}
      <div className="mt-4 flex gap-2">
        <Button size="sm" onClick={onSave} disabled={!hasSubmission || save.isPending}>{save.isPending ? "Saving…" : grade ? "Update grade" : "Save grade"}</Button>
        {grade && <Button size="sm" variant="outline" disabled={clear.isPending} onClick={() => { setError(null); clear.mutate(undefined, { onSuccess: () => { setScore(""); setFeedback(""); setSaved(false) }, onError: fail }) }}>Remove grade</Button>}
      </div>
    </Panel>
  )
}

/** Student: read-only view of the same grade. */
export function StudentGradeCard({ grade }: { grade: Grade }) {
  return (
    <section aria-labelledby="my-grade" className="rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-white p-5 shadow-[var(--shadow-panel)]">
      <h2 id="my-grade" className="text-base font-semibold text-[var(--color-ink)]">Your grade</h2>
      <p className="mt-1 text-2xl font-semibold text-[var(--color-ink)]">{gradeLabel(grade)}</p>
      {grade.feedback && <p className="mt-3 whitespace-pre-wrap rounded-[var(--radius-md)] bg-[var(--color-surface-muted)] p-3 text-sm text-[var(--color-ink)]">{grade.feedback}</p>}
      <p className="mt-2 text-xs text-[var(--color-ink-muted)]">Graded {new Date(grade.gradedAt).toLocaleDateString()}{grade.gradedBy ? ` by ${grade.gradedBy}` : ""}</p>
    </section>
  )
}
