import { Component, forwardRef, lazy, Suspense, type ReactNode } from "react"
import type { BoardIntent } from "@/lib/boardAsk"
import type { Board } from "@/lib/whiteboard"
import { BoardWorkspace as Legacy } from "@/components/socratiq/BoardWorkspace"
import type { BoardApi } from "./SmartBoardWorkspace"

export type { BoardApi }
export interface BoardSurfaceProps {
  assignmentId: string
  courseId?: string
  initial: Board
  readOnly?: boolean
  busy: boolean
  onAsk: (intent: BoardIntent, message: string) => void
  onPersist?: (scene: unknown) => Promise<unknown>
}

// The new drawing engine is large (~3 MB), so it loads only when a board is opened. VITE_SMARTBOARD_ENGINE=legacy keeps the previous board as a fallback
// (it was always part of the main bundle, so it stays a static import and mounts synchronously).
const Native = lazy(() => import("./SmartBoardWorkspace"))
const useLegacy = () => import.meta.env.VITE_SMARTBOARD_ENGINE === "legacy"     // read at render time so tests (and ops) can switch engines

class Boundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  render() {
    if (!this.state.failed) return this.props.children
    return (
      <div role="alert" className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center text-sm">
        <p>The whiteboard hit a problem. Your last saved work is safe.</p>
        <button type="button" className="rounded-lg border border-[var(--color-line)] px-3 py-1.5" onClick={() => location.reload()}>Reload the board</button>
      </div>
    )
  }
}

export const BoardSurface = forwardRef<BoardApi, BoardSurfaceProps>(function BoardSurface(props, ref) {
  return (
    <Boundary>
      <Suspense fallback={<div role="status" className="flex h-full items-center justify-center text-sm text-[var(--color-ink-muted)]">Loading the whiteboard…</div>}>
        {useLegacy() ? <Legacy ref={ref} {...props} /> : <Native ref={ref} {...props} />}
      </Suspense>
    </Boundary>
  )
})
