import { useState, type FormEvent } from "react"
import { useNavigate, useParams } from "react-router-dom"
import { AppShell } from "@/components/layout/AppShell"
import { Card, CardContent } from "@/components/ui/Card"
import { Input } from "@/components/ui/Input"
import { Field } from "@/components/ui/Field"
import { Button } from "@/components/ui/Button"
import { FileUploadArea, type FileUploadStatus } from "@/components/socratiq/FileUploadArea"
import { ApiError } from "@/lib/api"
import { useCapabilities, useCreateAssignment, useTeacherCourse } from "@/lib/queries"
import { precheck } from "@/lib/files"
import { cn } from "@/lib/utils"

type CreationMode = "manual" | "upload"

export default function NewAssignment() {
  const { courseId = "" } = useParams()
  const navigate = useNavigate()
  const courseQ = useTeacherCourse(courseId)
  const course = courseQ.data?.course
  const caps = useCapabilities("ASSIGNMENT_ATTACHMENT", "PROMPT")
  const create = useCreateAssignment(courseId)

  const [mode, setMode] = useState<CreationMode>("manual")

  const [title, setTitle] = useState("")
  const [topic, setTopic] = useState("")
  const [prompt, setPrompt] = useState("")
  const [dueDate, setDueDate] = useState("")
  const [publish, setPublish] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [file, setFile] = useState<File | null>(null)
  const [fileStatus, setFileStatus] = useState<FileUploadStatus>("idle")
  const [fileError, setFileError] = useState<string | null>(null)
  const [fileProgress, setFileProgress] = useState(0)

  // Only formats whose text can really be read become the prompt; the list comes from the backend, not a hard-coded guess.
  const promptFormats = (caps.data?.formats ?? []).filter((f) => f.mode === "EXTRACT_ONLY")
  const promptCaps = caps.data && { ...caps.data, formats: promptFormats, extensions: promptFormats.map((f) => f.extension) }

  function handleFileSelect(selected: File) {
    setError(null)
    setFile(selected)
    const problem = precheck(selected, promptCaps)
    if (problem) {
      setFileStatus("error")
      setFileError(problem)
      return
    }
    setFileError(null)
    setFileStatus("success")            // valid and ready; it is uploaded when you create the assignment
  }

  function handleFileRemove() {
    setFile(null)
    setFileStatus("idle")
    setFileError(null)
    setFileProgress(0)
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)

    if (mode === "manual") {
      if (!title || !prompt) {
        setError("Give the assignment a title and a prompt to continue.")
        return
      }
    } else {
      if (!title) {
        setError("Give the assignment a title to continue.")
        return
      }
      if (!file || fileStatus !== "success") {
        setError("Choose a valid assignment file to continue.")
        return
      }
    }

    // The AI assistance policy for the Socratic coach is configured internally by SocratiQ (new assignments start GUIDED);
    // it is not a teacher-facing setting, in either creation mode.
    const dueAt = dueDate ? new Date(`${dueDate}T23:59:00`).toISOString() : null
    if (mode === "upload") setFileStatus("uploading")
    try {
      await create.mutateAsync({ input: { title: title.trim(), topic: topic.trim(), prompt, dueAt, publish }, file: mode === "upload" ? file : null, onProgress: setFileProgress })
      navigate(`/teacher/courses/${courseId}`)
    } catch (err) {
      if (mode === "upload") setFileStatus("success")
      setError(err instanceof ApiError ? (err.details?.[0]?.message ?? err.message) : "The assignment couldn't be created. Try again.")
    }
  }

  return (
    <AppShell
      role="teacher"
      crumbs={[
        { label: "Courses", to: "/teacher/courses" },
        { label: course?.name ?? "Course", to: `/teacher/courses/${courseId}` },
        { label: "New assignment" },
      ]}
    >
      <h1 className="text-xl font-semibold text-[var(--color-ink)]">New assignment</h1>
      <p className="mt-1 text-sm text-[var(--color-ink-soft)]">{course?.name}</p>

      <Card className="mt-6 max-w-xl">
        <CardContent>
          <div className="mb-5">
            <p id="create-mode-label" className="mb-2 block text-sm font-medium text-[var(--color-ink)]">
              How do you want to create this assignment?
            </p>
            <div role="group" aria-labelledby="create-mode-label" className="inline-flex rounded-full border border-[var(--color-border-strong)] bg-[var(--color-surface-muted)] p-1">
              <ModeButton active={mode === "manual"} onClick={() => setMode("manual")}>
                Create manually
              </ModeButton>
              <ModeButton active={mode === "upload"} onClick={() => setMode("upload")}>
                Upload file
              </ModeButton>
            </div>
          </div>

          <form className="space-y-4" onSubmit={handleSubmit} noValidate>
            <Field id="assignment-title" label="Title">
              <Input id="assignment-title" placeholder="e.g. Implement Gradient Descent" value={title} onChange={(e) => setTitle(e.target.value)} />
            </Field>
            <Field id="assignment-topic" label="Topic">
              <Input id="assignment-topic" placeholder="e.g. Linear Regression" value={topic} onChange={(e) => setTopic(e.target.value)} />
            </Field>

            {mode === "manual" ? (
              <Field id="assignment-prompt" label="Prompt">
                <textarea
                  id="assignment-prompt"
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  rows={4}
                  placeholder="Describe what students need to do…"
                  className="w-full rounded-[var(--radius-md)] border border-[var(--color-control-border)] p-3 text-sm placeholder:text-[var(--color-ink-muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-teal-dark)]"
                />
              </Field>
            ) : (
              <div role="group" aria-labelledby="assignment-file-label">
                <p id="assignment-file-label" className="mb-1 block text-sm font-medium text-[var(--color-ink)]">
                  Assignment file
                </p>
                <p className="mb-2 text-xs text-[var(--color-ink-muted)]">
                  Upload the assignment document — we'll use it as the prompt students see.
                </p>
                <FileUploadArea
                  file={file}
                  status={fileStatus}
                  progress={fileProgress}
                  errorMessage={fileError}
                  acceptedExtensions={promptCaps?.extensions ?? []}
                  maxSizeMb={Math.round((promptCaps?.maxBytes ?? 26214400) / 1048576)}
                  onSelect={handleFileSelect}
                  onRemove={handleFileRemove}
                />
              </div>
            )}

            <Field id="assignment-due" label="Due date">
              <Input id="assignment-due" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
            </Field>
            <label className="flex items-center gap-2 text-sm text-[var(--color-ink-soft)]">
              <input type="checkbox" checked={publish} onChange={(e) => setPublish(e.target.checked)} className="h-4 w-4 accent-[var(--color-plum)]" />
              Publish to students now (otherwise it stays a draft you can publish later)
            </label>

            {error && (
              <p role="alert" className="text-sm text-[var(--color-danger-ink)]">
                {error}
              </p>
            )}

            <div className="flex items-center justify-between pt-1">
              <Button type="button" variant="outline" onClick={() => navigate(-1)}>
                Cancel
              </Button>
              <Button type="submit" disabled={create.isPending || (mode === "upload" && fileStatus === "uploading")}>
                {create.isPending ? (mode === "upload" && fileProgress > 0 && fileProgress < 100 ? `Uploading… ${Math.round(fileProgress)}%` : "Creating…") : "Create assignment"}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </AppShell>
  )
}

function ModeButton({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "rounded-full px-3.5 py-1.5 text-sm font-medium transition-colors",
        active ? "bg-[var(--color-plum)] text-[var(--color-on-plum)]" : "text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]"
      )}
    >
      {children}
    </button>
  )
}
