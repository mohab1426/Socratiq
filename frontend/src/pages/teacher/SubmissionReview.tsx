import { lazy, Suspense } from "react"
import { useParams } from "react-router-dom"
import { AppShell } from "@/components/layout/AppShell"
import { Badge } from "@/components/ui/Badge"
import { Button, ButtonLink } from "@/components/ui/Button"
import { PageIntro } from "@/components/ui/PageIntro"
import { Panel } from "@/components/ui/Panel"
import { QueryState } from "@/components/ui/States"
import { SmartBoard } from "@/components/socratiq/SmartBoard"
import { fromServer, isEmptyBoard } from "@/lib/whiteboard"
import { GradePanel } from "@/components/socratiq/GradePanel"
import { gradeLabel } from "@/lib/grades"
import { RiskPanel } from "@/components/socratiq/RiskPanel"
import { SubmissionSkeleton } from "@/components/socratiq/Skeletons"
import { downloadFile, useSubmissionReview, useTeacherAssignment, useTeacherCourse } from "@/lib/queries"
import { formatBytes } from "@/lib/files"

// The native board's drawing engine is large: load it only when a teacher opens a student's native board.
const SceneViewer = lazy(() => import("@/components/smartboard/SceneViewer"))

/** One student's work on one assignment: what they submitted -> what they could explain -> the review level for this assignment. */
export default function SubmissionReview() {
  const { courseId = "", assignmentId = "", studentId = "" } = useParams()
  const course = useTeacherCourse(courseId).data?.course
  const q = useSubmissionReview(assignmentId, studentId)
  const asg = useTeacherAssignment(assignmentId).data

  return (
    <AppShell
      role="teacher"
      crumbs={[
        { label: "Courses", to: "/teacher/courses" },
        { label: course?.name ?? "Course", to: `/teacher/courses/${courseId}` },
        { label: q.data?.assignment.title ?? "Assignment", to: `/teacher/courses/${courseId}/assignments/${assignmentId}` },
        { label: q.data?.student.name ?? "Student" },
      ]}
    >
      <QueryState query={q} what="Submission" skeleton={<SubmissionSkeleton />}>
        {(r) => {
          const file = r.submission?.file
          const mastery = asg?.submissions.find((s) => s.studentId === studentId)?.mastery ?? null
          return (
            <div className="mx-auto max-w-4xl space-y-5">
              <PageIntro
                eyebrow="Submission review"
                title={r.student.name}
                subtitle={
                  <>
                    {r.assignment.title}
                    {r.attempt && ` · attempt ${r.attempt.number} (assignment version ${r.attempt.assignmentVersion}${r.attempt.assignmentVersion !== r.assignment.version ? `, now v${r.assignment.version}` : ""})`}
                  </>
                }
                meta={
                  <>
                    <Badge tone="neutral">{r.coachInteractions} Coach turn{r.coachInteractions === 1 ? "" : "s"}</Badge>
                    {mastery && <Badge tone="teal">{mastery} mastery</Badge>}
                    {r.grade && <Badge tone="neutral">Graded {gradeLabel(r.grade)}</Badge>}
                  </>
                }
                actions={<ButtonLink to={`/teacher/students/${studentId}`} size="sm" variant="outline">Student overview</ButtonLink>}
              />

              <Panel id="submission" title="Submission" description={r.submission ? undefined : "Nothing has been submitted for this attempt."}>
                {r.submission ? (
                  <>
                    {file && (
                      <div className="mb-3 flex items-center justify-between gap-3 rounded-[var(--radius-md)] border border-[var(--color-border)] px-3 py-2 text-sm">
                        <span className="min-w-0 truncate text-[var(--color-ink)]">{file.filename} <span className="text-xs text-[var(--color-ink-muted)]">· {formatBytes(file.sizeBytes)}</span></span>
                        <Button size="sm" variant="outline" onClick={() => void downloadFile(file.fileId)}>Download</Button>
                      </div>
                    )}
                    {r.submission.textPreview ? (
                      <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-[var(--radius-md)] bg-[var(--color-surface-muted)] p-3 text-xs text-[var(--color-ink)]">
                        {r.submission.textPreview}
                        {r.submission.textTruncated ? "\n…" : ""}
                      </pre>
                    ) : (
                      <p className="text-sm text-[var(--color-ink-muted)]">No text could be read from this file, so only the original file is available.</p>
                    )}
                  </>
                ) : (
                  <p className="text-sm text-[var(--color-ink-muted)]">This student hasn't submitted yet.</p>
                )}
              </Panel>

              {r.whiteboard && (!!r.whiteboard.scene || !isEmptyBoard(fromServer(r.whiteboard))) && (() => {
                const wb = fromServer(r.whiteboard)
                const items = wb.elements.filter((e) => e.kind === "text" || e.kind === "equation")
                const sceneTexts = ((wb.scene?.elements as { type: string; text?: string; isDeleted?: boolean; customData?: { socratiq?: { author?: string } } }[] | undefined) ?? []).filter((e) => e.type === "text" && !e.isDeleted && e.text?.trim())
                return (
                  <Panel id="thinking-space" title="Whiteboard" description="The board as the student left it. Items with a teal edge were written by SocratiQ; everything else was written or drawn by the student. SocratiQ reads typed text and equations, not freehand drawing.">
                    {wb.scene ? (
                      <Suspense fallback={<p role="status" className="text-sm text-[var(--color-ink-muted)]">Loading the board…</p>}><SceneViewer scene={wb.scene} /></Suspense>
                    ) : (
                      <SmartBoard board={wb} readOnly fit="width" />
                    )}
                    {sceneTexts.length > 0 && (
                      <details className="mt-3 text-sm">
                        <summary className="cursor-pointer font-medium text-[var(--color-ink)]">List the written items ({sceneTexts.length})</summary>
                        <ol className="mt-2 space-y-1">
                          {sceneTexts.map((e, i) => {
                            const a = e.customData?.socratiq?.author
                            return <li key={i}><span className={`mr-2 text-xs font-semibold ${a === "student" || !a ? "text-[var(--color-ink-muted)]" : "text-[var(--color-teal-dark)]"}`}>{a === "coach" ? "SocratiQ Coach" : a === "ai" ? "SocratiQ drawing" : "Student"}</span>{e.text}</li>
                          })}
                        </ol>
                      </details>
                    )}
                    {(items.length > 0 || wb.steps.length > 0) && (
                      <details className="mt-3 text-sm">
                        <summary className="cursor-pointer font-medium text-[var(--color-ink)]">List the written items ({items.length + wb.steps.length})</summary>
                        <ol className="mt-2 space-y-1">
                          {wb.steps.map((s, i) => <li key={`l${i}`}><span className="mr-2 text-xs font-semibold text-[var(--color-ink-muted)]">Student</span>{s}</li>)}
                          {items.map((e) => (
                            <li key={e.id}>
                              <span className={`mr-2 text-xs font-semibold ${e.author === "coach" ? "text-[var(--color-teal-dark)]" : "text-[var(--color-ink-muted)]"}`}>{e.author === "coach" ? "SocratiQ" : "Student"}</span>
                              <span className={e.kind === "equation" ? "font-mono" : undefined}>{e.kind === "equation" ? e.latex : e.text}</span>
                            </li>
                          ))}
                        </ol>
                      </details>
                    )}
                  </Panel>
                )
              })()}

              <GradePanel key={`${r.grade?.gradedAt ?? "none"}`} assignmentId={assignmentId} studentId={studentId} grade={r.grade} hasSubmission={!!r.submission} />

              <Panel id="verification" title="Learning verification" description="Responses from a short conversation that checks the student's reasoning behind what they submitted. It is not a re-test and not a grade.">
                {!r.verification || r.verification.entries.length === 0 ? (
                  <p className="text-sm text-[var(--color-ink-muted)]">No verification activity yet.</p>
                ) : (
                  <div className="space-y-3">
                    {r.verification.entries.map((entry) => (
                      <div key={entry.label} className="rounded-[var(--radius-md)] border border-[var(--color-border)] p-4">
                        <Badge tone="teal">{entry.label}</Badge>
                        <p className="mt-2 text-sm font-medium text-[var(--color-ink)]">{entry.prompt}</p>
                        {entry.answer ? <p className="mt-2 whitespace-pre-wrap text-sm text-[var(--color-ink)]">{entry.answer}</p> : <p className="mt-2 text-sm text-[var(--color-ink-muted)]">Not answered yet.</p>}
                        {entry.feedback && <p className="mt-2 rounded-[var(--radius-sm)] bg-[var(--color-surface-muted)] px-3 py-2 text-xs text-[var(--color-ink-muted)]">Feedback shown to the student: {entry.feedback}</p>}
                      </div>
                    ))}
                  </div>
                )}
              </Panel>

              <RiskPanel risk={r.risk} assignmentTitles={{ [r.assignment.id]: r.assignment.title }} />
            </div>
          )
        }}
      </QueryState>
    </AppShell>
  )
}
