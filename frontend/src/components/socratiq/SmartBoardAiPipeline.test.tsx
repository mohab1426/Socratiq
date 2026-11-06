// @vitest-environment jsdom
/**
 * Workspace-level regression tests for AI-generated drawing operations.
 *
 * These mount the real BoardWorkspace, feed it Gemini-style function calls through the mocked chat proxy,
 * and read back the board exactly as it is persisted (toWire), so they cover tool execution -> layout
 * planning -> element creation -> serialization. jsdom has no layout engine, so container size and the
 * toolbar / chat occluders are stubbed (same approach as BoardViewportFit.test.tsx). That means these are
 * component-level tests with mocked network and layout, NOT end-to-end tests in a real browser.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { createRef } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { installDomStubs } from "@/test/domStubs"
import { EMPTY_BOARD, arrowEndpoints, fromServer, type Board } from "@/lib/whiteboard"

const mocks = vi.hoisted(() => ({
  saveWhiteboard: vi.fn(async (..._a: any[]) => ({})),
  sendChatProxy: vi.fn(),
}))
vi.mock("@/lib/queries", () => ({ saveWhiteboard: mocks.saveWhiteboard }))
vi.mock("@/lib/geminiSmartBoardService", async (orig) => ({
  ...(await orig<any>()),
  sendChatProxy: mocks.sendChatProxy,
}))
import { BoardWorkspace } from "./BoardWorkspace"
import { SmartBoard, type SmartBoardHandle } from "./SmartBoard"

// ---- controllable layout: the canvas area (and the board viewport inside it) have a settable size
const layout = { w: 1000, h: 700 }
const isArea = (el: Element) => !!el.querySelector(":scope > [data-board-viewport]")
const isViewport = (el: Element) => el.hasAttribute("data-board-viewport")
const OCC = { toolbar: [8, 54] as const, chat: [60, 8] as const } // toolbar y 8..54; chat 60px tall, 8px above the bottom

beforeEach(() => {
  installDomStubs()
  vi.clearAllMocks()
  layout.w = 1000
  layout.h = 700
  Element.prototype.scrollIntoView = vi.fn()
  ;(globalThis as any).requestAnimationFrame = (cb: FrameRequestCallback) => { cb(0); return 1 }
  ;(globalThis as any).cancelAnimationFrame = () => {}
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get() { return isArea(this) || isViewport(this) ? layout.w : 0 } })
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get() { return isArea(this) || isViewport(this) ? layout.h : 0 } })
  const r = (l: number, t: number, w: number, h: number) => ({ left: l, top: t, width: w, height: h, right: l + w, bottom: t + h, x: l, y: t, toJSON() {} }) as DOMRect
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    if (isArea(this) || isViewport(this)) return r(0, 0, layout.w, layout.h)
    const kind = this.getAttribute("data-board-occluder")
    if (kind === "toolbar") return r(8, OCC.toolbar[0], 300, OCC.toolbar[1] - OCC.toolbar[0])
    if (kind === "chat") return r(8, layout.h - OCC.chat[0] - OCC.chat[1], 300, OCC.chat[0])
    return r(0, 0, 0, 0)
  }
  class FakeImage { onload: (() => void) | null = null; width = 1; height = 1; set src(_v: string) { queueMicrotask(() => this.onload?.()) } }
  vi.stubGlobal("Image", FakeImage)
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  delete (HTMLElement.prototype as any).clientWidth
  delete (HTMLElement.prototype as any).clientHeight
})

const STUDENT_TEXT = { id: "stu", kind: "text", author: "student", seq: 0, x: 100, y: 100, w: 300, h: 76, text: "student work" } as const
const boardWith = (...els: any[]): Board => ({ ...EMPTY_BOARD, nextSeq: els.length, elements: els })

const mount = (board: Board = EMPTY_BOARD) => render(<BoardWorkspace assignmentId="A" initial={board} busy={false} onAsk={() => {}} />)
const askAI = async (calls: any[]) => {
  mocks.sendChatProxy.mockResolvedValueOnce({ text: "", functionCalls: calls })
  fireEvent.change(screen.getByPlaceholderText(/Ask Gemini/i), { target: { value: "do it" } })
  fireEvent.click(screen.getByRole("button", { name: "Send to SmartBoard" }))
}
/** The board as persisted by the autosave (wire format, camelized back by fromServer). */
const savedBoard = (): Board => fromServer({ ...(mocks.saveWhiteboard.mock.calls.at(-1)![1] as any), elements: (mocks.saveWhiteboard.mock.calls.at(-1)![1] as any).elements.map(camel) })
const camel = (e: any) => ({ ...e, fromId: e.from_id, toId: e.to_id, pathData: e.path_data })
const savedCoach = async (n: number) => {
  await waitFor(() => {
    const c = mocks.saveWhiteboard.mock.calls.at(-1)
    expect(c && (c[1] as any).elements.filter((e: any) => e.author === "coach").length).toBeGreaterThanOrEqual(n)
  }, { timeout: 4000 })
  return savedBoard().elements.filter((e) => e.author === "coach")
}
const stage = () => screen.getByRole("group", { name: "Whiteboard" })
const readView = () => {
  const m = /scale\(([\d.]+)\) translate\((-?[\d.e+-]+)px, (-?[\d.e+-]+)px\)/.exec(stage().style.transform)!
  return { scale: +m[1], x: -+m[2], y: -+m[3] }
}
const overlaps = (a: any, b: any) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

