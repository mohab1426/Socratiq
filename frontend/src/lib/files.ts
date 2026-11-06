import type { Capabilities, FileInfo } from "@/types"

export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export const extensionOf = (name: string) => (name.includes(".") ? name.split(".").pop()!.toLowerCase() : "")

/** Client-side pre-check that mirrors GET /files/capabilities (the server re-validates content, size and type regardless). */
export function precheck(file: File, caps?: Capabilities): string | null {
  const ext = extensionOf(file.name)
  if (!ext) return "This file needs an extension such as .pdf or .docx."
  if (caps) {
    const f = caps.formats.find((x) => x.extension === ext)
    if (!f) return `.${ext} files aren't supported here. Accepted: ${caps.extensions.map((e) => e.toUpperCase()).join(", ")}.`
    if (file.size > f.maxBytes) return `.${ext} files can be at most ${Math.round(f.maxBytes / 1048576)} MB (this one is ${formatBytes(file.size)}).`
  }
  if (file.size === 0) return "This file is empty."
  return null
}

export function statusLabel(f: Pick<FileInfo, "status" | "indexMode">): { text: string; tone: "success" | "warning" | "danger" | "neutral" } {
  switch (f.status) {
    case "QUEUED": return { text: "Queued for processing", tone: "neutral" }
    case "PROCESSING": return { text: "Processing…", tone: "neutral" }
    case "READY": return { text: f.indexMode === "RAG" ? "Ready · searchable by the AI Coach" : "Ready", tone: "success" }
    case "STORED_ONLY": return { text: "Stored (not indexed)", tone: "warning" }
    case "FAILED": return { text: "Processing failed", tone: "danger" }
  }
}
