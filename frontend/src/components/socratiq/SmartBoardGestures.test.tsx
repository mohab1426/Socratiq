// @vitest-environment jsdom
/**
 * Gesture-level regression tests: drawing, shapes, connectors, eraser, resize/rotate, multi-drag, pinch,
 * coordinates under zoom/pan, and keyboard focus. They mount the real SmartBoard (and, for history and
 * keyboard cases, the real BoardWorkspace) in jsdom. jsdom has no layout, so the viewport size and the stage
 * rectangle are stubbed; the stage rectangle FOLLOWS the current pan/zoom exactly like the CSS transform does
 * in a browser. These are component tests with stubbed layout, NOT end-to-end browser tests.
 */
import React, { useLayoutEffect, useState } from "react"
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { installDomStubs } from "@/test/domStubs"
import { BOARD_H, BOARD_W, EMPTY_BOARD, arrowEndpoints, type Board, type BoardElement } from "@/lib/whiteboard"
import { highlighterWidth } from "@/lib/toolSettings"
import { SmartBoard, type Tool } from "./SmartBoard"

const mocks = vi.hoisted(() => ({ saveWhiteboard: vi.fn(async (..._a: any[]) => ({})) }))
vi.mock("@/lib/queries", () => ({ saveWhiteboard: mocks.saveWhiteboard }))
import { BoardWorkspace } from "./BoardWorkspace"

type View = { x: number; y: number; scale: number }
let viewNow: View = { x: 0, y: 0, scale: 1 }
const VW = 1000
const VH = 700

beforeEach(() => {
  installDomStubs()
  vi.clearAllMocks()
  ;(globalThis as any).requestAnimationFrame = (cb: FrameRequestCallback) => { cb(0); return 1 }
  ;(globalThis as any).cancelAnimationFrame = () => {}
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get() { return this.hasAttribute("data-board-viewport") ? VW : 0 } })
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get() { return this.hasAttribute("data-board-viewport") ? VH : 0 } })
  const r = (l: number, t: number, w: number, h: number) => ({ left: l, top: t, width: w, height: h, right: l + w, bottom: t + h, x: l, y: t, toJSON() {} }) as DOMRect
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    if (this.hasAttribute("data-board-viewport")) return r(0, 0, VW, VH)
    if (this.getAttribute("role") === "group") return r(-viewNow.x * viewNow.scale, -viewNow.y * viewNow.scale, BOARD_W * viewNow.scale, BOARD_H * viewNow.scale)
    return r(0, 0, 0, 0)
  }
})
afterEach(() => {
  cleanup()
  delete (HTMLElement.prototype as any).clientWidth
  delete (HTMLElement.prototype as any).clientHeight
})

// ------------------------------------------------------------------------------------------------ harness
interface Api {
  board: Board
  view: View
  calls: Array<{ board: Board; coalesce?: string }>
  setBoard: (f: (b: Board) => Board) => void
  setView: (v: View) => void
}
const newApi = (): Api => ({ board: EMPTY_BOARD, view: viewNow, calls: [], setBoard: () => {}, setView: () => {} })

function publish(api: Api, v: { board: Board; view: View; setBoard: Api["setBoard"]; setView: Api["setView"] }) {
  viewNow = v.view
  Object.assign(api, v)
}

function Harness({ api, initial, tool, view0, selectedIds, filled, currentColor, strokeWidth }: {
  api: Api; initial: Board; tool: Tool; view0?: View; selectedIds?: string[]; filled?: boolean; currentColor?: string; strokeWidth?: number
}) {
  const [board, setBoard] = useState(initial)
  const [view, setView] = useState<View>(view0 ?? { x: 0, y: 0, scale: 1 })
  // Publish state to the test AFTER render (not during it), before any pointer event can observe it.
  useLayoutEffect(() => publish(api, { board, view, setBoard, setView }), [api, board, view])
  return (
    <SmartBoard
      board={board}
      tool={tool}
      viewState={view}
      onViewChange={setView}
      selectedIds={selectedIds ?? []}
      onSelectionChange={() => {}}
      filled={filled}
      currentColor={currentColor}
      strokeWidth={strokeWidth}
      onChange={(b, o) => { api.calls.push({ board: b, coalesce: o?.coalesce }); setBoard(b) }}
    />
  )
}
const mountBoard = (props: Partial<React.ComponentProps<typeof Harness>> & { tool: Tool }) => {
  const api = newApi()
  const utils = render(<Harness api={api} initial={EMPTY_BOARD} {...props} />)
  const overlay = () => utils.container.querySelector<HTMLElement>('div[style*="crosshair"], div[style*="cursor: text"]')!
  return { api, overlay, ...utils }
}
const ptr = (type: "pointerDown" | "pointerMove" | "pointerUp" | "pointerCancel", el: Element, x: number, y: number, extra: Record<string, unknown> = {}) =>
  act(() => { (fireEvent as any)[type](el, { pointerId: 1, pointerType: "mouse", button: 0, clientX: x, clientY: y, ...extra }) })