describe("AI line / path / arrow execution follows the planned layout", () => {
  it("a diagram that collides with student work moves RIGIDLY: rects, line and path keep their relative geometry", async () => {
    mount(boardWith(STUDENT_TEXT))
    await askAI([
      { name: "draw_rectangle", args: { x: 100, y: 100, width: 120, height: 60 } },
      { name: "draw_rectangle", args: { x: 400, y: 100, width: 120, height: 60 } },
      { name: "draw_line", args: { x1: 220, y1: 130, x2: 400, y2: 130 } },
      { name: "draw_path", args: { x: 250, y: 200, pathData: "M 50 20 L 150 70 L 250 20" } },
    ])
    const coach = await savedCoach(4)
    const [r1, r2] = coach.filter((e) => e.kind === "shape")
    const line = coach.find((e) => e.kind === "line")!
    const path = coach.find((e) => e.kind === "path")!

    expect(overlaps(r1, STUDENT_TEXT)).toBe(false)
    expect(r2.x - r1.x).toBe(300)
    expect(r2.y - r1.y).toBe(0)
    // the line still joins the right edge of r1 to the left edge of r2, at the same height, same length/direction
    expect(line.x - (r1.x + r1.w)).toBe(0)
    expect(line.y - (r1.y + 30)).toBe(0)
    expect(line.x2! - line.x).toBe(180)
    expect(line.y2! - line.y).toBe(0)
    expect(line.x2).toBe(r2.x)
    // the path: drawn region started at (300,220) => offset (+200,+120) from r1; size measured from the path
    expect(path.x - r1.x).toBe(200)
    expect(path.y - r1.y).toBe(120)
    expect([path.w, path.h]).toEqual([200, 50])
    expect(path.pathData).toBe("M 0 0 L 100 50 L 200 0")
  })

  it("pairs connectors with the right call when the arrow comes FIRST in the batch", async () => {
    mount()
    await askAI([
      { name: "draw_arrow", args: {} },
      { name: "write_text", args: { text: "Alpha" } },
      { name: "write_text", args: { text: "Beta" } },
    ])
    const coach = await savedCoach(3)
    const arrow = coach.find((e) => e.kind === "arrow")!
    const a = coach.find((e) => e.text === "Alpha")!
    const b = coach.find((e) => e.text === "Beta")!
    for (const v of [arrow.x, arrow.y, arrow.w, arrow.h]) expect(Number.isFinite(v)).toBe(true)
    const [[sx, sy], [ex, ey]] = arrowEndpoints(arrow, new Map())!
    const near = (px: number, py: number, box: any) => px >= box.x - 2 && px <= box.x + box.w + 2 && py >= box.y - 2 && py <= box.y + box.h + 2
    expect(near(sx, sy, a)).toBe(true)
    expect(near(ex, ey, b)).toBe(true)
  })

  it("an AI arrow pointing left/up is stored so that it is drawn left/up", async () => {
    mount()
    await askAI([{ name: "draw_arrow", args: { x1: 800, y1: 300, x2: 500, y2: 250 } }])
    const arrow = (await savedCoach(1))[0]
    expect(arrowEndpoints(arrow, new Map())).toEqual([[800, 300], [500, 250]])
  })

  it("a lone line is kept exactly where the AI drew it, with direction and length intact", async () => {
    mount()
    await askAI([{ name: "draw_line", args: { x1: 700, y1: 500, x2: 600, y2: 430 } }])
    const line = (await savedCoach(1))[0]
    expect([line.x, line.y, line.x2, line.y2]).toEqual([700, 500, 600, 430])
  })

  it("invalid coordinates never produce NaN geometry", async () => {
    mount()
    await askAI([{ name: "draw_line", args: { x1: NaN, y1: 50, x2: "abc", y2: 50 } }])
    const line = (await savedCoach(1))[0]
    for (const v of [line.x, line.y, line.w, line.h, line.x2, line.y2]) expect(Number.isFinite(v)).toBe(true)
    expect(line.x2! - line.x).toBe(140)
  })

  it("a draw_path with no pathData draws nothing and reports an error to the model", async () => {
    mount()
    await askAI([{ name: "draw_path", args: { x: 300, y: 300 } }, { name: "write_text", args: { text: "kept" } }])
    const coach = await savedCoach(1)
    expect(coach.some((e) => e.kind === "path")).toBe(false)
    expect(coach.some((e) => e.text === "kept")).toBe(true)
  })

  it("repeating a call with the same element_id does not create a duplicate", async () => {
    mount()
    await askAI([
      { name: "draw_rectangle", element_id: "dup1", args: { x: 400, y: 300, width: 100, height: 60 } },
      { name: "draw_rectangle", element_id: "dup1", args: { x: 400, y: 300, width: 100, height: 60 } },
    ])
    const first = await savedCoach(1)
    expect(first.filter((e) => e.id === "dup1")).toHaveLength(1)
    // and again in a later turn: still one element, still in the same place
    await askAI([{ name: "draw_rectangle", element_id: "dup1", args: { x: 900, y: 900, width: 100, height: 60 } }])
    await act(async () => { await new Promise((r) => setTimeout(r, 1500)) })
    const after = savedBoard().elements.filter((e) => e.id === "dup1")
    expect(after).toHaveLength(1)
    expect([after[0].x, after[0].y]).toEqual([first[0].x, first[0].y])
  })

  it("existing coach and student elements are not moved by a new batch", async () => {
    const old = { id: "old", kind: "shape", shape: "rect", author: "coach", seq: 1, x: 100, y: 300, w: 120, h: 60 }
    mount(boardWith(STUDENT_TEXT, old))
    await askAI([
      { name: "write_text", args: { text: "one" } },
      { name: "write_text", args: { text: "two" } },
    ])
    await savedCoach(3)
    await act(async () => { await new Promise((r) => setTimeout(r, 400)) }) // let the post-render reflow run
    const board = savedBoard()
    expect(board.elements.find((e) => e.id === "stu")).toMatchObject({ x: 100, y: 100, w: 300, h: 76 })
    expect(board.elements.find((e) => e.id === "old")).toMatchObject({ x: 100, y: 300, w: 120, h: 60 })
  })
})

