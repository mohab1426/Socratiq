import { useState } from "react"
import { useNavigate, useParams } from "react-router-dom"
import { AppShell } from "@/components/layout/AppShell"
import { Card, CardContent } from "@/components/ui/Card"
import { Button, ButtonLink } from "@/components/ui/Button"
import { Badge } from "@/components/ui/Badge"
import { QueryState } from "@/components/ui/States"
import { downloadFile, useMaterialActions, useTeacherCourse, useTeacherMaterial } from "@/lib/queries"
import { formatBytes, statusLabel } from "@/lib/files"
import { ApiError } from "@/lib/api"

export default function TeacherMaterialDetail() {
  const { courseId = "", materialId = "" } = useParams()
  const navigate = useNavigate()
  const course = useTeacherCourse(courseId).data?.course
  const q = useTeacherMaterial(materialId)
  const actions = useMaterialActions(courseId)
  const [error, setError] = useState<string | null>(null)

  const fail = (e: unknown) => setError(e instanceof ApiError ? e.message : "That didn't work. Try again.")

  return (
    <AppShell
      role="teacher"
      crumbs={[{ label: "Courses", to: "/teacher/courses" }, { label: course?.name ?? "Course", to: `/teacher/courses/${courseId}` }, { label: q.data?.title ?? "Material" }]}
    >
      <QueryState query={q} what="Material">
        {(m) => {
          const f = m.file
          const st = f ? statusLabel(f) : null
          return (
            <Card className="max-w-2xl">
              <CardContent>
                <div className="flex items-start justify-between gap-3">
                  <h1 className="text-lg font-semibold text-[var(--color-ink)]">{m.title}</h1>
                  {st && <Badge tone={st.tone}>{st.text}</Badge>}
                </div>
                <p className="mt-3 text-sm text-[var(--color-ink-soft)]">{m.summary}</p>
                {f && (
                  <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
                    <dt className="text-[var(--color-ink-muted)]">File</dt><dd className="truncate text-[var(--color-ink)]">{f.filename}</dd>
                    <dt className="text-[var(--color-ink-muted)]">Type</dt><dd className="text-[var(--color-ink)]">{f.mimeType}</dd>
                    <dt className="text-[var(--color-ink-muted)]">Size</dt><dd className="text-[var(--color-ink)]">{formatBytes(f.sizeBytes)}</dd>
                    {f.pageCount ? (<><dt className="text-[var(--color-ink-muted)]">Pages / slides / sheets</dt><dd className="text-[var(--color-ink)]">{f.pageCount}</dd></>) : null}
                  </dl>
                )}
                {f?.status === "FAILED" && (
                  <p role="alert" className="mt-4 rounded-[var(--radius-md)] border border-[var(--color-danger-light)] bg-[var(--color-danger-light)]/40 px-3 py-2 text-sm text-[var(--color-danger-ink)]">
                    {f.error}
                  </p>
                )}
                {f?.note && f.status !== "FAILED" && <p className="mt-4 text-sm text-[var(--color-ink-soft)]">{f.note}</p>}
                {error && <p role="alert" className="mt-3 text-sm text-[var(--color-danger-ink)]">{error}</p>}

                <div className="mt-6 flex flex-wrap gap-2">
                  {f && <Button variant="outline" onClick={() => downloadFile(f.fileId).catch(fail)}>Download original</Button>}
                  {f && f.indexMode === "RAG" && (f.status === "FAILED" || f.status === "READY") && (
                    <Button variant="secondary" disabled={actions.retry.isPending} onClick={() => actions.retry.mutate(m.id, { onError: fail })}>
                      {f.status === "FAILED" ? "Retry processing" : "Re-index"}
                    </Button>
                  )}
                  <ButtonLink to={`/teacher/courses/${courseId}/materials/new`} variant="outline">Upload another</ButtonLink>
                  <Button
                    variant="danger"
                    disabled={actions.remove.isPending}
                    onClick={() => {
                      if (window.confirm("Remove this material? It will also stop being available to the AI Coach.")) {
                        actions.remove.mutate(m.id, { onSuccess: () => navigate(`/teacher/courses/${courseId}`), onError: fail })
                      }
                    }}
                  >
                    Remove
                  </Button>
                </div>
              </CardContent>
            </Card>
          )
        }}
      </QueryState>
    </AppShell>
  )
}