const dragOn = (el: Element, from: [number, number], to: [number, number]) => {
  ptr("pointerDown", el, ...from)
  ptr("pointerMove", el, to[0], to[1])
  ptr("pointerUp", el, ...to)
}
const winMove = (x: number, y: number) => act(() => { window.dispatchEvent(new MouseEvent("pointermove", { clientX: x, clientY: y })) })
const winUp = () => act(() => { window.dispatchEvent(new MouseEvent("pointerup")) })
const el = (over: Partial<BoardElement> & { id: string; kind: BoardElement["kind"] }): BoardElement =>
  ({ author: "student", seq: 0, x: 100, y: 100, w: 100, h: 60, ...over }) as BoardElement
const boardOf = (...els: BoardElement[]): Board => ({ ...EMPTY_BOARD, elements: els, nextSeq: els.length })
const last = (api: Api) => api.calls.at(-1)!.board
const ellipse = (c: HTMLElement) => c.querySelector('ellipse[stroke="#6b7280"]')

// ------------------------------------------------------------------------------------------------ coordinates
describe("pen / highlighter: pointer -> board coordinates under zoom and pan", () => {
  it.each<[string, View]>([
    ["1x, no pan", { x: 0, y: 0, scale: 1 }],
    ["0.5x", { x: 0, y: 0, scale: 0.5 }],
    ["0.5x panned", { x: 300, y: 200, scale: 0.5 }],
    ["2x panned", { x: 150, y: 90, scale: 2 }],
    ["5x (max zoom)", { x: 400, y: 300, scale: 5 }],
  ])("%s", (_n, view) => {
    const { api, overlay } = mountBoard({ tool: "pen", view0: view })
    dragOn(overlay(), [400, 300], [520, 380])
    const s = last(api).strokes[0]
    const first = [Math.round(view.x + 400 / view.scale), Math.round(view.y + 300 / view.scale)]
    const lastPt = [Math.round(view.x + 520 / view.scale), Math.round(view.y + 380 / view.scale)]
    expect(s.pts[0]).toEqual(first)
    expect(s.pts[s.pts.length - 1]).toEqual(lastPt)
  })

  it("points left of / above the board are clamped to its edge (no negative world coordinates are stored)", () => {
    const { api, overlay } = mountBoard({ tool: "pen", view0: { x: -100, y: -50, scale: 1 } })
    dragOn(overlay(), [40, 30], [300, 200])
    expect(last(api).strokes[0].pts[0]).toEqual([0, 0])
  })

  it("a zoom change in the middle of a stroke does not use a stale transform", () => {
    const { api, overlay } = mountBoard({ tool: "pen", view0: { x: 0, y: 0, scale: 1 } })
    ptr("pointerDown", overlay(), 400, 300)
    ptr("pointerMove", overlay(), 420, 310) // board (420,310)
    act(() => api.setView({ x: 100, y: 50, scale: 2 })) // user pinch/wheel-zooms while the pen is down
    ptr("pointerMove", overlay(), 440, 330) // board = (100 + 220, 50 + 165)
    ptr("pointerUp", overlay(), 440, 330)
    const pts = last(api).strokes[0].pts
    expect(pts[0]).toEqual([400, 300])
    expect(pts[pts.length - 1]).toEqual([320, 215])
  })

  it("consumes every coalesced pointer sample, so fast strokes are not reduced to the last point", () => {
    const { api, overlay } = mountBoard({ tool: "pen" })
    ptr("pointerDown", overlay(), 100, 100)
    const ev = new MouseEvent("pointermove", { bubbles: true, cancelable: true, clientX: 140, clientY: 140 })
    Object.defineProperty(ev, "getCoalescedEvents", {
      value: () => [[110, 112], [120, 128], [130, 133], [140, 140]].map(([clientX, clientY]) => ({ clientX, clientY })),
    })
    act(() => { overlay().dispatchEvent(ev) })
    ptr("pointerUp", overlay(), 140, 140)
    const pts = last(api).strokes[0].pts
    expect(pts.length).toBeGreaterThanOrEqual(4) // start + the sampled curve (simplify may drop collinear ones)
    expect(pts[0]).toEqual([100, 100])
    expect(pts[pts.length - 1]).toEqual([140, 140])
    expect(pts.some((p) => p[0] === 120 && p[1] === 128)).toBe(true) // an INTERMEDIATE sample survived
  })

  it("highlighter keeps its tool, colour and width through save and reload", async () => {
    const { api, overlay } = mountBoard({ tool: "highlighter", currentColor: "#22c55e", strokeWidth: 6 })
    dragOn(overlay(), [200, 200], [400, 210])
    const s = last(api).strokes[0]
    expect(s).toMatchObject({ t: "h", color: "#22c55e" })
    expect(s.w).toBe(highlighterWidth(6)) // the highlighter's own width rule, independent of the pen's
    expect(highlighterWidth(2)).toBeGreaterThan(2) // and never thinner than its minimum
    const { toWire, fromServer } = await import("@/lib/whiteboard")
    const { camelize } = await import("@/lib/api")
    const back = fromServer(camelize<Board>(JSON.parse(JSON.stringify(toWire(last(api))))))
    expect(back.strokes[0]).toMatchObject({ t: "h", color: "#22c55e", w: s.w })
  })

  it("a cancelled stroke commits nothing", () => {
    const { api, overlay } = mountBoard({ tool: "pen" })
    ptr("pointerDown", overlay(), 100, 100)
    ptr("pointerMove", overlay(), 150, 150)
    ptr("pointerCancel", overlay(), 150, 150)
    expect(api.calls).toHaveLength(0)
  })
})