describe("AI results are reported honestly and older content stays put", () => {
  it("an unsupported tool is reported to the student instead of silently 'succeeding'", async () => {
    mount()
    await askAI([{ name: "teleport_cube", args: { x: 1 } }, { name: "write_text", args: { text: "this one works" } }])
    expect(await screen.findByText(/One item couldn't be added to the board/i)).toBeTruthy()
    expect(screen.getByText(/Unsupported tool "teleport_cube"/)).toBeTruthy()
    expect((await savedCoach(1)).some((e) => e.text === "this one works")).toBe(true) // the rest of the batch still lands
  })

  it("a malformed draw_path is reported to the student, and nothing malformed is saved", async () => {
    mount()
    await askAI([{ name: "draw_path", args: { x: 300, y: 300 } }, { name: "write_text", args: { text: "ok" } }])
    expect(await screen.findByText(/couldn't be added to the board: draw_path needs a non-empty pathData/i)).toBeTruthy()
    const coach = await savedCoach(1)
    expect(coach.some((e) => e.kind === "path")).toBe(false)
  })

  it("a batch never resizes or moves OLDER content, even when the DOM reports a different size for it", async () => {
    // An older coach note that already overlaps the student's text. The reflow after a NEW batch used to
    // treat it like any other element and push it down (and rewrite its size), i.e. old content moved.
    const old = { id: "old", kind: "text", author: "coach", seq: 1, x: 120, y: 130, w: 200, h: 60, text: "older coach note" }
    mount(boardWith(STUDENT_TEXT, old))
    const base = HTMLElement.prototype.getBoundingClientRect
    HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
      // the DOM says the old note is much bigger than its stored 200x60 (e.g. wrapped text / webfont)
      if (this.getAttribute("data-element-id") === "old") return { left: 0, top: 0, width: 900, height: 300, right: 900, bottom: 300, x: 0, y: 0, toJSON() {} } as DOMRect
      return base.call(this)
    }
    try {
      await askAI([{ name: "write_text", args: { text: "fresh one" } }, { name: "write_text", args: { text: "fresh two" } }])
      await savedCoach(3)
      await act(async () => { await new Promise((r) => setTimeout(r, 400)) }) // post-render reflow runs after 60ms
      const kept = savedBoard().elements.find((e) => e.id === "old")!
      expect([kept.x, kept.y, kept.w, kept.h]).toEqual([120, 130, 200, 60])
    } finally {
      HTMLElement.prototype.getBoundingClientRect = base
    }
  })
})

describe("Show new content", () => {
  // Make the visible workspace tiny on purpose: zoom to the 5x maximum, then centre on a free board point.
  async function zoomedWorkspace() {
    layout.w = 600
    layout.h = 500
    mount()
    const zoomIn = screen.getByRole("button", { name: "Zoom In" })
    for (let i = 0; i < 18; i++) fireEvent.click(zoomIn)
    expect(readView().scale).toBeCloseTo(5, 3)
    await askAI([{ name: "pan_view", args: { x: 1000, y: 600 } }])
    await waitFor(() => expect(readView().x).toBeCloseTo(1000 - 600 / 10, 0))
  }
  // Independent oracle: board interval shown between screen offsets, from the contract (no library code).
  const unobstructed = (v: { x: number; y: number; scale: number }) => ({
    x0: Math.max(0, v.x), x1: Math.min(2000, v.x + layout.w / v.scale),
    y0: Math.max(0, v.y + OCC.toolbar[1] / v.scale), y1: Math.min(1200, v.y + (layout.h - (OCC.chat[0] + OCC.chat[1])) / v.scale),
  })
  const button = () => screen.queryByRole("button", { name: /Show new content/i })

  it("does not appear when the new content fits in the visible workspace", async () => {
    mount()
    await askAI([{ name: "write_text", args: { text: "fits fine" } }])
    await savedCoach(1)
    expect(button()).toBeNull()
  })

  it("appears when content cannot be placed in view, jumps to it, then goes away", async () => {
    await zoomedWorkspace()
    await askAI([{ name: "write_text", args: { text: "New note" } }])
    const el = (await savedCoach(1))[0]
    const before = unobstructed(readView())
    // the content really is outside the visible workspace...
    expect(el.x + el.w <= before.x1 && el.x >= before.x0 && el.y >= before.y0 && el.y + el.h <= before.y1).toBe(false)
    // ...so the user is told and offered a way to it
    await waitFor(() => expect(button()).not.toBeNull())
    expect(screen.getByText(/outside the part of the board you can see/i)).toBeTruthy()

    fireEvent.click(button()!)
    const v = readView()
    const u = unobstructed(v)
    expect(el.x).toBeGreaterThanOrEqual(u.x0 - 1)
    expect(el.x + el.w).toBeLessThanOrEqual(u.x1 + 1)
    expect(el.y).toBeGreaterThanOrEqual(u.y0 - 1)
    expect(el.y + el.h).toBeLessThanOrEqual(u.y1 + 1)
    await waitFor(() => expect(button()).toBeNull())
  })

  it("goes away when the off-screen content is removed", async () => {
    await zoomedWorkspace()
    await askAI([{ name: "write_text", args: { text: "New note" } }])
    const el = (await savedCoach(1))[0]
    await waitFor(() => expect(button()).not.toBeNull())
    await askAI([{ name: "delete_element_at", args: { x: el.x + el.w / 2, y: el.y + el.h / 2 } }])
    await waitFor(() => expect(button()).toBeNull())
  })
})

describe("rendered bounds use the ACTUAL zoom (controlled view)", () => {
  it("getAllRenderedBounds converts DOM pixels to board units with viewState.scale, not the stale internal 0.4", () => {
    const ref = createRef<SmartBoardHandle>()
    const board = boardWith({ id: "t", kind: "text", author: "student", seq: 0, x: 100, y: 100, w: 200, h: 60, text: "hi" })
    const orig = HTMLElement.prototype.getBoundingClientRect
    HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
      const r = (l: number, t: number, w: number, h: number) => ({ left: l, top: t, width: w, height: h, right: l + w, bottom: t + h, x: l, y: t, toJSON() {} }) as DOMRect
      return this.hasAttribute("data-element-id") ? r(200, 200, 400, 120) : r(0, 0, 0, 0) // drawn at 2x: 200x60 units
    }
    try {
      render(<SmartBoard ref={ref} board={board} readOnly viewState={{ x: 0, y: 0, scale: 2 }} onViewChange={() => {}} />)
      const b = ref.current!.getAllRenderedBounds().get("t")!
      expect([b.w, b.h]).toEqual([200, 60])
      expect(ref.current!.getElementRenderedBounds("t")).toMatchObject({ w: 200, h: 60 })
    } finally {
      HTMLElement.prototype.getBoundingClientRect = orig
    }
  })
})
