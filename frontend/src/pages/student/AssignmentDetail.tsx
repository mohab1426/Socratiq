import { useRef, useState } from "react"
import { useNavigate, useParams } from "react-router-dom"
import { AppShell } from "@/components/layout/AppShell"
import { Card, CardContent } from "@/components/ui/Card"
import { Button, ButtonLink } from "@/components/ui/Button"
import { Badge } from "@/components/ui/Badge"
import { StudentGradeCard } from "@/components/socratiq/GradePanel"
import { DueDate } from "@/components/socratiq/DueDate"
import { LearningJourney, type JourneyStep } from "@/components/socratiq/LearningJourney"
import { QueryState } from "@/components/ui/States"
import { Paperclip, MessageCircle, Download } from "lucide-react"
import { downloadFile, useCapabilities, useStartAttempt, useStudentAssignment, useStudentCourse, useSubmitFile } from "@/lib/queries"
import { formatBytes, precheck } from "@/lib/files"
import { ApiError } from "@/lib/api"
import type { AssignmentStatus } from "@/types"

function journeyFor(status: AssignmentStatus): JourneyStep[] {
  const order: AssignmentStatus[] = ["not_started", "in_progress", "submitted", "verified"]
  const idx = order.indexOf(status)
  const labels = ["Initial attempt", "AI coaching", "Final submission", "Learning verification"]
  return labels.map((label, i) => ({
    label,
    state: i < idx ? "done" : i === idx ? "current" : "upcoming",
  }))
}

