import { useState } from "react"
import { useNavigate } from "react-router-dom"
import { AppShell } from "@/components/layout/AppShell"
import { CourseCard, JoinCourseCard } from "@/components/socratiq/CourseCard"
import { EmptyState, NoMatches, QueryState } from "@/components/ui/States"
import { useCourses } from "@/lib/queries"
import { matches } from "@/lib/search"

export default function StudentCourses() {
  const navigate = useNavigate()
  const courses = useCourses("student")
  const [query, setQuery] = useState("")
  return (
    <AppShell role="student" crumbs={[{ label: "Home", to: "/student" }, { label: "Courses" }]} search={{ value: query, onChange: setQuery, placeholder: "Search courses" }}>
      <h1 className="text-xl font-semibold text-[var(--color-ink)]">All courses</h1>

      <div className="mt-6">
        <QueryState query={courses} what="Courses">
          {(all) => {
            const list = all.filter((c) => matches(query, c.name, c.code, c.description, c.teacher))
            if (all.length === 0)
              return (
                <EmptyState
                  title="No courses yet"
                  description="Join a course with the invite code your instructor shared to see it here."
                  action={{ label: "Join a course", onClick: () => navigate("/student/join") }}
                />
              )
            if (list.length === 0) return <NoMatches query={query} onClear={() => setQuery("")} />
            return (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {list.map((c) => (
                  <CourseCard key={c.id} course={c} to={`/student/courses/${c.id}`} />
                ))}
                {!query.trim() && <JoinCourseCard onClick={() => navigate("/student/join")} />}
              </div>
            )
          }}
        </QueryState>
      </div>
    </AppShell>
  )
}
