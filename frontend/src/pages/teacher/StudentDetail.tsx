import { useParams } from "react-router-dom"
import { ArrowRight } from "lucide-react"
import { AppShell } from "@/components/layout/AppShell"
import { Avatar } from "@/components/ui/Avatar"
import { Badge } from "@/components/ui/Badge"
import { ButtonLink } from "@/components/ui/Button"
import { PageIntro } from "@/components/ui/PageIntro"
import { QueryState } from "@/components/ui/States"
import { MasteryBadge } from "@/components/socratiq/MasteryBadge"
import { RiskPanel } from "@/components/socratiq/RiskPanel"
import { StudentSkeleton } from "@/components/socratiq/Skeletons"
import { AiUsagePanel, AssignmentProgress, ConceptPanel, LearningTimeline, VerificationPanel, reviewPath } from "@/components/socratiq/StudentSections"
import { useCourses, useTeacherStudent } from "@/lib/queries"
import type { Course } from "@/types"
import { relativeTime } from "@/lib/time"

const SECTIONS = [
  ["review", "Review overview"], ["timeline", "Learning process"], ["coach", "Coach activity"],
  ["concepts", "Concepts"], ["verification", "Verification"], ["progress", "Assignments"],
] as const

/** Investigation flow: who -> is anything flagged and why -> what happened -> Coach use -> concepts -> verification -> progress. */
export default function StudentDetail() {
  const { studentId = "" } = useParams()
  const q = useTeacherStudent(studentId)
  const allCourses = useCourses("teacher").data ?? []

  return (
    <AppShell role="teacher" crumbs={[{ label: "Dashboard", to: "/teacher" }, { label: q.data?.name ?? "Student" }]}>
      <QueryState query={q} what="Student" skeleton={<StudentSkeleton />}>
        {(student) => {
          const courses = student.courseIds.map((id) => allCourses.find((c) => c.id === id)).filter((c): c is Course => c !== undefined)
          const titles = Object.fromEntries(student.assignments.map((a) => [a.assignmentId, a.title]))
          const courseOf = Object.fromEntries(student.assignments.map((a) => [a.assignmentId, a.courseId]))
          const submissionLink = (assignmentId: string) => (courseOf[assignmentId] ? reviewPath(courseOf[assignmentId], assignmentId, student.id) : null)
          const latest = student.assignments.find((a) => a.submitted)
          const submitted = student.assignments.filter((a) => a.submitted).length
          return (
            <div className="mx-auto max-w-7xl space-y-5">
              <PageIntro
                leading={<Avatar name={student.name} className="h-14 w-14 text-base" />}
                eyebrow="Student"
                title={student.name}
                subtitle={<>{student.email} · Last activity {relativeTime(student.lastActivityAt)}</>}
                meta={
                  <>
                    {courses.map((c) => <Badge key={c.id} tone="slate">{c.name}</Badge>)}
                    <Badge tone="neutral">Submitted {submitted} of {student.assignments.length}</Badge>
                    <MasteryBadge level={student.mastery} />
                  </>
                }
                actions={
                  <>
                    {latest && <ButtonLink to={reviewPath(latest.courseId, latest.assignmentId, student.id)} size="sm" variant="outline" className="gap-1.5">Latest submission <ArrowRight className="h-4 w-4" aria-hidden="true" /></ButtonLink>}
                    {student.courseIds[0] && <ButtonLink to={`/teacher/courses/${student.courseIds[0]}`} size="sm" variant="ghost">Course page</ButtonLink>}
                  </>
                }
              />

              <nav aria-label="On this page" className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
                {SECTIONS.map(([id, label]) => (
                  <a key={id} href={`#${id}`} className="shrink-0 rounded-full border border-[var(--color-border-strong)] bg-white px-3 py-1 text-sm text-[var(--color-ink-muted)] transition-colors hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-ink)]">{label}</a>
                ))}
              </nav>

              <RiskPanel risk={student.risk} assignmentTitles={titles} submissionLink={submissionLink} />

              <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-5">
                <div className="lg:col-span-3"><LearningTimeline entries={student.timeline} studentId={student.id} /></div>
                <div className="space-y-5 lg:col-span-2">
                  <AiUsagePanel usage={student.aiUsage} />
                  <ConceptPanel concepts={student.concepts} />
                </div>
              </div>

              <VerificationPanel runs={student.verification} studentId={student.id} />
              <AssignmentProgress items={student.assignments} studentId={student.id} />
            </div>
          )
        }}
      </QueryState>
    </AppShell>
  )
}