export default function StudentAssignmentDetail() {
  const { courseId = "", assignmentId = "" } = useParams()
  const navigate = useNavigate()
  const q = useStudentAssignment(assignmentId)
  const course = useStudentCourse(courseId)
  const caps = useCapabilities("SUBMISSION")
  const startAttempt = useStartAttempt()
  const submit = useSubmitFile(assignmentId)
  const fileInput = useRef<HTMLInputElement>(null)

  const [file, setFile] = useState<File | null>(null)
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  async function handleRevise() {
    setError(null)
    setNotice(null)
    try {
      await startAttempt.mutateAsync(assignmentId)     // opens attempt N+1; server recomputes status, re-enabling upload/submit
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Couldn't start a new attempt. Try again.")
    }
  }

  function choose(f: File | undefined) {
    setNotice(null)
    if (!f) return
    const problem = precheck(f, caps.data)
    setError(problem)
    setFile(problem ? null : f)
  }

  async function handleSubmit() {
    if (!file) return
    setError(null)
    setProgress(0)
    try {
      const attempt = await startAttempt.mutateAsync(assignmentId)      // idempotent: reuses the open attempt
      const res = await submit.mutateAsync({ attemptId: attempt.id, file, onProgress: setProgress })
      setNotice(res.warning ?? null)
      setFile(null)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Your file couldn't be submitted. Try again.")
    }
  }

  const status = q.data?.status ?? "not_started"
  const busy = submit.isPending || startAttempt.isPending
  const closed = status === "submitted" || status === "verified"

  return (
    <AppShell
      role="student"
      crumbs={[
        { label: "Courses", to: "/student/courses" },
        { label: course.data?.course.name ?? "Course", to: `/student/courses/${courseId}` },
        { label: q.data?.title ?? "Assignment" },
      ]}
    >
      <QueryState query={q} what="Assignment">
        {(assignment) => (
          <div className="grid gap-6">
            <Card>
              <CardContent>
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h1 className="text-lg font-semibold text-[var(--color-ink)]">{assignment.title}</h1>
                    <p className="mt-1 text-sm text-[var(--color-ink-muted)]">
                      {[course.data?.course.name, assignment.topic].filter(Boolean).join(" · ")}
                    </p>
                    <div className="mt-2">
                      <DueDate dueDate={assignment.dueDate} done={closed} />
                    </div>
                  </div>
                  <Badge tone={status === "verified" ? "success" : status === "submitted" ? "teal" : "warning"}>
                    {status === "verified" ? "Verified" : status === "submitted" ? "Submitted" : status === "in_progress" ? "In progress" : "Not started"}
                  </Badge>
                </div>

                <p className="mt-4 whitespace-pre-wrap text-[var(--color-ink-soft)]">{assignment.prompt}</p>

                {assignment.attachments && assignment.attachments.length > 0 && (
                  <div className="mt-4">
                    <p className="text-xs font-semibold text-[var(--color-ink-muted)]">Attachments</p>
                    <ul className="mt-2 space-y-1.5">
                      {assignment.attachments.map((a) => (
                        <li key={a.fileId} className="flex items-center justify-between gap-3 rounded-[var(--radius-md)] border border-[var(--color-border)] px-3 py-2 text-sm">
                          <span className="min-w-0 truncate text-[var(--color-ink)]">
                            {a.filename} <span className="text-xs text-[var(--color-ink-muted)]">· {formatBytes(a.sizeBytes)}</span>
                          </span>
                          <button onClick={() => void downloadFile(a.fileId)} className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[var(--color-teal-dark)] hover:bg-[var(--color-surface-muted)]" aria-label={`Download ${a.filename}`}>
                            <Download className="h-4 w-4" aria-hidden="true" />
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {file && (
                  <p className="mt-4 flex items-center gap-2 text-sm text-[var(--color-ink-soft)]">
                    <Paperclip className="h-4 w-4" /> {file.name} · {formatBytes(file.size)}
                  </p>
                )}
                {assignment.submission?.filename && closed && (
                  <p className="mt-4 flex items-center gap-2 text-sm text-[var(--color-ink-soft)]">
                    <Paperclip className="h-4 w-4" /> {assignment.submission.filename}
                    {assignment.attempt && <span className="text-[var(--color-ink-muted)]">· Attempt {assignment.attempt.attemptNumber}</span>}
                  </p>
                )}
                {busy && progress > 0 && progress < 100 && <p className="mt-2 text-xs text-[var(--color-ink-muted)]">Uploading… {Math.round(progress)}%</p>}
                {error && (
                  <p role="alert" className="mt-3 text-sm text-[var(--color-danger-ink)]">
                    {error}
                  </p>
                )}
                {notice && <p role="status" className="mt-3 text-sm text-[var(--color-warning-ink)]">{notice}</p>}

                <div className="mt-6 flex flex-wrap gap-2">
                  <Button variant="outline" onClick={() => navigate(-1)}>
                    Go back
                  </Button>
                  <input ref={fileInput} type="file" className="hidden" accept={caps.data?.accept} onChange={(e) => { choose(e.target.files?.[0]); e.target.value = "" }} />
                  <Button variant="secondary" onClick={() => fileInput.current?.click()} disabled={closed || busy}>
                    Upload
                  </Button>
                  <Button onClick={handleSubmit} disabled={!file || busy || closed}>
                    {busy ? "Submitting…" : closed ? "Submitted" : "Submit"}
                  </Button>
                  {closed && (
                    <Button variant="outline" onClick={handleRevise} disabled={startAttempt.isPending}>
                      {startAttempt.isPending ? "Starting…" : "Revise & resubmit"}
                    </Button>
                  )}
                  <ButtonLink to={`/student/courses/${courseId}/assignments/${assignment.id}/coach`} variant="primary" className="gap-1.5">
                      <MessageCircle className="h-4 w-4" /> Ask SocratiQ AI
                    </ButtonLink>
                </div>
                {caps.data && !closed && (
                  <p className="mt-2 text-xs text-[var(--color-ink-muted)]">Accepted: {caps.data.extensions.map((e) => e.toUpperCase()).join(", ")}.</p>
                )}

                {status === "submitted" && (
                  <div className="mt-6 rounded-[var(--radius-md)] border border-[var(--color-teal-light)] bg-[var(--color-teal-light)]/50 p-4">
                    <p className="text-sm font-medium text-[var(--color-ink)]">Ready for learning verification</p>
                    <p className="mt-1 text-sm text-[var(--color-ink-soft)]">
                      Show what you understand about your solution before it's graded — a short, conversational check tied to what you actually submitted.
                    </p>
                    <ButtonLink to={`/student/courses/${courseId}/assignments/${assignment.id}/verify`} size="sm" className="mt-3">
                        Start verification
                      </ButtonLink>
                  </div>
                )}
              </CardContent>
            </Card>

            {assignment.grade && <StudentGradeCard grade={assignment.grade} />}

            <Card>
              <CardContent>
                <h2 className="mb-4 text-sm font-semibold text-[var(--color-ink)]">Your learning journey</h2>
                <LearningJourney steps={journeyFor(status)} />
              </CardContent>
            </Card>
          </div>
        )}
      </QueryState>
    </AppShell>
  )
}
