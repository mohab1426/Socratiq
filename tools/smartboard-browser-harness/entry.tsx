import React, { useRef, useState, useEffect } from "react"
import { createRoot } from "react-dom/client"
import { SmartBoard } from "@/components/socratiq/SmartBoard"
import { EMPTY_BOARD, type Board } from "@/lib/whiteboard"

declare global { interface Window { __t: any } }

function App() {
  const init = (window as any).__init || {}
  const [board, setBoard] = useState<Board>(init.board ?? EMPTY_BOARD)
  const [view, setView] = useState(init.view ?? { x: 0, y: 0, scale: 0.5 })
  const [tool, setTool] = useState<string>(init.tool ?? "pen")
  const [color, setColor] = useState<string>(init.color ?? "#000000")
  const [width, setWidth] = useState<number>(init.width ?? 4)
  const [sel, setSel] = useState<string | null>(null)
  const live = useRef({ board, view, tool })
  live.current = { board, view, tool }
  useEffect(() => {
    window.__t = {
      get: () => JSON.parse(JSON.stringify(live.current)),
      set: (p: any) => {
        if (p.board) setBoard(p.board)
        if (p.view) setView(p.view)
        if (p.tool) setTool(p.tool)
        if (p.color) setColor(p.color)
        if (p.width) setWidth(p.width)
      },
    }
  }, [])
  return (
    <div style={{ position: "fixed", inset: 0 }}>
      <SmartBoard
        board={board}
        onChange={(b: Board) => setBoard(b)}
        tool={tool as any}
        currentColor={color}
        strokeWidth={width}
        viewState={view}
        onViewChange={(v: any) => setView(v)}
        onToolChange={(t: any) => setTool(t)}
        selectedId={sel}
        onSelect={(id: any) => setSel(id)}
        emptyHint={false}
      />
    </div>
  )
}
createRoot(document.getElementById("root")!).render(<App />)
