import { useState } from "react"
import { useNavigate } from "react-router-dom"
import { AppShell } from "@/components/layout/AppShell"
import { CourseCard, JoinCourseCard } from "@/components/socratiq/CourseCard"
import { NoMatches, QueryState } from "@/components/ui/States"
import { useCourses } from "@/lib/queries"
import { matches } from "@/lib/search"

export default function TeacherCourses() {
  const navigate = useNavigate()
  const courses = useCourses("teacher")
  const [query, setQuery] = useState("")
  return (
    <AppShell role="teacher" crumbs={[{ label: "Courses" }]} search={{ value: query, onChange: setQuery, placeholder: "Search courses" }}>
      <h1 className="text-xl font-semibold text-[var(--color-ink)]">Your courses</h1>
      <div className="mt-6">
        <QueryState query={courses} what="Courses">
          {(all) => {
            const list = all.filter((c) => matches(query, c.name, c.code, c.description))
            if (all.length > 0 && list.length === 0) return <NoMatches query={query} onClear={() => setQuery("")} />
            return (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {list.map((c) => (
                  <div key={c.id} className="flex flex-col">
                    <CourseCard course={c} to={`/teacher/courses/${c.id}`} />
                    <p className="mt-2 px-1 text-xs text-[var(--color-ink-muted)]">{c.studentCount ?? 0} students</p>
                  </div>
                ))}
                {!query.trim() && <JoinCourseCard label="Add course" onClick={() => navigate("/teacher/courses/new")} />}
              </div>
            )
          }}
        </QueryState>
      </div>
    </AppShell>
  )
}
