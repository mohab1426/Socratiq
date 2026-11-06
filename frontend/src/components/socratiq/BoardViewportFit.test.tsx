// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { installDomStubs } from "@/test/domStubs"
import { EMPTY_BOARD, type Board } from "@/lib/whiteboard"
import { computeFitView, contentFitBox, measureOcclusion } from "@/lib/boardViewport"
import { BoardWorkspace } from "./BoardWorkspace"
import { SmartBoard } from "./SmartBoard"

vi.mock("@/lib/queries", () => ({ saveWhiteboard: vi.fn(async () => ({})) }))

// ---- controllable layout: the canvas area is the element whose child is the board viewport
const layout = { w: 0, h: 0 }
const isArea = (el: Element) => !!el.querySelector(":scope > [data-board-viewport]")
const roCallbacks: Array<() => void> = []
const fireResize = () => act(() => { roCallbacks.slice().forEach((cb) => cb()) })
const OCC = { toolbar: [8, 54] as const, chat: [60, 8] as const } // toolbar: top 8..54, chat: 60px tall block 8px from the bottom

beforeEach(() => {
  installDomStubs()
  layout.w = 0; layout.h = 0; roCallbacks.length = 0
  ;(globalThis as any).ResizeObserver = class { constructor(cb: () => void) { roCallbacks.push(() => cb()) } observe() {} unobserve() {} disconnect() {} }
  ;(globalThis as any).requestAnimationFrame = (cb: FrameRequestCallback) => { cb(0); return 1 }
  ;(globalThis as any).cancelAnimationFrame = () => {}
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get() { return isArea(this) ? layout.w : 0 } })
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get() { return isArea(this) ? layout.h : 0 } })
  const r = (l: number, t: number, w: number, h: number) => ({ left: l, top: t, width: w, height: h, right: l + w, bottom: t + h, x: l, y: t, toJSON() {} }) as DOMRect
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    if (isArea(this)) return r(0, 0, layout.w, layout.h)
    const kind = this.getAttribute("data-board-occluder")
    if (kind === "toolbar") return r(8, OCC.toolbar[0], 300, OCC.toolbar[1] - OCC.toolbar[0])
    if (kind === "chat") return r(8, layout.h - OCC.chat[0] - OCC.chat[1], 300, OCC.chat[0])
    return r(0, 0, 0, 0)
  }
})
afterEach(() => { cleanup(); delete (HTMLElement.prototype as any).clientWidth; delete (HTMLElement.prototype as any).clientHeight })

const STUDENT: Board = { ...EMPTY_BOARD, nextSeq: 1, elements: [{ id: "s1", kind: "text", author: "student", seq: 0, x: 60, y: 60, w: 300, h: 76, text: "keep me" }] }
const stage = () => screen.getByRole("group", { name: "Whiteboard" })
const readView = () => {
  const m = /scale\(([\d.]+)\) translate\((-?[\d.e+-]+)px, (-?[\d.e+-]+)px\)/.exec(stage().style.transform)!
  return { scale: +m[1], x: -+m[2], y: -+m[3] }
}
const mount = (board: Board = EMPTY_BOARD) => render(<BoardWorkspace assignmentId="A" initial={board} busy={false} onAsk={() => {}} />)
const expectedFor = (board: Board, w: number, h: number) => {
  const area = document.querySelector("[data-board-viewport]")!.parentElement as HTMLElement
  return computeFitView({ width: w, height: h }, contentFitBox(board.elements), measureOcclusion(area)!, { maxScale: board.elements.length ? 1.2 : 1 })!
}

