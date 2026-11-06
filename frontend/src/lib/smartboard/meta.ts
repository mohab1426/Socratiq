import { SOCRATIQ_KEY, type Author, type SceneEl } from "./types"

/**
 * SocratiQ metadata stored in the engine's own `customData` extension point (no invented element properties).
 * - `author`: who produced the element. Absent means "student" (everything drawn with the normal tools).
 * - `opId`: the AI operation that created it. One id per insertion, also the idempotency key for retries.
 * - `legacyId`: id of the pre-Excalidraw board element this was migrated or mirrored from.
 */
export interface SocratiqMeta {
  v: 1
  author: Author
  opId?: string
  role?: string
  legacyId?: string
  originalAuthor?: Author
}

const AUTHORS: readonly Author[] = ["student", "ai", "coach"]

export function readMeta(el: Pick<SceneEl, "customData">): SocratiqMeta | null {
  const raw = el.customData?.[SOCRATIQ_KEY]
  if (!raw || typeof raw !== "object") return null
  const m = raw as Partial<SocratiqMeta>
  if (!m.author || !AUTHORS.includes(m.author)) return null
  return { v: 1, author: m.author, opId: typeof m.opId === "string" ? m.opId : undefined, role: typeof m.role === "string" ? m.role : undefined,
    legacyId: typeof m.legacyId === "string" ? m.legacyId : undefined, originalAuthor: m.originalAuthor && AUTHORS.includes(m.originalAuthor) ? m.originalAuthor : undefined }
}

export const authorOf = (el: Pick<SceneEl, "customData">): Author => readMeta(el)?.author ?? "student"
export const isAiElement = (el: Pick<SceneEl, "customData">) => authorOf(el) === "ai"
export const opIdOf = (el: Pick<SceneEl, "customData">) => readMeta(el)?.opId

export function withMeta(customData: Record<string, unknown> | undefined, meta: Omit<SocratiqMeta, "v">): Record<string, unknown> {
  const clean: Record<string, unknown> = { v: 1, author: meta.author }
  if (meta.opId) clean.opId = meta.opId
  if (meta.role) clean.role = meta.role
  if (meta.legacyId) clean.legacyId = meta.legacyId
  if (meta.originalAuthor) clean.originalAuthor = meta.originalAuthor
  return { ...(customData ?? {}), [SOCRATIQ_KEY]: clean }
}
