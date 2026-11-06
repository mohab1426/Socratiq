import { lazy, Suspense, useState } from "react"
import { Link, useNavigate } from "react-router-dom"
import { Activity, ClipboardCheck, FileText, Plus, RefreshCw, ShieldCheck, Users } from "lucide-react"
import { AppShell } from "@/components/layout/AppShell"
import { MetricCard } from "@/components/socratiq/MetricCard"
import { AttentionCenter } from "@/components/socratiq/AttentionCenter"
import { StudentsTable } from "@/components/socratiq/StudentsTable"
import { AttentionList } from "@/components/socratiq/AttentionList"
import { ActivityFeed, type ActivityFeedEntry } from "@/components/socratiq/ActivityFeed"
import { AssignmentRow } from "@/components/socratiq/ListRow"
import { DashboardBodySkeleton, DashboardSkeleton } from "@/components/socratiq/Skeletons"
import { ChartCard } from "@/components/charts/ChartCard"
import { Badge } from "@/components/ui/Badge"
import { Button, ButtonLink } from "@/components/ui/Button"
import { PageIntro } from "@/components/ui/PageIntro"
import { Panel } from "@/components/ui/Panel"
import { SectionHeading } from "@/components/ui/SectionHeading"
import { EmptyState, QueryState } from "@/components/ui/States"
import { useCourses, useDashboard, useTeacherCourse } from "@/lib/queries"
import { relativeTime } from "@/lib/time"
import { cn } from "@/lib/utils"

// recharts is the heaviest dependency; load it only when a teacher opens the analytics.
const TeacherAnalytics = lazy(() => import("@/components/socratiq/TeacherAnalytics"))

const lifecycleText = { DRAFT: "Draft", PUBLISHED: "Published", ARCHIVED: "Archived" } as const
const lifecycleTone = { DRAFT: "neutral", PUBLISHED: "success", ARCHIVED: "slate" } as const

function AnalyticsFallback() {
  return (
    <div className="grid gap-4 lg:grid-cols-2" aria-busy="true">
      {["Assignments by state", "Submissions per assignment", "Mastery across students", "Recent learning activity"].map((t) => (
        <ChartCard key={t} title={t} description="Loading…" state="loading">{null}</ChartCard>
      ))}
    </div>
  )
}

/**
 * Teacher dashboard. Reading order = teacher workflow: where am I -> what is happening (counted numbers) -> who needs me (main focus)
 * -> what happened recently / how the course is progressing -> the whole roster -> optional class analytics.
 * Every number is returned by the dashboard API; nothing is computed or estimated here.
 */
