import { describe, expect, it } from "vitest"
import {
  MAX_SCALE,
  MIN_SCALE,
  MIN_VISIBLE_BOARD_PX,
  boardToScreen,
  clampScale,
  clampViewToBoard,
  computeFitView,
  computeRevealView,
  contentFitBox,
  NO_OCCLUSION,
  screenToBoard,
  wheelZoomFactor,
  zoomAtPoint,
} from "@/lib/boardViewport"
import { getOccupiedBoxes } from "@/lib/boardLayoutEngine"
import { BOARD_H, BOARD_W, EMPTY_BOARD, type Stroke } from "@/lib/whiteboard"

describe("coordinate conversion", () => {
  it("round-trips screen <-> board at several zoom levels and pans", () => {
    for (const scale of [MIN_SCALE, 0.4, 1, 2.5, MAX_SCALE]) {
      for (const [x, y] of [[0, 0], [-200, 80], [350.5, 910.25]]) {
        const view = { x, y, scale }
        const b = screenToBoard(view, 123, 456)
        const s = boardToScreen(view, b.x, b.y)
        expect(s.x).toBeCloseTo(123, 6)
        expect(s.y).toBeCloseTo(456, 6)
      }
    }
  })
})

describe("zoomAtPoint", () => {
  it("keeps the board point under the cursor fixed", () => {
    const view = { x: 100, y: 50, scale: 0.5 }
    const before = screenToBoard(view, 300, 200)
    const next = zoomAtPoint(view, 300, 200, 1.6)
    const after = screenToBoard(next, 300, 200)
    expect(next.scale).toBe(1.6)
    expect(after.x).toBeCloseTo(before.x, 6)
    expect(after.y).toBeCloseTo(before.y, 6)
  })

  it("clamps to the zoom limits and still keeps the focal point fixed", () => {
    const view = { x: 10, y: 20, scale: 4 }
    const before = screenToBoard(view, 80, 90)
    const next = zoomAtPoint(view, 80, 90, 99)
    expect(next.scale).toBe(MAX_SCALE)
    const after = screenToBoard(next, 80, 90)
    expect(after.x).toBeCloseTo(before.x, 6)
    expect(zoomAtPoint(view, 80, 90, 0.0001).scale).toBe(MIN_SCALE)
  })

  it("clampScale tolerates non-finite input", () => {
    expect(clampScale(Number.NaN)).toBe(MIN_SCALE)
    expect(clampScale(Infinity)).toBe(MIN_SCALE)
    expect(clampScale(2)).toBe(2)
  })
})

describe("wheelZoomFactor", () => {
  it("zooms in on negative delta and out on positive delta", () => {
    expect(wheelZoomFactor(-100)).toBeGreaterThan(1)
    expect(wheelZoomFactor(100)).toBeLessThan(1)
  })

  it("is proportional: a pinch tick moves far less than a wheel notch", () => {
    expect(Math.abs(Math.log(wheelZoomFactor(-2)))).toBeLessThan(Math.abs(Math.log(wheelZoomFactor(-100))))
  })

  it("bounds a single event and honours line mode", () => {
    expect(wheelZoomFactor(-100000)).toBe(2)
    expect(wheelZoomFactor(100000)).toBe(0.5)
    expect(wheelZoomFactor(-3, 1)).toBeCloseTo(wheelZoomFactor(-48, 0), 10)
  })
})

