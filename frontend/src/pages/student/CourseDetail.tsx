import { useState } from "react"
import { useParams } from "react-router-dom"
import { AppShell } from "@/components/layout/AppShell"
import { AssignmentRow, MaterialRow } from "@/components/socratiq/ListRow"
import { assignmentStatusLabel } from "@/lib/assignments"
import { EmptyState, NoMatches, QueryState } from "@/components/ui/States"
import { SectionHeading } from "@/components/ui/SectionHeading"
import { useStudentCourse } from "@/lib/queries"
import { matches } from "@/lib/search"

export default function StudentCourseDetail() {
  const { courseId = "" } = useParams()
  const q = useStudentCourse(courseId)
  const [query, setQuery] = useState("")

  return (
    <AppShell
      role="student"
      crumbs={[{ label: "Courses", to: "/student/courses" }, { label: q.data?.course.name ?? "Course" }]}
      search={{ value: query, onChange: setQuery, placeholder: "Search assignments and materials" }}
    >
      <QueryState query={q} what="Course">
        {({ course, assignments, materials }) => {
          const asg = assignments.filter((a) => matches(query, a.title, a.topic, a.prompt, a.status ? assignmentStatusLabel[a.status] : ""))
          const mat = materials.filter((m) => matches(query, m.title, m.summary))
          const searching = query.trim() !== ""
          return (
            <>
              <h1 className="text-xl font-semibold text-[var(--color-ink)]">{course.name}</h1>
              <p className="mt-1 text-sm text-[var(--color-ink-muted)]">{course.description} · {course.teacher}</p>

              {searching && asg.length === 0 && mat.length === 0 ? (
                <div className="mt-8"><NoMatches query={query} onClear={() => setQuery("")} /></div>
              ) : (
                <>
                  <SectionHeading count={assignments.length ? asg.length : undefined}>Assignments</SectionHeading>
                  {assignments.length === 0 ? (
                    <EmptyState title="No assignments yet" description="Your instructor hasn't posted an assignment for this course." />
                  ) : asg.length === 0 ? (
                    <p className="text-sm text-[var(--color-ink-muted)]">No assignments match “{query.trim()}”.</p>
                  ) : (
                    <div className="space-y-2">
                      {asg.map((a) => (
                        <AssignmentRow key={a.id} to={`/student/courses/${course.id}/assignments/${a.id}`} title={a.title} topic={a.topic} status={a.status} dueDate={a.dueDate} />
                      ))}
                    </div>
                  )}

                  <SectionHeading count={materials.length ? mat.length : undefined} className="mt-10">Materials</SectionHeading>
                  {materials.length === 0 ? (
                    <EmptyState title="No materials yet" description="Course readings and slides will show up here once posted." />
                  ) : mat.length === 0 ? (
                    <p className="text-sm text-[var(--color-ink-muted)]">No materials match “{query.trim()}”.</p>
                  ) : (
                    <div className="space-y-2">
                      {mat.map((m) => (
                        <MaterialRow key={m.id} to={`/student/courses/${course.id}/materials/${m.id}`} title={m.title} summary={m.summary} />
                      ))}
                    </div>
                  )}
                </>
              )}
            </>
          )
        }}
      </QueryState>
    </AppShell>
  )
}