// ------------------------------------------------------------------------------------------------ shapes
describe("shape tools in all four drag directions", () => {
  const A: [number, number] = [600, 400]
  const dirs: Array<[string, [number, number]]> = [
    ["right/down", [720, 470]], ["left/down", [480, 470]], ["right/up", [720, 330]], ["left/up", [480, 330]],
  ]

  it.each(dirs)("rectangle, %s -> normalised box", (_n, b) => {
    const { api, overlay } = mountBoard({ tool: "rect" })
    dragOn(overlay(), A, b)
    const e = last(api).elements[0]
    expect([e.kind, e.shape]).toEqual(["shape", "rect"])
    expect([e.x, e.y, e.w, e.h]).toEqual([Math.min(A[0], b[0]), Math.min(A[1], b[1]), 120, 70])
  })

  it.each(dirs)("ellipse, %s -> the ellipse that was previewed (not a rectangle)", (_n, b) => {
    const { api, overlay, container } = mountBoard({ tool: "ellipse" })
    ptr("pointerDown", overlay(), ...A)
    ptr("pointerMove", overlay(), ...b)
    const prev = ellipse(container)!
    expect(prev).toBeTruthy()
    ptr("pointerUp", overlay(), ...b)
    const e = last(api).elements[0]
    expect(e.shape).toBe("ellipse")
    expect([+prev.getAttribute("cx")!, +prev.getAttribute("cy")!, +prev.getAttribute("rx")!, +prev.getAttribute("ry")!]).toEqual([e.x + e.w / 2, e.y + e.h / 2, e.w / 2, e.h / 2])
  })

  it.each(dirs)("circle, %s -> committed circle == previewed circle, inside the drag box", (_n, b) => {
    const { api, overlay, container } = mountBoard({ tool: "circle" })
    ptr("pointerDown", overlay(), ...A)
    ptr("pointerMove", overlay(), ...b)
    const prev = ellipse(container)!
    ptr("pointerUp", overlay(), ...b)
    const e = last(api).elements[0]
    expect(e.kind).toBe("circle")
    expect(e.w).toBe(e.h)
    expect(e.w).toBe(70) // the shorter side, NOT the 139px diagonal
    expect([+prev.getAttribute("cx")!, +prev.getAttribute("cy")!, +prev.getAttribute("rx")!, +prev.getAttribute("ry")!]).toEqual([e.x + 35, e.y + 35, 35, 35])
    expect(e.x).toBeGreaterThanOrEqual(Math.min(A[0], b[0]))
    expect(e.x + e.w).toBeLessThanOrEqual(Math.max(A[0], b[0]))
  })

  it.each(dirs)("triangle, %s", (_n, b) => {
    const { api, overlay } = mountBoard({ tool: "triangle" })
    dragOn(overlay(), A, b)
    const e = last(api).elements[0]
    expect([e.kind, e.x, e.y, e.w, e.h]).toEqual(["triangle", Math.min(A[0], b[0]), Math.min(A[1], b[1]), 120, 70])
  })

  it("a thin bar is created (it used to be silently dropped), a click or a speck is not", () => {
    const { api, overlay } = mountBoard({ tool: "rect" })
    dragOn(overlay(), [300, 300], [540, 312])
    expect(last(api).elements[0]).toMatchObject({ w: 240, h: 12 })
    const n = api.calls.length
    dragOn(overlay(), [100, 100], [100, 100])
    dragOn(overlay(), [100, 100], [104, 103])
    expect(api.calls.length).toBe(n)
  })

  it.each(dirs)("arrow, %s: stored start + signed extent, so it is drawn in the dragged direction", (_n, b) => {
    const { api, overlay } = mountBoard({ tool: "arrow" })
    dragOn(overlay(), A, b)
    const e = last(api).elements[0]
    expect(arrowEndpoints(e, new Map())).toEqual([A, b])
  })

  it.each(dirs)("line, %s: start (x,y) and end (x2,y2)", (_n, b) => {
    const { api, overlay } = mountBoard({ tool: "line" })
    dragOn(overlay(), A, b)
    const e = last(api).elements[0]
    expect([e.x, e.y, e.x2, e.y2]).toEqual([A[0], A[1], b[0], b[1]])
  })
})