describe("clampViewToBoard", () => {
  const container = { width: 1000, height: 700 }

  it("returns the same object when the view is already valid", () => {
    const view = { x: 0, y: 0, scale: 0.5 }
    expect(clampViewToBoard(view, container)).toBe(view)
  })

  it("never lets the board be panned completely out of reach", () => {
    for (const view of [
      { x: 99999, y: 0, scale: 1 },
      { x: -99999, y: 0, scale: 1 },
      { x: 0, y: 99999, scale: 1 },
      { x: 0, y: -99999, scale: 1 },
    ]) {
      const c = clampViewToBoard(view, container)
      const topLeft = boardToScreen(c, 0, 0)
      const bottomRight = boardToScreen(c, BOARD_W, BOARD_H)
      expect(bottomRight.x).toBeGreaterThan(MIN_VISIBLE_BOARD_PX - 1e-6)
      expect(bottomRight.y).toBeGreaterThan(MIN_VISIBLE_BOARD_PX - 1e-6)
      expect(topLeft.x).toBeLessThanOrEqual(container.width - MIN_VISIBLE_BOARD_PX + 1e-6)
      expect(topLeft.y).toBeLessThanOrEqual(container.height - MIN_VISIBLE_BOARD_PX + 1e-6)
    }
  })

  it("leaves the view alone when the container has no real size yet", () => {
    const view = { x: 99999, y: 99999, scale: 1 }
    expect(clampViewToBoard(view, { width: 0, height: 0 })).toBe(view)
  })
})

describe("computeRevealView (Show new content)", () => {
  const container = { width: 1000, height: 700 }

  it("returns null when there is nothing to reveal", () => {
    expect(computeRevealView(container, [], NO_OCCLUSION, { x: 0, y: 0, scale: 1 })).toBeNull()
  })

  it("brings far-away content into view without zooming in past the current scale", () => {
    const current = { x: 0, y: 0, scale: 0.8 }
    const box = { x: 1700, y: 900, w: 200, h: 100 }
    const v = computeRevealView(container, [box], NO_OCCLUSION, current)!
    expect(v.scale).toBeLessThanOrEqual(current.scale + 1e-9)
    const tl = boardToScreen(v, box.x, box.y)
    const br = boardToScreen(v, box.x + box.w, box.y + box.h)
    expect(tl.x).toBeGreaterThan(0)
    expect(tl.y).toBeGreaterThan(0)
    expect(br.x).toBeLessThan(container.width)
    expect(br.y).toBeLessThan(container.height)
  })

  it("zooms out only as much as needed when the new content is larger than the screen", () => {
    const current = { x: 0, y: 0, scale: 1.5 }
    const v = computeRevealView(container, [{ x: 100, y: 100, w: 1800, h: 1000 }], NO_OCCLUSION, current)!
    expect(v.scale).toBeLessThan(current.scale)
  })

  it("keeps new content clear of toolbar/chat occlusion", () => {
    const occ = { top: 80, bottom: 120, left: 0, right: 0 }
    const box = { x: 1500, y: 800, w: 200, h: 100 }
    const v = computeRevealView(container, [box], occ, { x: 0, y: 0, scale: 0.8 })!
    const tl = boardToScreen(v, box.x, box.y)
    const br = boardToScreen(v, box.x + box.w, box.y + box.h)
    expect(tl.y).toBeGreaterThan(occ.top)
    expect(br.y).toBeLessThan(container.height - occ.bottom)
  })
})

describe("Fit to content with freehand strokes", () => {
  it("frames a board that only contains handwriting instead of falling back to the whole page", () => {
    const stroke: Stroke = { t: "p", w: 4, pts: [[1500, 900], [1700, 950], [1750, 1000]] }
    const boxes = getOccupiedBoxes({ ...EMPTY_BOARD, strokes: [stroke] })
    expect(boxes.length).toBeGreaterThan(0)
    const fit = contentFitBox(boxes)
    const full = contentFitBox([])
    expect(fit.w).toBeLessThan(full.w)
    const view = computeFitView({ width: 1000, height: 700 }, fit, NO_OCCLUSION, { maxScale: 1.2 })!
    for (const [px, py] of stroke.pts) {
      const s = boardToScreen(view, px, py)
      expect(s.x).toBeGreaterThan(0)
      expect(s.x).toBeLessThan(1000)
      expect(s.y).toBeGreaterThan(0)
      expect(s.y).toBeLessThan(700)
    }
  })
})
