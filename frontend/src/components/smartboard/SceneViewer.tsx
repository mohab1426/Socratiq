import "./assetPath"
import "@excalidraw/excalidraw/index.css"
import { Excalidraw } from "@excalidraw/excalidraw"
import { useMemo } from "react"
import { authorOf } from "@/lib/smartboard/meta"
import { isStoredScene, restoreStoredScene } from "@/lib/smartboard/scene"
import type { SceneEl } from "@/lib/smartboard/types"

/** Read-only view of a student's native board (teacher review). Content written by SocratiQ (the Coach or the drawing assistant) is drawn with a teal edge. */
export default function SceneViewer({ scene, height = 520 }: { scene: unknown; height?: number }) {
  const init = useMemo(() => {
    if (!isStoredScene(scene)) return null
    const r = restoreStoredScene(scene)
    const elements = r.elements.map((e) => (authorOf(e as SceneEl) === "student" ? e : { ...e, strokeColor: e.type === "text" ? "#0f766e" : "#0d9488" }))
    return { elements, files: r.files, appState: { viewBackgroundColor: r.appState.viewBackgroundColor ?? "#ffffff" }, scrollToContent: true }
  }, [scene])
  if (!init) return <p className="text-sm text-[var(--color-ink-muted)]">This board could not be displayed.</p>
  return (
    <div style={{ height }} className="overflow-hidden rounded-lg border border-[var(--color-line)]" role="img" aria-label="The student's whiteboard (read-only)">
      <Excalidraw initialData={init} viewModeEnabled zenModeEnabled UIOptions={{ canvasActions: { loadScene: false, saveToActiveFile: false, export: false, toggleTheme: false, clearCanvas: false, changeViewBackgroundColor: false } }} />
    </div>
  )
}