// ------------------------------------------------------------------------------------------------ eraser
describe("eraser removes whole elements of every kind", () => {
  const board = boardOf(
    el({ id: "rect", kind: "shape", shape: "rect", x: 100, y: 100, w: 200, h: 100 }),
    el({ id: "line", kind: "line", x: 400, y: 100, w: 200, h: 100, x2: 600, y2: 200 }),
    el({ id: "arrow", kind: "arrow", x: 900, y: 100, w: -200, h: 100 }),
    el({ id: "path", kind: "path", x: 1000, y: 100, w: 100, h: 50, pathData: "M 0 0 L 100 50" }),
    el({ id: "txt", kind: "text", x: 1200, y: 100, w: 150, h: 50, text: "hi" }),
  )

  it.each([
    ["a rectangle", 200, 150, "rect"],
    ["a line", 500, 150, "line"],
    ["a left/down-pointing arrow", 800, 150, "arrow"],
    ["a path", 1050, 125, "path"],
    ["text", 1250, 125, "txt"],
  ])("a click removes %s", (_n, x, y, id) => {
    const { api, overlay } = mountBoard({ tool: "eraser", initial: board })
    ptr("pointerDown", overlay(), x, y)
    ptr("pointerUp", overlay(), x, y)
    expect(last(api).elements.map((e) => e.id)).not.toContain(id)
    expect(last(api).elements).toHaveLength(4)
  })

  it("dragging on from an element keeps erasing what it crosses, as ONE undo step", () => {
    const { api, overlay } = mountBoard({ tool: "eraser", initial: board })
    ptr("pointerDown", overlay(), 200, 150) // rect
    ptr("pointerMove", overlay(), 350, 150) // empty gap
    ptr("pointerMove", overlay(), 500, 150) // line
    ptr("pointerMove", overlay(), 650, 150) // gap
    ptr("pointerUp", overlay(), 650, 150)
    const ids = last(api).elements.map((e) => e.id)
    expect(ids).not.toContain("rect")
    expect(ids).not.toContain("line")
    expect(ids).toHaveLength(3)
    expect(new Set(api.calls.map((c) => c.coalesce)).size).toBe(1)
    expect(api.calls[0].coalesce).toBeTruthy()
  })

  it("starting on empty space erases ink and leaves elements alone, even when dragged across them", () => {
    const { api, overlay } = mountBoard({ tool: "eraser", initial: board })
    ptr("pointerDown", overlay(), 50, 400)
    ptr("pointerMove", overlay(), 250, 150)
    ptr("pointerMove", overlay(), 520, 150)
    ptr("pointerUp", overlay(), 520, 150)
    const b = last(api)
    expect(b.elements).toHaveLength(5)
    expect(b.strokes[b.strokes.length - 1].t).toBe("e")
  })

  it("rapid sweeps never resurrect an element removed a moment earlier (each step builds on the latest board)", () => {
    const many = boardOf(...Array.from({ length: 6 }, (_, i) => el({ id: `r${i}`, kind: "shape", shape: "rect", x: 100 + i * 150, y: 100, w: 100, h: 100 })))
    const { api, overlay } = mountBoard({ tool: "eraser", initial: many })
    ptr("pointerDown", overlay(), 150, 150)
    for (let i = 1; i < 6; i++) ptr("pointerMove", overlay(), 150 + i * 150, 150)
    ptr("pointerUp", overlay(), 900, 150)
    expect(last(api).elements).toHaveLength(0)
  })
})

