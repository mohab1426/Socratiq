/** Small, pure helpers between the Excalidraw scene and the rest of the app (all unit-tested; no React, no engine calls). */
import { ApiError } from "../api"
import { readMeta } from "./meta"
import type { SceneEl } from "./types"

/** Text on the board, as DATA for the model: id + clipped text, most recently edited first, bounded. */
export function boardDigest(elements: readonly SceneEl[], max = 40): { id: string; text: string }[] {
  return elements
    .filter((e) => !e.isDeleted && e.type === "text" && typeof e.text === "string" && e.text.trim())
    .sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0))
    .slice(0, max)
    .map((e) => ({ id: e.id, text: e.text!.replace(/\s+/g, " ").trim().slice(0, 160) }))
}

/** The legacy id the Coach knows the selected element by (it addresses elements by legacy id), or null for native-only elements. */
export function selectedLegacyId(elements: readonly SceneEl[], selected: Record<string, boolean | undefined>): string | null {
  const byId = new Map(elements.map((e) => [e.id, e]))
  for (const id of Object.keys(selected)) {
    if (!selected[id]) continue
    const e = byId.get(id)
    if (!e) continue
    const owner = e.containerId ? byId.get(e.containerId) ?? e : e
    const legacy = readMeta(owner)?.legacyId
    if (legacy) return legacy
  }
  return null
}

/** Errors that retrying cannot fix: too large (413), invalid (422), attempt closed or no access (403/404/409). */
export const isPermanentSaveError = (e: unknown): boolean => e instanceof ApiError && [403, 404, 409, 413, 422].includes(e.status)

export function describeSaveError(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 413 || e.code === "board_too_large") return "The board is too large to save. Remove some images or very large drawings."
    if (e.status === 409) return "This assignment was submitted, so the board can no longer be changed."
    if (e.status === 403 || e.status === 404) return "You can't save to this board."
    if (e.status === 401) return "Your session expired. Sign in again to keep saving."
    if (e.status === 0) return "Can't reach the server. Your work is kept here and will save when you're back online."
    return e.message || "Could not save."
  }
  return e instanceof Error ? e.message : "Could not save."
}

export function describeAiError(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 422) return "The AI couldn't produce a clear diagram for that. Try rephrasing, or name the kind of drawing you want (flowchart, cycle, comparison, labelled diagram)."
    if (e.status === 503) return "The drawing assistant isn't available right now."
    if (e.status === 0) return "Can't reach the server."
    return e.message || "The drawing assistant failed."
  }
  return e instanceof Error ? e.message : "The drawing assistant failed."
}

/** Cheap change signature for a scene: unchanged elements keep their version, so this moves only on real edits. */
export const sceneSignature = (elements: readonly { version: number; isDeleted?: boolean }[]) => {
  let sum = 0
  for (const e of elements) sum += e.version
  return `${elements.length}:${sum}`
}