describe("automatic fit on open", () => {
  it("fits the board to the measured container, accounting for toolbar and chat occlusion", () => {
    layout.w = 1366; layout.h = 723
    mount()
    const exp = expectedFor(EMPTY_BOARD, 1366, 723)
    const v = readView()
    expect(v.scale).toBeCloseTo(exp.scale, 3); expect(v.x).toBeCloseTo(exp.x, 1); expect(v.y).toBeCloseTo(exp.y, 1)
    // occlusion really changed the answer: it is smaller than a no-occlusion fit
    expect(v.scale).toBeLessThan(computeFitView({ width: 1366, height: 723 }, { x: 0, y: 0, w: 2000, h: 1200 })!.scale)
  })
  it("does not measure a zero-sized container, then fits once it has a real size", () => {
    mount()
    expect(readView().scale).toBeCloseTo(0.4, 5)            // default kept while hidden
    layout.w = 900; layout.h = 700; fireResize()
    expect(readView().scale).toBeCloseTo(expectedFor(EMPTY_BOARD, 900, 700).scale, 3)
  })
  it("uses a full-bleed workspace surface, not a scale-sized box", () => {
    layout.w = 800; layout.h = 600
    mount()
    const vp = document.querySelector("[data-board-viewport]")!
    expect(vp.getAttribute("data-board-viewport")).toBe("workspace")
    const surf = document.querySelector<HTMLElement>("[data-board-surface]")!
    expect(surf.className).toContain("inset-0"); expect(surf.style.width).toBe("")
  })
  it("fits existing content rather than the empty board", () => {
    layout.w = 1000; layout.h = 700
    mount(STUDENT)
    expect(readView().scale).toBeCloseTo(expectedFor(STUDENT, 1000, 700).scale, 3)
  })
})

describe("resizing", () => {
  it("re-fits on resize while the user has not touched the view", () => {
    layout.w = 1366; layout.h = 723; mount()
    const before = readView()
    layout.w = 900; layout.h = 700; fireResize()
    const after = readView()
    expect(after.scale).toBeLessThan(before.scale)
    expect(after.scale).toBeCloseTo(expectedFor(EMPTY_BOARD, 900, 700).scale, 3)
  })
  it("preserves manual zoom and pan across later resizes", () => {
    layout.w = 1366; layout.h = 723; mount()
    fireEvent.click(screen.getByRole("button", { name: /zoom in/i }))
    const user = readView()
    layout.w = 1000; layout.h = 650; fireResize()
    layout.w = 1500; layout.h = 800; fireResize()
    expect(readView()).toEqual(user)
  })
  it("is idempotent: repeated observer callbacks at the same size do not move the view", () => {
    layout.w = 1366; layout.h = 723; mount()
    const v = readView(); fireResize(); fireResize(); fireResize()
    expect(readView()).toEqual(v)
  })
  it("Fit to View resets a manual view and re-arms auto-fit", () => {
    layout.w = 1366; layout.h = 723; mount()
    fireEvent.click(screen.getByRole("button", { name: /zoom in/i }))
    fireEvent.click(screen.getByRole("button", { name: "Fit to Screen" }))
    expect(readView().scale).toBeCloseTo(expectedFor(EMPTY_BOARD, 1366, 723).scale, 3)
    layout.w = 900; layout.h = 700; fireResize()
    expect(readView().scale).toBeCloseTo(expectedFor(EMPTY_BOARD, 900, 700).scale, 3)
  })
  it("a hidden -> visible cycle at the same size keeps a manual view", () => {
    layout.w = 1366; layout.h = 723; mount()
    fireEvent.click(screen.getByRole("button", { name: /zoom in/i }))
    const user = readView()
    layout.w = 0; layout.h = 0; fireResize()
    layout.w = 1366; layout.h = 723; fireResize()
    expect(readView()).toEqual(user)
  })
})

describe("regressions", () => {
  it("fitting and zooming never alter student-authored content", () => {
    layout.w = 1000; layout.h = 700; const { container } = mount(STUDENT)
    fireEvent.click(screen.getByRole("button", { name: /zoom in/i })); layout.w = 700; fireResize()
    expect(container.querySelector('[data-author="student"]')?.textContent).toBe("keep me")
  })
  it("Live Voice entry point is still present", () => {
    layout.w = 1000; layout.h = 700; mount()
    expect(screen.getAllByRole("button").some((b) => /voice|live|mic/i.test(`${b.getAttribute("aria-label")} ${b.getAttribute("title")}`))).toBe(true)
  })
})

describe("uncontrolled SmartBoard (teacher review) keeps its contained layout", () => {
  it("is not switched to workspace mode", () => {
    render(<SmartBoard board={EMPTY_BOARD} readOnly fit="width" />)
    expect(document.querySelector("[data-board-viewport]")!.getAttribute("data-board-viewport")).toBe("contained")
    expect(document.querySelector<HTMLElement>("[data-board-surface]")!.style.width).not.toBe("")
  })
})