// ------------------------------------------------------------------------------------------------ resize / rotate
describe("resize and rotate gestures", () => {
  const img = (over: Partial<BoardElement> = {}) => el({ id: "img", kind: "image", src: "data:image/png;base64,AA==", x: 100, y: 100, w: 200, h: 100, ...over })
  const handle = (c: HTMLElement) => c.querySelector<HTMLElement>(".cursor-nwse-resize")!

  it("one resize drag = one coalesced history step, ending at the dragged size", () => {
    const { api, container } = mountBoard({ tool: "select", initial: boardOf(img()), selectedIds: ["img"] })
    ptr("pointerDown", handle(container), 300, 200)
    for (let i = 1; i <= 40; i++) winMove(300 + i * 2, 200 + i)
    winUp()
    expect(api.calls.length).toBeGreaterThanOrEqual(40)
    expect(new Set(api.calls.map((c) => c.coalesce)).size).toBe(1)
    expect(api.calls[0].coalesce).toMatch(/^resize:/)
    expect(last(api).elements[0]).toMatchObject({ w: 280, h: 140 })
  })

  it("two resize drags get different history keys", () => {
    const { api, container } = mountBoard({ tool: "select", initial: boardOf(img()), selectedIds: ["img"] })
    ptr("pointerDown", handle(container), 300, 200); winMove(320, 210); winUp()
    ptr("pointerDown", handle(container), 320, 210); winMove(340, 220); winUp()
    expect(new Set(api.calls.map((c) => c.coalesce)).size).toBe(2)
  })

  it("resizing builds on the LATEST board: an element added mid-drag (e.g. by the AI) is not overwritten", () => {
    const { api, container } = mountBoard({ tool: "select", initial: boardOf(img()), selectedIds: ["img"] })
    ptr("pointerDown", handle(container), 300, 200)
    winMove(320, 210)
    act(() => api.setBoard((b) => ({ ...b, elements: [...b.elements, el({ id: "ai", kind: "text", author: "coach", x: 900, y: 900, text: "late" })] })))
    winMove(340, 220)
    winUp()
    const ids = last(api).elements.map((e) => e.id)
    expect(ids).toContain("ai")
    expect(last(api).elements.find((e) => e.id === "img")).toMatchObject({ w: 240, h: 120 })
  })

  it("resizing a ROTATED element follows the pointer in the element's own axes and keeps its top-left corner fixed", () => {
    // a text box (free aspect). Images keep their aspect ratio by design, so they would also grow taller.
    const rotated = el({ id: "img", kind: "text", text: "rotated", x: 100, y: 100, w: 200, h: 100, rotation: 90 })
    const { api, container } = mountBoard({ tool: "select", initial: boardOf(rotated), selectedIds: ["img"] })
    const corner = (e: BoardElement) => {
      const a = (e.rotation! * Math.PI) / 180
      const [vx, vy] = [-e.w / 2, -e.h / 2]
      return [e.x + e.w / 2 + vx * Math.cos(a) - vy * Math.sin(a), e.y + e.h / 2 + vx * Math.sin(a) + vy * Math.cos(a)]
    }
    const before = corner(rotated)
    ptr("pointerDown", handle(container), 250, 250)
    winMove(250, 290) // straight DOWN on screen = along the element's width axis once rotated 90deg
    winUp()
    const after = last(api).elements[0]
    expect(after.w).toBe(240) // grew along its own width
    expect(after.h).toBe(100) // height untouched
    expect(corner(after)[0]).toBeCloseTo(before[0], 0)
    expect(corner(after)[1]).toBeCloseTo(before[1], 0)
  })

  it("rotation is coalesced into one step and uses the latest board", () => {
    const { api, container } = mountBoard({ tool: "select", initial: boardOf(img()), selectedIds: ["img"] })
    const rot = container.querySelector<HTMLElement>(".rounded-full.cursor-grab")!
    ptr("pointerDown", rot, 200, 60)
    for (let i = 0; i < 25; i++) winMove(200 + i * 10, 60 + i)
    winUp()
    expect(new Set(api.calls.map((c) => c.coalesce)).size).toBe(1)
    expect(api.calls[0].coalesce).toMatch(/^rotate:/)
    expect(last(api).elements[0].rotation).toBeDefined()
  })

  it("a cancelled resize releases its listeners (further moves change nothing)", () => {
    const { api, container } = mountBoard({ tool: "select", initial: boardOf(img()), selectedIds: ["img"] })
    ptr("pointerDown", handle(container), 300, 200)
    winMove(320, 210)
    act(() => { window.dispatchEvent(new MouseEvent("pointercancel")) })
    const n = api.calls.length
    winMove(500, 500)
    expect(api.calls.length).toBe(n)
  })
})

// ------------------------------------------------------------------------------------------------ move
describe("moving selections", () => {
  const T = (id: string, x: number, y: number) => el({ id, kind: "text", x, y, w: 150, h: 50, text: id })

  it("a multi-selection dragged into the board edge moves as a rigid group", () => {
    const { api, container } = mountBoard({ tool: "select", initial: boardOf(T("a", 1800, 100), T("b", 1500, 300)), selectedIds: ["a", "b"] })
    const a = container.querySelector<HTMLElement>('[data-element-id="a"]')!
    ptr("pointerDown", a, 1850, 120)
    ptr("pointerMove", a, 1950, 120) // asks for +100 ...
    ptr("pointerMove", a, 2350, 120) // ... then far beyond the edge
    ptr("pointerUp", a, 2350, 120)
    const [na, nb] = last(api).elements
    expect(na.x - nb.x).toBe(300) // spacing unchanged
    expect(na.x + na.w).toBeLessThanOrEqual(BOARD_W)
  })
})

