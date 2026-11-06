import { useMemo, useState } from "react"
import { useNavigate } from "react-router-dom"
import { AppShell } from "@/components/layout/AppShell"
import { CourseCard, JoinCourseCard } from "@/components/socratiq/CourseCard"
import { AssignmentRow } from "@/components/socratiq/ListRow"
import { assignmentStatusLabel, isDone } from "@/lib/assignments"
import { NoMatches, QueryState } from "@/components/ui/States"
import { Button } from "@/components/ui/Button"
import { SectionHeading } from "@/components/ui/SectionHeading"
import { useAuth } from "@/lib/auth"
import { useStudentHome } from "@/lib/queries"
import { matches } from "@/lib/search"
import { dueInfo } from "@/lib/dates"
import type { Assignment } from "@/types"

const INITIAL = 6

/** Work that needs attention first (soonest / overdue), then undated work, then what's already handed in. */
function byUrgency(a: Assignment, b: Assignment) {
  const group = (x: Assignment) => (isDone(x.status) ? 2 : x.dueDate ? 0 : 1)
  const g = group(a) - group(b)
  if (g) return g
  const ta = dueInfo(a.dueDate).time ?? 0
  const tb = dueInfo(b.dueDate).time ?? 0
  return group(a) === 2 ? tb - ta : ta - tb
}

export default function StudentHome() {
  const navigate = useNavigate()
  const { me } = useAuth()
  const home = useStudentHome()
  const [query, setQuery] = useState("")
  const [showAll, setShowAll] = useState(false)

  const view = useMemo(() => {
    const d = home.data
    if (!d) return null
    const courseName = new Map(d.courses.map((c) => [c.id, c]))
    const assignments = [...d.assignments]
      .filter((a) => {
        const c = courseName.get(a.courseId)
        return matches(query, a.title, a.topic, c?.name, c?.code, a.status ? assignmentStatusLabel[a.status] : "")
      })
      .sort(byUrgency)
    const courses = d.courses.filter((c) => matches(query, c.name, c.code, c.description, c.teacher))
    return { assignments, courses, courseName }
  }, [home.data, query])

  return (
    <AppShell role="student" crumbs={[{ label: "Home" }]} search={{ value: query, onChange: setQuery, placeholder: "Search assignments and courses" }}>
      <h1 className="text-xl font-semibold text-[var(--color-ink)]">Welcome back, {me?.firstName ?? me?.name.split(" ")[0]}</h1>
      <p className="mt-1 text-sm text-[var(--color-ink-muted)]">Pick up where you left off, or explore a course.</p>

      <QueryState query={home} what="Home">
        {() => {
          if (!view) return null
          const searching = query.trim() !== ""
          const nothing = searching && view.assignments.length === 0 && view.courses.length === 0
          if (nothing) return <div className="mt-8"><NoMatches query={query} onClear={() => setQuery("")} /></div>

          const shown = searching || showAll ? view.assignments : view.assignments.slice(0, INITIAL)
          return (
            <>
              {view.assignments.length > 0 && (
                <>
                  <SectionHeading count={view.assignments.length}>Assignments</SectionHeading>
                  <div className="space-y-2">
                    {shown.map((a) => (
                      <AssignmentRow
                        key={a.id}
                        to={`/student/courses/${a.courseId}/assignments/${a.id}`}
                        title={a.title}
                        topic={[view.courseName.get(a.courseId)?.name, a.topic].filter(Boolean).join(" · ")}
                        status={a.status}
                        dueDate={a.dueDate}
                      />
                    ))}
                  </div>
                  {!searching && view.assignments.length > INITIAL && (
                    <Button variant="ghost" size="sm" className="mt-2" onClick={() => setShowAll((s) => !s)}>
                      {showAll ? "Show fewer" : `Show all ${view.assignments.length} assignments`}
                    </Button>
                  )}
                </>
              )}

              <SectionHeading count={view.courses.length}>Your courses</SectionHeading>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {view.courses.map((c) => (
                  <CourseCard key={c.id} course={c} to={`/student/courses/${c.id}`} />
                ))}
                {!searching && <JoinCourseCard onClick={() => navigate("/student/join")} />}
              </div>
            </>
          )
        }}
      </QueryState>
    </AppShell>
  )
}
