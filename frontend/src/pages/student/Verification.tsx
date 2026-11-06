import { useEffect, useRef, useState } from "react"
import { useParams } from "react-router-dom"
import { AppShell } from "@/components/layout/AppShell"
import { Card, CardContent } from "@/components/ui/Card"
import { Button, ButtonLink } from "@/components/ui/Button"
import { Badge } from "@/components/ui/Badge"
import { ErrorState } from "@/components/ui/States"
import { CheckCircle2 } from "lucide-react"
import { useAnswerVerification, useStartVerification, useStudentAssignment, useStudentCourse, type VerificationState } from "@/lib/queries"
import { ApiError } from "@/lib/api"

const LABEL: Record<string, string> = { EXPLAIN: "Explain", MODIFY: "Modify", TRANSFER: "Transfer" }

export default function Verification() {
  const { courseId = "", assignmentId = "" } = useParams()
  const course = useStudentCourse(courseId)
  const assignment = useStudentAssignment(assignmentId)
  const start = useStartVerification()
  const answerM = useAnswerVerification()

  const [state, setState] = useState<VerificationState | null>(null)
  const [answer, setAnswer] = useState("")
  const [feedback, setFeedback] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [blocked, setBlocked] = useState<string | null>(null)
  const began = useRef(false)

  async function begin() {
    setError(null)
    try {
      setState(await start.mutateAsync(assignmentId))
    } catch (e) {
      if (e instanceof ApiError && e.code === "not_submitted") setBlocked("Submit your work first, then come back for the verification.")
      else setError(e instanceof ApiError ? e.message : "We couldn't start the verification.")
    }
  }

  useEffect(() => {
    if (!began.current) {
      began.current = true
      void begin()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function submit() {
    if (!state || !answer.trim()) return
    setError(null)
    try {
      const r = await answerM.mutateAsync({ verificationId: state.verificationId, answer })
      setFeedback(r.result.feedback || null)
      setAnswer("")
      setState(r.state)
    } catch (e) {
      setError(
        e instanceof ApiError && e.code === "ai_unavailable" ? "We couldn't evaluate your answer just now. It wasn't recorded, so you can send it again."
        : e instanceof ApiError ? e.message : "Your answer couldn't be sent."
      )
    }
  }

  const back = `/student/courses/${courseId}/assignments/${assignmentId}`
  const done = state?.status === "COMPLETED"
  const current = state?.current
  const stepIndex = state ? Math.max(0, state.steps.findIndex((s) => s.status === "current")) : 0

  return (
    <AppShell
      role="student"
      crumbs={[
        { label: "Courses", to: "/student/courses" },
        { label: course.data?.course.name ?? "Course", to: `/student/courses/${courseId}` },
        { label: assignment.data?.title ?? "Assignment", to: back },
        { label: "Verification" },
      ]}
    >
      {blocked ? (
        <ErrorState title="Not ready yet" description={blocked} />
      ) : (
        <Card className="mx-auto max-w-2xl">
          <CardContent>
            {!done ? (
              <>
                <p className="text-xs font-medium text-[var(--color-teal-dark)]">Show what you understand</p>
                <h1 className="mt-1 text-lg font-semibold text-[var(--color-ink)]">{assignment.data?.title}</h1>
                <p className="mt-1 text-sm text-[var(--color-ink-soft)]">
                  A short conversation about the solution you submitted — this isn't a re-test, it's a chance to show the reasoning behind your work.
                </p>

                <div className="mt-5 flex gap-2">
                  {(state?.steps ?? [{ type: "EXPLAIN" }, { type: "MODIFY" }, { type: "TRANSFER" }]).map((s, i) => (
                    <span key={s.type} className={`h-1.5 flex-1 rounded-full ${i <= stepIndex ? "bg-[var(--color-teal)]" : "bg-[var(--color-border)]"}`} />
                  ))}
                </div>

                {feedback && (
                  <p role="status" className="mt-4 rounded-[var(--radius-md)] border border-[var(--color-teal-light)] bg-[var(--color-teal-light)]/40 px-3 py-2 text-sm text-[var(--color-ink-soft)]">
                    <span className="font-medium text-[var(--color-ink)]">On your last answer: </span>
                    {feedback}
                  </p>
                )}

                {current ? (
                  <>
                    <div className="mt-5 rounded-[var(--radius-md)] bg-[var(--color-surface-muted)] p-4">
                      <Badge tone="teal">{LABEL[current.type] ?? current.type}</Badge>
                      <p id="verification-question" className="mt-2 text-[var(--color-ink)]">{current.question}</p>
                    </div>
                    <textarea
                      value={answer}
                      onChange={(e) => setAnswer(e.target.value)}
                      rows={5}
                      maxLength={8000}
                      aria-label="Your response"
                      aria-describedby="verification-question"
                      placeholder="Write your response…"
                      className="mt-4 w-full rounded-[var(--radius-md)] border border-[var(--color-control-border)] p-3 text-sm placeholder:text-[var(--color-ink-muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-teal-dark)]"
                    />
                  </>
                ) : (
                  <p className="mt-5 text-sm text-[var(--color-ink-soft)]" aria-live="polite">
                    {start.isPending || answerM.isPending ? "Preparing your question…" : state?.needsQuestion ? "Your next question isn't ready yet." : "Loading…"}
                  </p>
                )}

                {error && (
                  <p role="alert" className="mt-3 text-sm text-[var(--color-danger-ink)]">
                    {error}
                  </p>
                )}

                <div className="mt-4 flex justify-between">
                  <ButtonLink to={back} variant="outline">Go back</ButtonLink>
                  {current ? (
                    <Button onClick={submit} disabled={!answer.trim() || answerM.isPending}>
                      {answerM.isPending ? "Sending…" : stepIndex < 2 ? "Continue" : "Finish verification"}
                    </Button>
                  ) : (
                    <Button onClick={begin} disabled={start.isPending}>
                      Retry
                    </Button>
                  )}
                </div>
              </>
            ) : (
              <div className="flex flex-col items-center py-8 text-center">
                <CheckCircle2 className="h-10 w-10 text-[var(--color-teal-dark)]" />
                <h2 className="mt-3 text-lg font-semibold text-[var(--color-ink)]">Verification complete</h2>
                <p className="mt-1 max-w-sm text-sm text-[var(--color-ink-soft)]">
                  Your reasoning has been added to this assignment's learning evidence. Your instructor will see it alongside your submission.
                </p>
                <ButtonLink to={back} className="mt-5">Back to assignment</ButtonLink>
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </AppShell>
  )
}