// ------------------------------------------------------------------------------------------------ pinch
describe("two-finger pinch zoom", () => {
  it("keeps the board point under the fingers fixed for the whole gesture (no drift)", () => {
    const { api, overlay } = mountBoard({ tool: "pen", view0: { x: 400, y: 150, scale: 0.8 } })
    const touch = (type: "pointerDown" | "pointerMove" | "pointerUp", id: number, x: number, y: number) =>
      act(() => { (fireEvent as any)[type](overlay(), { pointerId: id, pointerType: "touch", clientX: x, clientY: y }) })
    const v0 = api.view
    const mid: [number, number] = [500, 350]
    const anchor = [v0.x + mid[0] / v0.scale, v0.y + mid[1] / v0.scale] // board point under the fingers at the start
    touch("pointerDown", 1, 400, 350)
    touch("pointerDown", 2, 600, 350)
    for (let k = 1; k <= 40; k++) { // spread symmetrically: the midpoint never moves
      touch("pointerMove", 1, 400 - k * 3, 350)
      touch("pointerMove", 2, 600 + k * 3, 350)
      const v = api.view
      expect(v.x + mid[0] / v.scale).toBeCloseTo(anchor[0], 3)
      expect(v.y + mid[1] / v.scale).toBeCloseTo(anchor[1], 3)
    }
    expect(api.view.scale).toBeGreaterThan(v0.scale * 1.5) // it really zoomed in
    touch("pointerUp", 1, 280, 350)
    touch("pointerUp", 2, 720, 350)
    expect(api.calls).toHaveLength(0) // and the pinch drew nothing
  })

  it("zooming out then in returns to the starting view", () => {
    const { api, overlay } = mountBoard({ tool: "pen", view0: { x: 300, y: 200, scale: 1 } })
    const touch = (type: "pointerDown" | "pointerMove" | "pointerUp", id: number, x: number, y: number) =>
      act(() => { (fireEvent as any)[type](overlay(), { pointerId: id, pointerType: "touch", clientX: x, clientY: y }) })
    const v0 = api.view
    touch("pointerDown", 1, 450, 350); touch("pointerDown", 2, 550, 350)
    touch("pointerMove", 1, 350, 350); touch("pointerMove", 2, 650, 350) // 3x apart
    touch("pointerMove", 1, 450, 350); touch("pointerMove", 2, 550, 350) // back to the start
    expect(api.view.scale).toBeCloseTo(v0.scale, 6)
    expect(api.view.x).toBeCloseTo(v0.x, 4)
    expect(api.view.y).toBeCloseTo(v0.y, 4)
  })
})

