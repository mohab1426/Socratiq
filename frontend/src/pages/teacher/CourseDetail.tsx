import { useState } from "react"
import { useNavigate, useParams } from "react-router-dom"
import { AppShell } from "@/components/layout/AppShell"
import { AssignmentRow, MaterialRow } from "@/components/socratiq/ListRow"
import { Button, ButtonLink } from "@/components/ui/Button"
import { Badge } from "@/components/ui/Badge"
import { Card, CardContent } from "@/components/ui/Card"
import { EmptyState, NoMatches, QueryState } from "@/components/ui/States"
import { SectionHeading } from "@/components/ui/SectionHeading"
import { matches } from "@/lib/search"
import { Copy, Plus, RefreshCw, UploadCloud } from "lucide-react"
import { useRotateJoinCode, useTeacherCourse } from "@/lib/queries"
import { statusLabel } from "@/lib/files"

const lifecycleTone = { DRAFT: "neutral", PUBLISHED: "success", ARCHIVED: "slate" } as const
const lifecycleText = { DRAFT: "Draft", PUBLISHED: "Published", ARCHIVED: "Archived" } as const

export default function TeacherCourseDetail() {
  const { courseId = "" } = useParams()
  const navigate = useNavigate()
  const q = useTeacherCourse(courseId)
  const rotate = useRotateJoinCode()
  const [copied, setCopied] = useState(false)
  const [query, setQuery] = useState("")

  return (
    <AppShell role="teacher" crumbs={[{ label: "Courses", to: "/teacher/courses" }, { label: q.data?.course.name ?? "Course" }]} search={{ value: query, onChange: setQuery, placeholder: "Search assignments and materials" }}>
      <QueryState query={q} what="Course">
        {({ course, classrooms, assignments: allAssignments, materials: allMaterials }) => {
          const assignments = allAssignments.filter((a) => matches(query, a.title, a.topic, lifecycleText[a.lifecycle ?? "DRAFT"]))
          const materials = allMaterials.filter((m) => matches(query, m.title, m.summary))
          const searching = query.trim() !== ""
          return (
          <>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h1 className="text-xl font-semibold text-[var(--color-ink)]">{course.name}</h1>
                <p className="mt-1 text-sm text-[var(--color-ink-soft)]">{course.studentCount ?? 0} students · {course.status}</p>
              </div>
              <ButtonLink to={`/teacher`} variant="outline" size="sm">Open dashboard</ButtonLink>
            </div>

            {classrooms.map((k) => (
              <Card key={k.id} className="mt-5 max-w-md">
                <CardContent className="space-y-2">
                  <p className="text-xs font-semibold text-[var(--color-ink-muted)]">Invite code{classrooms.length > 1 ? ` · ${k.name}` : ""}</p>
                  <div className="flex items-center justify-between gap-3">
                    <code className="text-lg font-semibold tracking-widest text-[var(--color-ink)]">{k.joinCode}</code>
                    <div className="flex gap-1.5">
                      <Button size="sm" variant="outline" className="gap-1.5" onClick={() => { void navigator.clipboard?.writeText(k.joinCode); setCopied(true); setTimeout(() => setCopied(false), 1500) }}>
                        <Copy className="h-3.5 w-3.5" /> {copied ? "Copied" : "Copy"}
                      </Button>
                      <Button size="sm" variant="outline" className="gap-1.5" disabled={rotate.isPending} title="Old code stops working immediately" onClick={() => rotate.mutate(k.id)}>
                        <RefreshCw className="h-3.5 w-3.5" /> New code
                      </Button>
                    </div>
                  </div>
                  <p className="text-xs text-[var(--color-ink-muted)]">Students enter this code under “Join a course”. Generating a new one doesn't remove anyone already enrolled.</p>
                </CardContent>
              </Card>
            ))}

            <SectionHeading className="mt-8">Assignments</SectionHeading>
            {searching && assignments.length === 0 && materials.length === 0 ? (
              <NoMatches query={query} onClear={() => setQuery("")} />
            ) : allAssignments.length === 0 ? (
              <EmptyState
                title="No assignments yet"
                description="Create an assignment so students have something to work on."
                action={{ label: "New assignment", onClick: () => navigate(`/teacher/courses/${course.id}/assignments/new`) }}
              />
            ) : assignments.length === 0 ? (
              <p className="text-sm text-[var(--color-ink-muted)]">No assignments match “{query.trim()}”.</p>
            ) : (
              <div className="space-y-2">
                {assignments.map((a) => (
                  <AssignmentRow
                    key={a.id}
                    to={`/teacher/courses/${course.id}/assignments/${a.id}`}
                    title={a.title}
                    topic={`${a.topic || "No topic"} · ${a.submittedCount}/${a.studentCount} submitted`}
                    badge={<Badge tone={lifecycleTone[a.lifecycle ?? "DRAFT"]}>{lifecycleText[a.lifecycle ?? "DRAFT"]}</Badge>}
                    dueDate={a.dueDate}
                    done={a.lifecycle === "ARCHIVED" || (a.studentCount > 0 && a.submittedCount >= a.studentCount)}
                  />
                ))}
              </div>
            )}

            <SectionHeading className="mt-10">Materials</SectionHeading>
            {searching && assignments.length === 0 && materials.length === 0 ? null : allMaterials.length === 0 ? (
              <EmptyState
                title="No materials yet"
                description="Upload a reading, slide deck, spreadsheet or notes for this course."
                action={{ label: "Upload material", onClick: () => navigate(`/teacher/courses/${course.id}/materials/new`) }}
              />
            ) : materials.length === 0 ? (
              <p className="text-sm text-[var(--color-ink-muted)]">No materials match “{query.trim()}”.</p>
            ) : (
              <div className="space-y-2">
                {materials.map((m) => {
                  const st = m.file ? statusLabel(m.file) : null
                  return (
                    <MaterialRow key={m.id} to={`/teacher/courses/${course.id}/materials/${m.id}`} title={m.title} summary={m.summary}
                      badge={st ? <Badge tone={st.tone}>{st.text}</Badge> : undefined} />
                  )
                })}
              </div>
            )}

            <div className="mt-5 flex flex-wrap gap-2">
              <ButtonLink to={`/teacher/courses/${course.id}/assignments/new`} variant="secondary" className="gap-1.5">
                  <Plus className="h-4 w-4" /> New assignment
                </ButtonLink>
              <ButtonLink to={`/teacher/courses/${course.id}/materials/new`} variant="outline" className="gap-1.5">
                  <UploadCloud className="h-4 w-4" /> Upload material
                </ButtonLink>
            </div>
          </>
          )
        }}
      </QueryState>
    </AppShell>
  )
}
