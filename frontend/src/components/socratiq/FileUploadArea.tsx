import { useRef, useState, type DragEvent } from "react"
import { UploadCloud, FileText, CheckCircle2, AlertCircle, X, RotateCcw, Loader2 } from "lucide-react"
import { cn } from "@/lib/utils"

export type FileUploadStatus = "idle" | "uploading" | "success" | "error"

export interface FileUploadAreaProps {
  file: File | null
  status: FileUploadStatus
  progress?: number
  errorMessage?: string | null
  acceptedExtensions: string[]
  maxSizeMb: number
  onSelect: (file: File) => void
  onRemove: () => void
}

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function extensionOf(name: string) {
  const parts = name.split(".")
  return parts.length > 1 ? parts.pop()!.toLowerCase() : ""
}

export function FileUploadArea({
  file,
  status,
  progress = 0,
  errorMessage,
  acceptedExtensions,
  maxSizeMb,
  onSelect,
  onRemove,
}: FileUploadAreaProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragActive, setDragActive] = useState(false)
  const acceptAttr = acceptedExtensions.map((e) => `.${e}`).join(",")
  const formatList = acceptedExtensions.map((e) => e.toUpperCase()).join(", ")

  function handleFiles(files: FileList | null) {
    const f = files?.[0]
    if (f) onSelect(f)
  }

  function handleDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault()
    setDragActive(false)
    handleFiles(e.dataTransfer.files)
  }

  // Empty state — nothing selected yet.
  if (status === "idle" && !file) {
    return (
      <div>
        <input
          ref={inputRef}
          type="file"
          accept={acceptAttr}
          className="hidden"
          onChange={(e) => handleFiles(e.target.files)}
        />
        <div
          role="button"
          tabIndex={0}
          onClick={() => inputRef.current?.click()}
          onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && inputRef.current?.click()}
          onDragOver={(e) => {
            e.preventDefault()
            setDragActive(true)
          }}
          onDragLeave={() => setDragActive(false)}
          onDrop={handleDrop}
          className={cn(
            "flex w-full cursor-pointer flex-col items-center justify-center gap-2 rounded-[var(--radius-md)] border border-dashed px-4 py-10 text-center transition-colors",
            dragActive
              ? "border-[var(--color-plum)] bg-[var(--color-plum-light)]/40"
              : "border-[var(--color-border-strong)] bg-[var(--color-surface-muted)] hover:bg-white"
          )}
        >
          <UploadCloud className="h-6 w-6 text-[var(--color-teal-dark)]" />
          <p className="text-sm font-medium text-[var(--color-ink)]">
            Click to upload or drag and drop
          </p>
          <p className="text-xs text-[var(--color-ink-muted)]">
            {formatList} · up to {maxSizeMb} MB
          </p>
        </div>
      </div>
    )
  }

  // Invalid / unsupported file.
  if (status === "error") {
    return (
      <div>
        <input
          ref={inputRef}
          type="file"
          accept={acceptAttr}
          className="hidden"
          onChange={(e) => handleFiles(e.target.files)}
        />
        <div className="flex items-start gap-3 rounded-[var(--radius-md)] border border-[var(--color-danger-light)] bg-[var(--color-danger-light)]/40 px-4 py-3.5">
          <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-[var(--color-danger-ink)]" />
          <div className="min-w-0 flex-1">
            {file && <p className="truncate text-sm font-medium text-[var(--color-ink)]">{file.name}</p>}
            <p className="mt-0.5 text-sm text-[var(--color-danger-ink)]">{errorMessage ?? "This file can't be used."}</p>
            <p className="mt-1 text-xs text-[var(--color-ink-muted)]">
              Accepted formats: {formatList} · up to {maxSizeMb} MB
            </p>
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              className="mt-2 inline-flex items-center gap-1.5 text-xs font-medium text-[var(--color-teal-dark)] hover:underline"
            >
              <RotateCcw className="h-3.5 w-3.5" /> Try a different file
            </button>
          </div>
        </div>
      </div>
    )
  }

  // Uploading — progress state.
  if (status === "uploading" && file) {
    return (
      <div className="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-white px-4 py-3.5">
        <div className="flex items-start gap-3">
          <Loader2 className="mt-0.5 h-5 w-5 shrink-0 animate-spin text-[var(--color-teal-dark)]" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-[var(--color-ink)]">{file.name}</p>
            <p className="mt-0.5 text-xs text-[var(--color-ink-soft)]">
              Uploading… {formatSize(file.size)} · {Math.round(progress)}%
            </p>
            <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-[var(--color-surface-muted)]">
              <div
                className="h-full rounded-full bg-[var(--color-plum)] transition-[width] duration-150"
                style={{ width: `${Math.min(100, Math.max(0, progress))}%` }}
              />
            </div>
          </div>
        </div>
      </div>
    )
  }

  // Success — file selected and ready.
  if (status === "success" && file) {
    return (
      <div className="flex items-start gap-3 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-white px-4 py-3.5">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--radius-sm)] bg-[var(--color-success-light)] text-[var(--color-success-ink)]">
          <FileText className="h-4.5 w-4.5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <p className="truncate text-sm font-medium text-[var(--color-ink)]">{file.name}</p>
            <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-[var(--color-success-ink)]" />
          </div>
          <p className="mt-0.5 text-xs text-[var(--color-ink-soft)]">
            {extensionOf(file.name).toUpperCase()} · {formatSize(file.size)} · Ready
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <input
            ref={inputRef}
            type="file"
            accept={acceptAttr}
            className="hidden"
            onChange={(e) => handleFiles(e.target.files)}
          />
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            aria-label="Replace file"
            className="rounded-[var(--radius-sm)] p-1.5 text-[var(--color-ink-soft)] hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-ink)]"
          >
            <RotateCcw className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={onRemove}
            aria-label="Remove file"
            className="rounded-[var(--radius-sm)] p-1.5 text-[var(--color-ink-soft)] hover:bg-[var(--color-danger-light)] hover:text-[var(--color-danger-ink)]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>
    )
  }

  return null
}