export default function TeacherDashboard() {
  const navigate = useNavigate()
  const courses = useCourses("teacher")
  const [picked, setPicked] = useState<string | null>(null)
  const [showAnalytics, setShowAnalytics] = useState(false)
  const activeId = picked ?? courses.data?.[0]?.id
  const dash = useDashboard(activeId)
  const detail = useTeacherCourse(activeId)
  const course = courses.data?.find((c) => c.id === activeId)
  const classrooms = detail.data?.classrooms.map((k) => k.name).join(", ")

  return (
    <AppShell role="teacher" crumbs={[{ label: "Dashboard" }, ...(course ? [{ label: course.name }] : [])]}>
      {/* While loading, on error, or with no course there is no PageIntro, so keep a page heading for assistive tech. */}
      {!course && <h1 className="sr-only">Dashboard</h1>}
      <QueryState query={courses} what="Dashboard" skeleton={<DashboardSkeleton />}>
        {(list) =>
          list.length === 0 || !course ? (
            <EmptyState title="Create your first course" description="Your dashboard fills in as students join and work on assignments." action={{ label: "Create a course", onClick: () => navigate("/teacher/courses/new") }} />
          ) : (
            <div className="mx-auto max-w-7xl">
              {list.length > 1 && (
                <div role="group" aria-label="Choose a course" className="mb-5 flex flex-wrap gap-2">
                  {list.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      aria-pressed={c.id === activeId}
                      onClick={() => setPicked(c.id)}
                      className={cn(
                        "rounded-full border px-3.5 py-1.5 text-sm font-medium transition-colors",
                        c.id === activeId
                          ? "border-[var(--color-plum)] bg-[var(--color-plum)] text-[var(--color-on-plum)]"
                          : "border-[var(--color-border-strong)] bg-white text-[var(--color-ink-muted)] hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-ink)]"
                      )}
                    >
                      {c.name}
                    </button>
                  ))}
                </div>
              )}

              {/* 1. Header */}
              <PageIntro
                title={course.name}
                subtitle={<>{course.code}{classrooms ? ` · ${classrooms}` : ""}{course.teacher ? ` · ${course.teacher}` : ""}</>}
                meta={<Badge tone={course.status === "Active" ? "success" : "slate"}>{course.status}</Badge>}
                actions={
                  <>
                    <span className="text-xs text-[var(--color-ink-muted)]" role="status" aria-live="polite">
                      {dash.isFetching ? "Refreshing…" : dash.dataUpdatedAt ? `Updated ${relativeTime(new Date(dash.dataUpdatedAt).toISOString())}` : ""}
                    </span>
                    <Button type="button" size="sm" variant="outline" onClick={() => void dash.refetch()} disabled={dash.isFetching} className="gap-1.5">
                      <RefreshCw className={cn("h-3.5 w-3.5", dash.isFetching && "animate-spin motion-reduce:animate-none")} aria-hidden="true" /> Refresh
                    </Button>
                    <ButtonLink to={`/teacher/courses/${course.id}/assignments/new`} size="sm" className="gap-1.5">
                      <Plus className="h-4 w-4" aria-hidden="true" /> New assignment
                    </ButtonLink>
                  </>
                }
              />

              <QueryState query={dash} what="Dashboard" skeleton={<DashboardBodySkeleton />}>
                {(d) => {
                  const nameOf = new Map(d.students.map((s) => [s.id, s.name]))
                  const feed = (d.activity as ActivityFeedEntry[]).map((e) => ({ ...e, studentName: e.studentName ?? (e.studentId ? nameOf.get(e.studentId) : undefined) }))
                  const assignments = detail.data?.assignments ?? []
                  const o = d.overview
                  const dist = o.riskDistribution
                  const todo = d.attention.filter((a) => a.kind !== "signal")
                  return (
                    <>
                      {/* 2. At a glance: only numbers counted from real rows */}
                      {/* 5 cards: no orphans at any width. Phones 2+2+1 (last spans the row); sm-xl 3+2 on a 6-column grid; xl one row of 5. */}
                      <div className="mt-5 grid grid-cols-2 gap-3 max-sm:[&>*:last-child]:col-span-2 sm:max-xl:grid-cols-6 sm:max-xl:[&>*]:col-span-2 sm:max-xl:[&>*:nth-child(n+4)]:col-span-3 xl:grid-cols-5">
                        <MetricCard icon={<Users className="h-4 w-4" />} value={String(o.students)} label="Students" hint="Active enrolments" />
                        <MetricCard icon={<Activity className="h-4 w-4" />} value={String(o.activeStudents)} label="Active students" hint="Activity in the last 14 days" />
                        <MetricCard icon={<ClipboardCheck className="h-4 w-4" />} emphasis={o.needsReview > 0} value={String(o.needsReview)} label="Need review" hint={o.needsSupport > 0 ? `${o.needsSupport} more need learning support` : "Moderate or high review level"} />
                        <MetricCard icon={<FileText className="h-4 w-4" />} value={String(o.assignments)} label="Assignments" hint="Published" />
                        <MetricCard icon={<ShieldCheck className="h-4 w-4" />} value={String(o.verificationsCompleted)} label="Verifications" hint="Completed" />
                      </div>

                      {/* 2b. Progress: completion and verification are shares of real submissions; average grade exists only once an instructor has graded work */}
                      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
                        <MetricCard icon={<ClipboardCheck className="h-4 w-4" />} value={`${d.metrics.assignmentCompletion}%`} percent={d.metrics.assignmentCompletion} label="Assignment completion" hint="Submitted work across the class" />
                        <MetricCard icon={<ShieldCheck className="h-4 w-4" />} value={`${d.metrics.verificationRate}%`} percent={d.metrics.verificationRate} label="Verification rate" hint="Submissions whose verification showed understanding" />
                        <MetricCard
                          icon={<FileText className="h-4 w-4" />}
                          value={d.metrics.averageGrade == null ? "—" : `${d.metrics.averageGrade}%`}
                          percent={d.metrics.averageGrade ?? undefined}
                          label="Average grade"
                          hint={d.metrics.averageGrade == null ? "No graded work yet. Grade a submission to see this." : "Mean of each student's latest graded submission"}
                        />
                      </div>

                      {/* 3. Attention center: the main focus */}
                      <div className="mt-6">
                        <AttentionCenter rows={d.reviewQueue} disclaimer={d.riskDisclaimer} courseId={course.id} />
                      </div>
                      {todo.length > 0 && (
                        <div className="mt-4">
                          <AttentionList items={todo} title="Recent verifications and deadlines" />
                        </div>
                      )}

                      {/* 4. Recent activity | course progress */}
                      <div className="mt-6 grid grid-cols-1 gap-5 lg:grid-cols-5">
                        <Panel id="activity" className="lg:col-span-3" title="Recent activity" description="Latest submissions, revisions, verifications and Coach conversations.">
                          <ActivityFeed entries={feed.slice(0, 8)} emptyLabel="No recent student activity yet. It appears here as students work." />
                        </Panel>
                        <Panel
                          id="progress"
                          className="lg:col-span-2"
                          title="Course progress"
                          description="Submissions per assignment."
                          right={<Link to={`/teacher/courses/${course.id}`} className="inline-flex min-h-6 items-center text-sm font-medium text-[var(--color-teal-dark)] hover:underline">View all</Link>}
                        >
                          <div className="space-y-2">
                            {detail.isPending && <p className="text-sm text-[var(--color-ink-muted)]">Loading assignments…</p>}
                            {detail.isError && <p className="text-sm text-[var(--color-ink-muted)]">We couldn't load the assignments. Refresh to try again.</p>}
                            {!detail.isPending && !detail.isError && assignments.length === 0 && <p className="text-sm text-[var(--color-ink-muted)]">No assignments yet. Create one to start collecting learning evidence.</p>}
                            {assignments.map((a) => (
                              <AssignmentRow
                                key={a.id}
                                to={`/teacher/courses/${course.id}/assignments/${a.id}`}
                                title={a.title}
                                topic={`${a.submittedCount}/${a.studentCount} submitted`}
                                dueDate={a.dueDate}
                                done={a.lifecycle === "ARCHIVED" || (a.studentCount > 0 && a.submittedCount >= a.studentCount)}
                                badge={<Badge tone={lifecycleTone[a.lifecycle ?? "DRAFT"]}>{lifecycleText[a.lifecycle ?? "DRAFT"]}</Badge>}
                              />
                            ))}
                          </div>
                        </Panel>
                      </div>

                      {/* 5. Roster */}
                      <SectionHeading
                        count={d.students.length}
                        right={<span className="text-xs text-[var(--color-ink-muted)]">Review levels: {dist.low} low · {dist.moderate} moderate · {dist.high} high · {dist.insufficient} insufficient evidence</span>}
                      >
                        Students
                      </SectionHeading>
                      {d.students.length === 0 ? (
                        <EmptyState title="No students yet" description="Students will appear here once they join the classroom. Share the invite code from the course page." />
                      ) : (
                        <StudentsTable students={d.students} />
                      )}

                      {/* 6. Class analytics load (and cost) nothing until asked for */}
                      <div className="mt-8">
                        <Button type="button" variant="outline" size="sm" aria-expanded={showAnalytics} aria-controls="class-analytics" onClick={() => setShowAnalytics((v) => !v)}>
                          {showAnalytics ? "Hide class analytics" : "Show class analytics"}
                        </Button>
                        {showAnalytics && (
                          <div id="class-analytics" className="mt-4">
                            <Suspense fallback={<AnalyticsFallback />}>
                              <TeacherAnalytics dashboard={d} assignments={detail.data?.assignments} assignmentsState={detail.isError ? "error" : detail.isPending ? "loading" : "ready"} />
                            </Suspense>
                          </div>
                        )}
                      </div>
                    </>
                  )
                }}
              </QueryState>
            </div>
          )
        }
      </QueryState>
    </AppShell>
  )
}
