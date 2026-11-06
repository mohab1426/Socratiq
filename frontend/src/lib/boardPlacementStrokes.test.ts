import { describe, expect, it } from "vitest"
import {
  getOccupiedBoxes,
  getStrokeOccupancyBoxes,
  hasBoxCollision,
  isPlacementVisible,
  planBatchLayout,
  verifyAndReflowLayout,
} from "@/lib/boardLayoutEngine"
import { getSmartPlacement } from "@/lib/smartPlacement"
import { BOARD_H, EMPTY_BOARD, type Board, type BoardElement, type Stroke } from "@/lib/whiteboard"

const view = { x: 0, y: 0, scale: 1 }

function ring(cx: number, cy: number, r: number, n = 60): Stroke {
  const pts: [number, number][] = []
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI * 2
    pts.push([Math.round(cx + r * Math.cos(a)), Math.round(cy + r * Math.sin(a))])
  }
  return { t: "p", w: 4, pts }
}

describe("stroke occupancy", () => {
  it("ignores eraser strokes and empty strokes", () => {
    const boxes = getStrokeOccupancyBoxes([
      { t: "e", w: 4, pts: [[10, 10], [50, 50]] },
      { t: "p", w: 4, pts: [] },
    ])
    expect(boxes).toHaveLength(0)
  })

  it("covers the ink of a pen stroke", () => {
    const boxes = getStrokeOccupancyBoxes([{ t: "p", w: 4, pts: [[100, 100], [160, 100]] }])
    expect(hasBoxCollision({ x: 120, y: 98, w: 10, h: 4 }, boxes, 0)).toBe(true)
  })

  it("does not treat a large circled region as fully occupied", () => {
    const boxes = getStrokeOccupancyBoxes([ring(500, 400, 150)])
    expect(boxes.length).toBeGreaterThan(1)
    // The empty middle of the ring stays available for new content.
    expect(hasBoxCollision({ x: 470, y: 370, w: 60, h: 60 }, boxes, 0)).toBe(false)
  })

  it("is included in the occupied set together with elements", () => {
    const el: BoardElement = { id: "a", kind: "text", author: "student", seq: 0, x: 600, y: 600, w: 100, h: 50 }
    const board: Board = { ...EMPTY_BOARD, elements: [el], strokes: [ring(300, 300, 50)] }
    expect(getOccupiedBoxes(board).length).toBeGreaterThan(1)
  })
})

describe("stroke occupancy stays tight", () => {
  it("a sparse 900px diagonal swipe reserves a thin band, not a quarter of the board", () => {
    const boxes = getStrokeOccupancyBoxes([{ t: "p", w: 4, pts: [[100, 100], [500, 400], [1000, 800]] }])
    const area = boxes.reduce((a, b) => a + b.w * b.h, 0)
    expect(area).toBeLessThan(80000)
    for (const b of boxes) {
      expect(b.w).toBeLessThanOrEqual(100)
      expect(b.h).toBeLessThanOrEqual(100)
    }
  })

  it("leaves no gap along the ink: every sampled point of the stroke is inside some box", () => {
    const pts: [number, number][] = [[100, 100], [500, 400], [1000, 800]]
    const boxes = getStrokeOccupancyBoxes([{ t: "p", w: 4, pts }])
    for (let i = 0; i < pts.length - 1; i++) {
      for (let t = 0; t <= 1; t += 0.01) {
        const x = pts[i][0] + (pts[i + 1][0] - pts[i][0]) * t
        const y = pts[i][1] + (pts[i + 1][1] - pts[i][1]) * t
        expect(boxes.some((q) => x >= q.x && x <= q.x + q.w && y >= q.y && y <= q.y + q.h)).toBe(true)
      }
    }
  })

  it("keeps the box count proportional to ink length on a worst-case board", () => {
    const strokes: Stroke[] = []
    for (let i = 0; i < 600; i++) {
      const pts: [number, number][] = []
      for (let k = 0; k < 49; k++) pts.push([40 + k * 38, 40 + (i % 60) * 18])
      strokes.push({ t: "p", w: 4, pts })
    }
    expect(getStrokeOccupancyBoxes(strokes).length).toBeLessThan(20000)
  })
})

describe("getSmartPlacement with freehand ink", () => {
  it("does not place new content on top of handwriting that fills the visible area", () => {
    const strokes: Stroke[] = []
    for (let y = 70; y <= 610; y += 18) {
      const pts: [number, number][] = []
      for (let x = 40; x <= 980; x += 10) pts.push([x, y])
      strokes.push({ t: "p", w: 4, pts })
    }
    const board: Board = { ...EMPTY_BOARD, strokes }
    const pos = getSmartPlacement(board, view, 200, 100, null)
    expect(hasBoxCollision({ x: pos.x, y: pos.y, w: 200, h: 100 }, getOccupiedBoxes(board), 20)).toBe(false)
  })
})

describe("getSmartPlacement next to a selected element", () => {
  it("does not choose a spot the user cannot see", () => {
    // 1000x700 container at scale 1: the selected shape hugs the right edge of the visible area,
    // so "to the right" would be off-screen.
    const sel: BoardElement = { id: "s", kind: "shape", author: "student", seq: 0, x: 800, y: 100, w: 150, h: 80 }
    const board: Board = { ...EMPTY_BOARD, elements: [sel] }
    const pos = getSmartPlacement(board, view, 300, 150, "s", 1000, 700)
    expect(isPlacementVisible({ x: pos.x, y: pos.y, w: 300, h: 150 }, view, { width: 1000, height: 700 })).toBe(true)
    expect(pos.x === 974 && pos.y === 100).toBe(false)
  })

  it("keeps the contextual spot when it is free and visible", () => {
    const sel: BoardElement = { id: "s", kind: "shape", author: "student", seq: 0, x: 100, y: 100, w: 200, h: 80 }
    const board: Board = { ...EMPTY_BOARD, elements: [sel] }
    const pos = getSmartPlacement(board, view, 300, 150, "s", 1000, 700)
    expect(pos.x).toBe(324)
    expect(pos.y).toBe(100)
  })
})