// ------------------------------------------------------------------------------------------------ workspace
describe("BoardWorkspace: history and keyboard", () => {
  const pressed = (label: string) => screen.getByRole("button", { name: label }).getAttribute("aria-pressed") === "true"
  const mountWs = (board: Board) => render(<BoardWorkspace assignmentId="A" initial={board} busy={false} onAsk={() => {}} />)
  const lastSaved = () => (mocks.saveWhiteboard.mock.calls.at(-1)![1] as any).elements as any[]

  it("a whole resize drag is undone by ONE Ctrl+Z", async () => {
    const image = el({ id: "img", kind: "image", src: "data:image/png;base64,AA==", x: 100, y: 100, w: 200, h: 100 })
    const { container } = mountWs(boardOf(image))
    const node = container.querySelector<HTMLElement>('[data-element-id="img"]')!
    ptr("pointerDown", node, 150, 120) // select it (select tool is the default)
    ptr("pointerUp", node, 150, 120)
    const h = await waitFor(() => { const x = container.querySelector<HTMLElement>(".cursor-nwse-resize"); expect(x).toBeTruthy(); return x! })
    const start = [h.getBoundingClientRect().left, h.getBoundingClientRect().top]
    ptr("pointerDown", h, start[0], start[1])
    for (let i = 1; i <= 80; i++) winMove(start[0] + i, start[1] + i / 2) // far more moves than the 60-step history cap
    winUp()
    fireEvent.keyDown(window, { key: "z", ctrlKey: true })
    await waitFor(() => expect(lastSaved().find((e) => e.id === "img")).toMatchObject({ w: 200, h: 100 }), { timeout: 4000 })
  })

  it("typing in the text editor never triggers board shortcuts (tool keys, Delete, Backspace, undo, duplicate)", async () => {
    const note = el({ id: "n", kind: "text", x: 200, y: 200, w: 300, h: 60, text: "keep me" })
    const { container } = mountWs(boardOf(note))
    const node = container.querySelector<HTMLElement>('[data-element-id="n"]')!
    ptr("pointerDown", node, 250, 220) // select
    ptr("pointerUp", node, 250, 220)
    act(() => { fireEvent.doubleClick(node) })
    const editor = await screen.findByLabelText("Text on the board")
    expect(pressed("Select and move")).toBe(true)
    for (const init of [
      { key: "p" }, { key: "e" }, { key: "r" }, { key: "v" }, { key: "Delete" }, { key: "Backspace" },
      { key: "z", ctrlKey: true }, { key: "d", ctrlKey: true }, { key: "c", ctrlKey: true },
    ]) fireEvent.keyDown(editor, init)
    expect(pressed("Select and move")).toBe(true) // no tool switch
    expect(container.querySelector('[data-element-id="n"]')).toBeTruthy() // not deleted
  })

  const readView = () => {
    const m = /scale\(([\d.]+)\) translate\((-?[\d.e+-]+)px, (-?[\d.e+-]+)px\)/.exec(screen.getByRole("group", { name: "Whiteboard" }).style.transform)!
    return { scale: +m[1], x: -+m[2], y: -+m[3] }
  }
  /** The screen point that a zoom step left fixed: x0 + cx/s0 = x1 + cx/s1. */
  const pivot = (a: ReturnType<typeof readView>, b: ReturnType<typeof readView>) => ({
    cx: (b.x - a.x) / (1 / a.scale - 1 / b.scale),
    cy: (b.y - a.y) / (1 / a.scale - 1 / b.scale),
  })

  it("Zoom In / Zoom Out pivot about the centre of the workspace, not the board's top-left corner", () => {
    mountWs(EMPTY_BOARD)
    const v0 = readView()
    fireEvent.click(screen.getByRole("button", { name: "Zoom In" }))
    const v1 = readView()
    fireEvent.click(screen.getByRole("button", { name: "Zoom Out" }))
    const v2 = readView()
    expect(v1.scale).toBeCloseTo(v0.scale * 1.2, 6)
    const p = pivot(v0, v1)
    expect(p.cx).toBeCloseTo(VW / 2, 3) // horizontal centre of the 1000px-wide workspace
    expect(p.cy).toBeGreaterThan(100) // vertically inside the workspace, nowhere near the top edge
    expect(p.cy).toBeLessThan(VH - 100)
    // and zooming back out returns to where it started (no accumulated drift)
    expect(v2.scale).toBeCloseTo(v0.scale, 6)
    expect(v2.x).toBeCloseTo(v0.x, 6)
    expect(v2.y).toBeCloseTo(v0.y, 6)
  })

  it("shift-click adds to the selection and it STAYS a multi-selection (it used to clear itself)", () => {
    const t = (id: string, x: number) => el({ id, kind: "text", x, y: 200, w: 120, h: 50, text: id })
    const { container } = mountWs(boardOf(t("A", 100), t("B", 500), t("C", 900)))
    const node = (id: string) => container.querySelector<HTMLElement>(`[data-element-id="${id}"]`)!
    const selected = () => ["A", "B", "C"].filter((i) => node(i).style.outline)
    ptr("pointerDown", node("A"), 120, 220); ptr("pointerUp", node("A"), 120, 220)
    expect(selected()).toEqual(["A"])
    ptr("pointerDown", node("C"), 920, 220, { shiftKey: true }); ptr("pointerUp", node("C"), 920, 220, { shiftKey: true })
    expect(selected()).toEqual(["A", "C"])
    ptr("pointerDown", node("A"), 120, 220, { shiftKey: true }); ptr("pointerUp", node("A"), 120, 220, { shiftKey: true })
    expect(selected()).toEqual(["C"]) // shift-click on a selected element removes it
  })

  it("deleting a multi-selection also removes arrows attached to it (no invisible orphans)", async () => {
    const t = (id: string, x: number) => el({ id, kind: "text", x, y: 200, w: 120, h: 50, text: id })
    const link = el({ id: "link", kind: "arrow", x: 0, y: 0, w: 1, h: 0, fromId: "A", toId: "B" })
    const { container } = mountWs(boardOf(t("A", 100), t("B", 500), t("C", 900), link))
    const node = (id: string) => container.querySelector<HTMLElement>(`[data-element-id="${id}"]`)!
    ptr("pointerDown", node("A"), 120, 220); ptr("pointerUp", node("A"), 120, 220)
    ptr("pointerDown", node("C"), 920, 220, { shiftKey: true }); ptr("pointerUp", node("C"), 920, 220, { shiftKey: true })
    fireEvent.keyDown(window, { key: "Delete" })
    await waitFor(() => {
      const ids = lastSaved().map((e) => e.id)
      expect(ids).toEqual(["B"]) // A and C deleted AND the A->B arrow that depended on A
    }, { timeout: 4000 })
  })

  it("ignores shortcuts while a <select> has focus", () => {
    mountWs(EMPTY_BOARD)
    const sel = document.createElement("select")
    document.body.appendChild(sel)
    fireEvent.keyDown(sel, { key: "p" })
    expect(pressed("Select and move")).toBe(true)
    sel.remove()
  })
})

