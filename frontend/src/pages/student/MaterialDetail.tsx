import { useState } from "react"
import { useParams } from "react-router-dom"
import { AppShell } from "@/components/layout/AppShell"
import { Card, CardContent } from "@/components/ui/Card"
import { Button } from "@/components/ui/Button"
import { QueryState } from "@/components/ui/States"
import { downloadFile, useStudentCourse, useStudentMaterial } from "@/lib/queries"
import { formatBytes } from "@/lib/files"
import { ApiError } from "@/lib/api"

export default function StudentMaterialDetail() {
  const { courseId = "", materialId = "" } = useParams()
  const course = useStudentCourse(courseId)
  const material = useStudentMaterial(materialId)
  const [dlError, setDlError] = useState<string | null>(null)

  async function download(fileId: string) {
    setDlError(null)
    try {
      await downloadFile(fileId)
    } catch (e) {
      setDlError(e instanceof ApiError ? e.message : "The download couldn't be started.")
    }
  }

  return (
    <AppShell
      role="student"
      crumbs={[{ label: "Courses", to: "/student/courses" }, { label: course.data?.course.name ?? "Course", to: `/student/courses/${courseId}` }, { label: material.data?.title ?? "Material" }]}
    >
      <QueryState query={material} what="Material">
        {(m) => (
          <Card className="max-w-2xl">
            <CardContent>
              <h1 className="text-lg font-semibold text-[var(--color-ink)]">{m.title}</h1>
              <p className="mt-1 text-sm text-[var(--color-ink-muted)]">{course.data?.course.name}</p>
              <p className="mt-4 text-[var(--color-ink-soft)]">{m.summary}</p>
              {m.file && (
                <p className="mt-2 text-xs text-[var(--color-ink-muted)]">
                  {m.file.filename} · {m.file.extension.toUpperCase()} · {formatBytes(m.file.sizeBytes)}
                </p>
              )}
              {dlError && (
                <p role="alert" className="mt-3 text-sm text-[var(--color-danger-ink)]">
                  {dlError}
                </p>
              )}
              <div className="mt-6 flex flex-wrap gap-2">
                <Button variant="outline" onClick={() => history.back()}>
                  Go back
                </Button>
                {m.file && <Button onClick={() => download(m.file!.fileId)}>Download</Button>}
              </div>
            </CardContent>
          </Card>
        )}
      </QueryState>
    </AppShell>
  )
}
