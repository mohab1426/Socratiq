import { useRef, useState } from "react"
import { Link, useParams } from "react-router-dom"
import { AppShell } from "@/components/layout/AppShell"
import { Card, CardContent } from "@/components/ui/Card"
import { Badge } from "@/components/ui/Badge"
import { Button } from "@/components/ui/Button"
import { MasteryBadge } from "@/components/socratiq/MasteryBadge"
import { EmptyState, QueryState } from "@/components/ui/States"
import { Paperclip, X } from "lucide-react"
import { downloadFile, useAssignmentActions, useCapabilities, useTeacherAssignment, useTeacherCourse } from "@/lib/queries"
import { formatBytes, precheck, statusLabel } from "@/lib/files"
import { ApiError } from "@/lib/api"

const statusText: Record<string, string> = { not_started: "Not started", in_progress: "In progress", submitted: "Submitted", verified: "Verified" }
const lifecycleTone = { DRAFT: "neutral", PUBLISHED: "success", ARCHIVED: "slate" } as const
const lifecycleText = { DRAFT: "Draft", PUBLISHED: "Published", ARCHIVED: "Archived" } as const

export default function TeacherAssignmentDetail() {
  const { courseId = "", assignmentId = "" } = useParams()
  const course = useTeacherCourse(courseId).data?.course
  const q = useTeacherAssignment(assignmentId)
  const actions = useAssignmentActions(assignmentId)
  const caps = useCapabilities("ASSIGNMENT_ATTACHMENT", "SUPPORTING")
  const picker = useRef<HTMLInputElement>(null)
  const [error, setError] = useState<string | null>(null)
  const [progress, setProgress] = useState(0)

  const fail = (e: unknown) => setError(e instanceof ApiError ? e.message : "That didn't work. Try again.")

  function attach(f?: File) {
    if (!f) return
    setError(null)
    const problem = precheck(f, caps.data)
    if (problem) return setError(problem)
    actions.attach.mutate({ file: f, onProgress: setProgress }, { onError: fail })
  }

  return (
    <AppShell
      role="teacher"
      crumbs={[{ label: "Courses", to: "/teacher/courses" }, { label: course?.name ?? "Course", to: `/teacher/courses/${courseId}` }, { label: q.data?.title ?? "Assignment" }]}
    >
      <QueryState query={q} what="Assignment">
        {(a) => {
          const life = a.lifecycle ?? "DRAFT"
          return (
            <>
              <Card className="max-w-2xl">
                <CardContent>
                  <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
                    <h1 className="min-w-0 text-lg font-semibold text-[var(--color-ink)] [overflow-wrap:anywhere]">{a.title}</h1>
                    <div className="flex flex-wrap gap-1.5">
                      {a.topic && <Badge tone="teal">{a.topic}</Badge>}
                      <Badge tone={lifecycleTone[life]}>{lifecycleText[life]}</Badge>
                    </div>
                  </div>
                  <p className="mt-1 text-xs text-[var(--color-ink-muted)]">
                    Version {a.version}
                    {a.dueDate && ` · Due ${new Date(a.dueDate).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}`}
                    {" · "}{a.counts.submitted}/{a.counts.students} submitted · {a.counts.verified} verified
                  </p>
                  <p className="mt-4 whitespace-pre-wrap text-[var(--color-ink-soft)]">{a.prompt}</p>

                  <div className="mt-5">
                    <p className="text-xs font-semibold text-[var(--color-ink-muted)]">Attachments</p>
                    {(a.attachments ?? []).length === 0 ? (
                      <p className="mt-1 text-sm text-[var(--color-ink-soft)]">None. Add datasets, starter code or reference sheets students (and the AI Coach) can use for this assignment.</p>
                    ) : (
                      <ul className="mt-2 space-y-1.5">
                        {a.attachments!.map((f) => {
                          const st = statusLabel(f)
                          return (
                            <li key={f.fileId} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 rounded-[var(--radius-md)] border border-[var(--color-border)] px-3 py-2 text-sm">
                              <span className="min-w-0 max-w-full truncate text-[var(--color-ink)]">
                                {f.filename} <span className="text-xs text-[var(--color-ink-muted)]">· {formatBytes(f.sizeBytes)} · {f.role === "PROMPT" ? "prompt file" : "supporting"}</span>
                              </span>
                              <span className="flex max-w-full flex-wrap items-center gap-2">
                                <Badge tone={st.tone} title={f.error ?? f.note ?? undefined}>{st.text}</Badge>
                                <button className="inline-flex min-h-6 items-center text-[var(--color-teal-dark)] hover:underline" onClick={() => void downloadFile(f.fileId)}>Download</button>
                                {f.role !== "PROMPT" && f.attachmentId && (
                                  <button aria-label={`Remove ${f.filename}`} className="inline-flex h-7 w-7 items-center justify-center rounded-full text-[var(--color-ink-muted)] hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-danger-ink)]" onClick={() => actions.detach.mutate(f.attachmentId!, { onError: fail })}>
                                    <X className="h-4 w-4" />
                                  </button>
                                )}
                              </span>
                            </li>
                          )
                        })}
                      </ul>
                    )}
                    <input ref={picker} type="file" className="hidden" accept={caps.data?.accept} onChange={(e) => { attach(e.target.files?.[0]); e.target.value = "" }} />
                    <Button size="sm" variant="outline" className="mt-2 gap-1.5" disabled={actions.attach.isPending || life === "ARCHIVED"} onClick={() => picker.current?.click()}>
                      <Paperclip className="h-3.5 w-3.5" /> {actions.attach.isPending ? `Uploading… ${Math.round(progress)}%` : "Add attachment"}
                    </Button>
                  </div>

                  {error && <p role="alert" className="mt-3 text-sm text-[var(--color-danger-ink)]">{error}</p>}

                  <div className="mt-6 flex flex-wrap gap-2">
                    {life !== "PUBLISHED" && <Button onClick={() => actions.publish.mutate(undefined, { onError: fail })} disabled={actions.publish.isPending}>{life === "ARCHIVED" ? "Restore & publish" : "Publish to students"}</Button>}
                    {life === "PUBLISHED" && <Button variant="outline" onClick={() => actions.unpublish.mutate(undefined, { onError: fail })} disabled={actions.unpublish.isPending}>Unpublish</Button>}
                    {life !== "ARCHIVED" && (
                      <Button variant="danger" disabled={actions.archive.isPending} onClick={() => window.confirm("Archive this assignment? Students will no longer see it. Their work and evidence are kept.") && actions.archive.mutate(undefined, { onError: fail })}>
                        Archive
                      </Button>
                    )}
                  </div>
                  {life === "PUBLISHED" && <p className="mt-2 text-xs text-[var(--color-ink-muted)]">Once students have started, an assignment can't return to draft. Archive it instead.</p>}
                </CardContent>
              </Card>

              <h2 className="mb-3 mt-8 max-w-2xl text-sm font-semibold text-[var(--color-ink-muted)]">Submissions</h2>
              {a.submissions.length === 0 ? (
                <div className="max-w-2xl">
                  <EmptyState title="No students yet" description="Students appear here once they join the course with its invite code." />
                </div>
              ) : (
                <div className="max-w-2xl space-y-2">
                  {a.submissions.map((s) =>
                    s.status === "submitted" || s.status === "verified" ? (
                      <Link
                        key={s.studentId}
                        to={`/teacher/courses/${courseId}/assignments/${a.id}/submissions/${s.studentId}`}
                        className="flex items-center justify-between gap-4 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-white px-4 py-3.5 transition-colors hover:bg-[var(--color-surface-muted)]"
                      >
                        <div className="min-w-0">
                          <p className="truncate font-medium text-[var(--color-ink)]">{s.studentName}</p>
                          <p className="truncate text-sm text-[var(--color-ink-soft)]">{statusText[s.status]}</p>
                        </div>
                        <MasteryBadge level={s.mastery} />
                      </Link>
                    ) : (
                      <div key={s.studentId} className="flex items-center justify-between gap-4 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-white px-4 py-3.5 opacity-70">
                        <div className="min-w-0">
                          <p className="truncate font-medium text-[var(--color-ink)]">{s.studentName}</p>
                          <p className="truncate text-sm text-[var(--color-ink-soft)]">{statusText[s.status]}</p>
                        </div>
                        <Badge tone="neutral">Not yet submitted</Badge>
                      </div>
                    )
                  )}
                </div>
              )}
            </>
          )
        }}
      </QueryState>
    </AppShell>
  )
}
