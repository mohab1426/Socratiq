import { useState } from "react"
import { BoardSurface } from "@/components/smartboard/BoardSurface"
import { EMPTY_BOARD, fromServer, type Board } from "@/lib/whiteboard"

const SCENE_KEY = "socratiq_demo_scene"
const LEGACY_KEY = "socratiq_demo_board"

/** Public sandbox: the board is kept in this browser only. An old demo board (legacy format) is upgraded automatically on first open. */
export default function SmartBoardDemo() {
  const [initialBoard] = useState<Board>(() => {
    try {
      const scene = localStorage.getItem(SCENE_KEY)
      if (scene) return { ...EMPTY_BOARD, scene: JSON.parse(scene) }
      const legacy = localStorage.getItem(LEGACY_KEY)
      if (legacy) return fromServer(JSON.parse(legacy))
    } catch {
      // fall back to an empty board
    }
    return EMPTY_BOARD
  })

  return (
    <main className="h-[100dvh] w-screen overflow-hidden">
      <h1 className="sr-only">SmartBoard demo</h1>
      <BoardSurface
        assignmentId="demo-assignment"
        initial={initialBoard}
        busy={false}
        onAsk={(intent, msg) => console.log("onAsk", intent, msg)}
        onPersist={async (scene) => { localStorage.setItem(SCENE_KEY, JSON.stringify(scene)) }}
      />
    </main>
  )
}