describe("isPlacementVisible", () => {
  it("is true inside the unobstructed area and false under the toolbar or off-screen", () => {
    const c = { width: 1000, height: 700 }
    expect(isPlacementVisible({ x: 100, y: 100, w: 200, h: 100 }, view, c)).toBe(true)
    expect(isPlacementVisible({ x: 100, y: 10, w: 200, h: 40 }, view, c)).toBe(false) // under the toolbar
    expect(isPlacementVisible({ x: 1500, y: 100, w: 200, h: 100 }, view, c)).toBe(false) // off-screen
    expect(isPlacementVisible({ x: 1500, y: 100, w: 200, h: 100 }, undefined)).toBe(true) // no view info
  })
})

describe("verifyAndReflowLayout", () => {
  const mk = (over: Partial<BoardElement>): BoardElement => ({
    id: "x", kind: "shape", author: "coach", seq: 0, x: 100, y: 100, w: 200, h: 100, ...over,
  })

  it("never moves student-authored elements, and uses their rendered size to keep clear of them", () => {
    const student = mk({ id: "s", author: "student", w: 200, h: 100 })
    const coach = mk({ id: "c", x: 120, y: 230 })
    // The student's text rendered taller than estimated (100 -> 160): the coach element must clear it.
    const { updatedElements } = verifyAndReflowLayout(
      { ...EMPTY_BOARD, elements: [student, coach] },
      new Map([["s", { x: 100, y: 100, w: 200, h: 160 }]]),
    )
    const s = updatedElements.find((e) => e.id === "s")!
    expect(s.x).toBe(100)
    expect(s.y).toBe(100)
    expect(updatedElements.find((e) => e.id === "c")!.y).toBe(100 + 160 + 20)
  })

  it("does not copy a rotated element's axis-aligned DOM box into its size", () => {
    const rotated = mk({ id: "r", rotation: 45, x: 600, y: 600 })
    const blocker = mk({ id: "b", author: "student", x: 100, y: 100 })
    const overlapper = mk({ id: "o", x: 110, y: 110 })
    const { updatedElements } = verifyAndReflowLayout(
      { ...EMPTY_BOARD, elements: [blocker, overlapper, rotated] },
      new Map([["r", { x: 560, y: 560, w: 283, h: 283 }]]),
    )
    const r = updatedElements.find((e) => e.id === "r")!
    expect(r.w).toBe(200)
    expect(r.h).toBe(100)
  })

  it("moves an overlapping coach element below the blocker, never past the board bottom", () => {
    const student = mk({ id: "s", author: "student" })
    const coach = mk({ id: "c", x: 120, y: 120 })
    const ok = verifyAndReflowLayout({ ...EMPTY_BOARD, elements: [student, coach] }, new Map())
    expect(ok.needsReflow).toBe(true)
    expect(ok.updatedElements.find((e) => e.id === "c")!.y).toBe(100 + 100 + 20)

    const nearBottom = mk({ id: "s2", author: "student", y: BOARD_H - 160, h: 100 })
    const trapped = mk({ id: "c2", x: 120, y: BOARD_H - 150, h: 100 })
    const res = verifyAndReflowLayout({ ...EMPTY_BOARD, elements: [nearBottom, trapped] }, new Map())
    const c2 = res.updatedElements.find((e) => e.id === "c2")!
    expect(c2.y + c2.h).toBeLessThanOrEqual(BOARD_H)
  })
})

describe("planBatchLayout on a board that already has ink", () => {
  const container = { width: 1000, height: 700 }
  const viewState = { x: 0, y: 0, scale: 1 }

  // Handwriting fills the left half of the visible area.
  const ink: Stroke[] = []
  for (let y = 80; y <= 600; y += 20) ink.push({ t: "p", w: 4, pts: [[40, y], [200, y], [400, y]] })
  const existing: BoardElement = { id: "old", kind: "text", author: "student", seq: 0, x: 600, y: 100, w: 200, h: 60, text: "note" }
  const board: Board = { ...EMPTY_BOARD, strokes: ink, elements: [existing] }

  const calls = [
    { name: "draw_rectangle", args: { x: 100, y: 100, width: 120, height: 60, id: "a" } },
    { name: "draw_rectangle", args: { x: 100, y: 220, width: 120, height: 60, id: "b" } },
    { name: "draw_arrow", args: { fromId: "a", toId: "b" } },
  ]

  it("keeps the whole diagram off the existing ink and elements", () => {
    const plan = planBatchLayout(calls, board, viewState, null, container)
    const occupied = getOccupiedBoxes(board)
    expect(plan.items.length).toBe(3)
    for (const item of plan.items.filter((i) => i.kind !== "arrow")) {
      expect(hasBoxCollision(item.box, occupied, 10)).toBe(false)
    }
  })

  it("moves the diagram as one group, preserving its internal offsets", () => {
    const plan = planBatchLayout(calls, board, viewState, null, container)
    const [a, b] = plan.items
    expect(b.box.y - a.box.y).toBe(120)
    expect(b.box.x - a.box.x).toBe(0)
  })

  it("places the diagram inside the visible, unobstructed area when room exists", () => {
    const plan = planBatchLayout(calls, board, viewState, null, container)
    for (const item of plan.items.filter((i) => i.kind !== "arrow")) {
      expect(isPlacementVisible(item.box, viewState, container)).toBe(true)
    }
  })
})
