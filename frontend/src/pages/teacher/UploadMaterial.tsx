import { useState, type FormEvent } from "react"
import { useNavigate, useParams } from "react-router-dom"
import { AppShell } from "@/components/layout/AppShell"
import { Card, CardContent } from "@/components/ui/Card"
import { Input } from "@/components/ui/Input"
import { Button } from "@/components/ui/Button"
import { FileUploadArea, type FileUploadStatus } from "@/components/socratiq/FileUploadArea"
import { ApiError } from "@/lib/api"
import { useCapabilities, useTeacherCourse, useUploadMaterial } from "@/lib/queries"
import { extensionOf, precheck } from "@/lib/files"

export default function UploadMaterial() {
  const { courseId = "" } = useParams()
  const navigate = useNavigate()
  const course = useTeacherCourse(courseId).data?.course
  const caps = useCapabilities("MATERIAL")
  const upload = useUploadMaterial(courseId)

  const [title, setTitle] = useState("")
  const [file, setFile] = useState<File | null>(null)
  const [status, setStatus] = useState<FileUploadStatus>("idle")
  const [fileError, setFileError] = useState<string | null>(null)
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState<string | null>(null)

  const format = file && caps.data?.formats.find((f) => f.extension === extensionOf(file.name))

  function select(f: File) {
    setError(null)
    setFile(f)
    const problem = precheck(f, caps.data)
    setFileError(problem)
    setStatus(problem ? "error" : "success")
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    if (!file || status !== "success") {
      setError("Choose a valid file to continue.")
      return
    }
    setStatus("uploading")
    try {
      await upload.mutateAsync({ file, title: title.trim() || undefined, onProgress: setProgress })
      navigate(`/teacher/courses/${courseId}`)     // the course page shows the file's processing status
    } catch (err) {
      setStatus("success")
      setError(err instanceof ApiError ? err.message : "The upload didn't finish. Try again.")
    }
  }

  return (
    <AppShell
      role="teacher"
      crumbs={[{ label: "Courses", to: "/teacher/courses" }, { label: course?.name ?? "Course", to: `/teacher/courses/${courseId}` }, { label: "Upload material" }]}
    >
      <h1 className="text-xl font-semibold text-[var(--color-ink)]">Upload material</h1>
      <p className="mt-1 text-sm text-[var(--color-ink-soft)]">{course?.name}</p>

      <Card className="mt-6 max-w-xl">
        <CardContent>
          <form className="space-y-4" onSubmit={handleSubmit} noValidate>
            <div>
              <label htmlFor="mat-title" className="mb-1 block text-sm font-medium text-[var(--color-ink-soft)]">Title (optional)</label>
              <Input id="mat-title" placeholder="Defaults to the file name" value={title} onChange={(e) => setTitle(e.target.value)} />
            </div>
            <div>
              <label className="mb-2 block text-sm font-medium text-[var(--color-ink-soft)]">File</label>
              <FileUploadArea
                file={file}
                status={status}
                progress={progress}
                errorMessage={fileError}
                acceptedExtensions={caps.data?.extensions ?? []}
                maxSizeMb={Math.round((caps.data?.maxBytes ?? 26214400) / 1048576)}
                onSelect={select}
                onRemove={() => { setFile(null); setStatus("idle"); setFileError(null); setProgress(0) }}
              />
              {format && status === "success" && (
                <p className="mt-2 text-xs text-[var(--color-ink-soft)]">
                  {format.label}:{" "}
                  {format.mode === "RAG" ? "the text will be extracted and made searchable by the AI Coach." : (format.note ?? "stored and downloadable; not indexed.")}
                </p>
              )}
            </div>

            {error && (
              <p role="alert" className="text-sm text-[var(--color-danger-ink)]">
                {error}
              </p>
            )}

            <div className="flex items-center justify-between pt-1">
              <Button type="button" variant="outline" onClick={() => navigate(-1)}>
                Cancel
              </Button>
              <Button type="submit" disabled={upload.isPending || status === "uploading"}>
                {upload.isPending ? `Uploading… ${Math.round(progress)}%` : "Upload material"}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </AppShell>
  )
}
