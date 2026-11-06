/**
 * Persistence of the native board.
 *
 * What is stored is Excalidraw's own serialization (`serializeAsJSON`: elements, a reduced appState, referenced image files) plus the
 * viewport, under `whiteboard.scene`. Never a screenshot. Legacy fields (`steps`, `strokes`, `elements`) are left untouched on the server:
 * once a scene exists it is the source of truth for the student's work, and older clients keep working on the legacy data.
 */
import { restoreAppState, restoreElements, serializeAsJSON } from "@excalidraw/excalidraw"
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types"
import type { AppState, BinaryFiles } from "@excalidraw/excalidraw/types"

export const SCENE_VERSION = 2
/** Stay below the server's cap (2.5 MB) so a save is refused locally, with a clear message, before the network round trip. */
export const SCENE_MAX_BYTES = 2_400_000
export const FILE_RECOMPRESS_ABOVE = 220_000

export interface StoredScene {
  version: number
  type: "excalidraw"
  source?: string
  elements: Record<string, unknown>[]
  appState: Record<string, unknown>
  files: Record<string, { mimeType: string; id: string; dataURL: string; created: number; lastRetrieved?: number }>
  view?: { scrollX: number; scrollY: number; zoom: number }
}

export function buildStoredScene(elements: readonly ExcalidrawElement[], appState: Partial<AppState>, files: BinaryFiles): StoredScene {
  const parsed = JSON.parse(serializeAsJSON(elements, appState as AppState, files, "local")) as StoredScene
  const view = appState.zoom && typeof appState.scrollX === "number" ? { scrollX: appState.scrollX, scrollY: appState.scrollY ?? 0, zoom: appState.zoom.value } : undefined
  return { ...parsed, version: SCENE_VERSION, view }
}

export const sceneBytes = (s: StoredScene) => new TextEncoder().encode(JSON.stringify(s)).length

export function restoreStoredScene(stored: StoredScene): { elements: ExcalidrawElement[]; appState: Partial<AppState>; files: BinaryFiles } {
  const elements = restoreElements((stored.elements ?? []) as never, null, { repairBindings: true, refreshDimensions: false }) as ExcalidrawElement[]
  const appState = restoreAppState((stored.appState ?? {}) as never, null) as Partial<AppState>
  if (stored.view && Number.isFinite(stored.view.zoom)) Object.assign(appState, { scrollX: stored.view.scrollX, scrollY: stored.view.scrollY, zoom: { value: stored.view.zoom } })
  return { elements, appState, files: (stored.files ?? {}) as unknown as BinaryFiles }
}

/** Is this server payload one we can open as a native scene? */
export const isStoredScene = (v: unknown): v is StoredScene =>
  !!v && typeof v === "object" && Array.isArray((v as StoredScene).elements) && typeof (v as StoredScene).appState === "object" && (v as StoredScene).type === "excalidraw"

/** Downscale oversized images for storage only (the live scene keeps the original). The compressor is injected: canvas in the browser, a fake in tests. */
export async function compressSceneFiles(scene: StoredScene, compress: (dataURL: string) => Promise<string>, cache = new Map<string, string>()): Promise<StoredScene> {
  const files: StoredScene["files"] = {}
  for (const [id, f] of Object.entries(scene.files)) {
    if (f.dataURL.length <= FILE_RECOMPRESS_ABOVE) { files[id] = f; continue }
    let small = cache.get(id)
    if (!small) { try { small = await compress(f.dataURL) } catch { small = f.dataURL } cache.set(id, small) }
    files[id] = small.length < f.dataURL.length ? { ...f, mimeType: small.startsWith("data:image/jpeg") ? "image/jpeg" : f.mimeType, dataURL: small } : f
  }
  return { ...scene, files }
}

export async function browserImageCompressor(dataURL: string, maxSide = 1280, quality = 0.78): Promise<string> {
  const img = new Image()
  await new Promise<void>((res, rej) => { img.onload = () => res(); img.onerror = () => rej(new Error("image decode failed")); img.src = dataURL })
  const k = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight))
  const c = document.createElement("canvas")
  c.width = Math.max(1, Math.round(img.naturalWidth * k)); c.height = Math.max(1, Math.round(img.naturalHeight * k))
  const ctx = c.getContext("2d")
  if (!ctx) throw new Error("no 2d context")
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height); ctx.drawImage(img, 0, 0, c.width, c.height)
  return c.toDataURL("image/jpeg", quality)
}