// ------------------------------------------------------------------------------------------------ pan / zoom / text
describe("pan and zoom never touch element coordinates", () => {
  const surface = (c: HTMLElement) => c.querySelector<HTMLElement>("[data-board-surface]")!
  const keySpace = (type: "keyDown" | "keyUp") => act(() => { (fireEvent as any)[type](document.body, { code: "Space", key: " " }) })
  const seeded = boardOf(el({ id: "keep", kind: "shape", shape: "rect", x: 500, y: 400, w: 200, h: 100 }))

  it("Space + drag pans by exactly the dragged distance (in board units) and changes no element", () => {
    const { api, container } = mountBoard({ tool: "pen", initial: seeded, view0: { x: 300, y: 200, scale: 2 } })
    keySpace("keyDown")
    ptr("pointerDown", surface(container), 500, 400)
    winMove(420, 340) // dragged 80px left, 60px up at 2x => view moves +40, +30 board units
    winUp()
    keySpace("keyUp")
    expect(api.view).toEqual({ x: 340, y: 230, scale: 2 })
    expect(api.calls).toHaveLength(0) // a pan draws nothing
    expect(api.board.elements[0]).toMatchObject({ x: 500, y: 400, w: 200, h: 100 })
  })

  it("middle-mouse drag pans the same way", () => {
    const { api, container } = mountBoard({ tool: "select", initial: seeded, view0: { x: 300, y: 200, scale: 1 } })
    ptr("pointerDown", surface(container), 500, 400, { button: 1 })
    winMove(450, 380)
    winUp()
    expect(api.view).toMatchObject({ x: 350, y: 220, scale: 1 })
    expect(api.calls).toHaveLength(0)
  })

  it("Ctrl+wheel zooms toward the pointer: the board point under the cursor stays put", () => {
    const { api, container } = mountBoard({ tool: "select", view0: { x: 300, y: 200, scale: 1 } })
    const vp = container.querySelector<HTMLElement>("[data-board-viewport]")!
    const cursor = [400, 300]
    const before = [api.view.x + cursor[0] / api.view.scale, api.view.y + cursor[1] / api.view.scale]
    for (const deltaY of [-120, -120, -60, 80]) act(() => { fireEvent.wheel(vp, { ctrlKey: true, deltaY, clientX: cursor[0], clientY: cursor[1] }) })
    expect(api.view.scale).not.toBe(1)
    expect(api.view.x + cursor[0] / api.view.scale).toBeCloseTo(before[0], 6)
    expect(api.view.y + cursor[1] / api.view.scale).toBeCloseTo(before[1], 6)
  })

  it("zoom stays inside the allowed range", () => {
    const { api, container } = mountBoard({ tool: "select", view0: { x: 300, y: 200, scale: 1 } })
    const vp = container.querySelector<HTMLElement>("[data-board-viewport]")!
    for (let i = 0; i < 40; i++) act(() => { fireEvent.wheel(vp, { ctrlKey: true, deltaY: -400, clientX: 500, clientY: 300 }) })
    expect(api.view.scale).toBeLessThanOrEqual(5)
    for (let i = 0; i < 80; i++) act(() => { fireEvent.wheel(vp, { ctrlKey: true, deltaY: 400, clientX: 500, clientY: 300 }) })
    expect(api.view.scale).toBeGreaterThanOrEqual(0.1)
  })
})

describe("text tool lifecycle", () => {
  const typeIn = (editor: HTMLElement, value: string) => act(() => { fireEvent.change(editor, { target: { value } }) })

  it("click -> editor at the clicked BOARD position (under zoom/pan) -> type -> Enter commits one text element", async () => {
    const { api, overlay } = mountBoard({ tool: "text", view0: { x: 100, y: 50, scale: 2 } })
    ptr("pointerDown", overlay(), 400, 300) // board (300, 200)
    const editor = await screen.findByLabelText("Text on the board")
    typeIn(editor, "hello board")
    act(() => { fireEvent.keyDown(editor, { key: "Enter" }) })
    const e = last(api).elements[0]
    expect(e).toMatchObject({ kind: "text", text: "hello board" })
    expect(Math.abs(e.x - 300)).toBeLessThanOrEqual(2)
    expect(Math.abs(e.y - 200)).toBeLessThanOrEqual(2)
    expect(e.w).toBeGreaterThan(0)
    expect(e.h).toBeGreaterThan(0)
  })

  it("Shift+Enter inserts a newline instead of committing; Escape cancels without creating anything", async () => {
    const { api, overlay } = mountBoard({ tool: "text" })
    ptr("pointerDown", overlay(), 300, 300)
    const editor = await screen.findByLabelText("Text on the board")
    typeIn(editor, "line1\nline2")
    act(() => { fireEvent.keyDown(editor, { key: "Enter", shiftKey: true }) })
    expect(api.calls).toHaveLength(0)
    act(() => { fireEvent.keyDown(editor, { key: "Escape" }) })
    expect(api.calls).toHaveLength(0)
    expect(screen.queryByLabelText("Text on the board")).toBeNull()
  })

  it("a multiline text element keeps its newline and grows taller than a one-line one", async () => {
    const { api, overlay } = mountBoard({ tool: "text" })
    ptr("pointerDown", overlay(), 300, 300)
    typeIn(await screen.findByLabelText("Text on the board"), "one\ntwo\nthree")
    act(() => { fireEvent.keyDown(screen.getByLabelText("Text on the board"), { key: "Enter" }) })
    const multi = last(api).elements[0]
    expect(multi.text).toBe("one\ntwo\nthree")
    expect(multi.h).toBeGreaterThan(40)
  })

  it("editing an existing text element and committing updates it in place (same id, new size)", async () => {
    const note = el({ id: "n", kind: "text", x: 200, y: 200, w: 120, h: 50, text: "short" })
    const { api, container } = mountBoard({ tool: "select", initial: boardOf(note), selectedIds: ["n"] })
    act(() => { fireEvent.doubleClick(container.querySelector('[data-element-id="n"]')!) })
    const editor = await screen.findByLabelText("Text on the board")
    typeIn(editor, "a much longer piece of text than before")
    act(() => { fireEvent.keyDown(editor, { key: "Enter" }) })
    const updated = last(api).elements
    expect(updated).toHaveLength(1)
    expect(updated[0]).toMatchObject({ id: "n", text: "a much longer piece of text than before" })
    expect(updated[0].w).toBeGreaterThan(120)
  })
})
