// @vitest-environment jsdom
import { describe, expect, it } from "vitest"
import {
  doBoxesIntersect,
  computeUnobstructedVisibleViewport,
  estimateContentDimensions,
  scoreCandidatePlacement,
  findCollisionFreePosition,
  computeArrowEndpoints,
  isPlacementVisible,
  planBatchLayout,
  getElementBoundingBox,
  readBoardState,
  verifyAndReflowLayout,
  type RectBox,
  type ContainerDimensions,
  type UiOcclusion,
} from "./boardLayoutEngine"
import { EMPTY_BOARD, type Board, type BoardElement } from "./whiteboard"

describe("boardLayoutEngine", () => {
  describe("computeUnobstructedVisibleViewport", () => {
    it("computes unobstructed visible rect correctly on mobile (375x667)", () => {
      const viewState = { x: 0, y: 0, scale: 0.5 }
      const container: ContainerDimensions = { width: 375, height: 667 }
      const occlusion: UiOcclusion = { top: 100, bottom: 60, left: 0, right: 0 }

      const result = computeUnobstructedVisibleViewport(viewState, container, occlusion)
      expect(result.rawVisibleRect.w).toBe(375 / 0.5) // 750
      // Clamped to BOARD_H (1200) since 667 / 0.5 = 1334 exceeds board canvas
      expect(result.rawVisibleRect.h).toBe(1200)

      // Top occlusion 100px / 0.5 = 200 board units
      expect(result.unobstructedVisibleRect.y).toBe(200)
      // The board is only 1200 units = 600px tall at 0.5x, so it ends at screen y=600. The 60px chat dock
      // occupies screen y 607..667, i.e. empty space BELOW the board, and hides no board content. The
      // unobstructed region therefore runs from 200 to the board's bottom edge: 1000 units. (An earlier
      // version of this test expected 880 = 1200 - 200 - 120, which subtracted the dock from a height that
      // had already been clipped at the board edge.)
      expect(result.unobstructedVisibleRect.h).toBe(1000)
    })

    it("computes unobstructed visible rect on desktop (1920x1080) with chat open", () => {
      const viewState = { x: 200, y: 100, scale: 1.0 }
      const container: ContainerDimensions = { width: 1920, height: 1080 }
      const occlusion: UiOcclusion = { top: 72, bottom: 320, left: 0, right: 0 }

      const result = computeUnobstructedVisibleViewport(viewState, container, occlusion)
      expect(result.rawVisibleRect.x).toBe(200)
      expect(result.rawVisibleRect.y).toBe(100)
      expect(result.unobstructedVisibleRect.y).toBe(100 + 72)
      expect(result.unobstructedVisibleRect.h).toBe(1080 - 72 - 320)
    })
  })

  describe("estimateContentDimensions", () => {
    it("estimates compact equation dimensions for short expressions like x = 5", () => {
      const compactEq = estimateContentDimensions({ kind: "equation", latex: "x = 5" })
      // Small expression must be compact, not bloated into a 240px wide box
      expect(compactEq.w).toBeLessThanOrEqual(140)
      expect(compactEq.w).toBeGreaterThanOrEqual(70)
      expect(compactEq.h).toBeLessThanOrEqual(60)
    })

    it("estimates tall equations with fractions/matrices to prevent visual clipping", () => {
      const tall = estimateContentDimensions({ kind: "equation", latex: "\\frac{x + 1}{\\sqrt{x^2 - 4}}" })
      expect(tall.h).toBeGreaterThanOrEqual(70)
    })

    it("estimates text dimensions and wraps long lines cleanly", () => {
      const shortText = estimateContentDimensions({ kind: "text", text: "Hello", fontSize: 24 })
      expect(shortText.w).toBeGreaterThanOrEqual(80)
      expect(shortText.h).toBeGreaterThanOrEqual(44)

      const multiLine = estimateContentDimensions({
        kind: "text",
        text: "Line 1: Problem Definition\nLine 2: Identify variables\nLine 3: Apply Pythagorean theorem",
        fontSize: 24,
      })
      expect(multiLine.h).toBeGreaterThan(shortText.h)
    })

    it("estimates shapes, simulations, images, and plots", () => {
      const rect = estimateContentDimensions({ kind: "shape", width: 150, height: 100 })
      expect(rect.w).toBe(150)
      expect(rect.h).toBe(100)

      const circle = estimateContentDimensions({ kind: "circle", radius: 50 })
      expect(circle.w).toBe(100)
      expect(circle.h).toBe(100)

      const sim = estimateContentDimensions({ kind: "simulation" })
      expect(sim.w).toBeLessThanOrEqual(480)
      expect(sim.h).toBeLessThanOrEqual(360)

      const plot = estimateContentDimensions({ kind: "plot" })
      expect(plot.w).toBeGreaterThanOrEqual(260)
      expect(plot.h).toBeGreaterThanOrEqual(180)
    })
  })

  describe("scoreCandidatePlacement", () => {
    it("scores unobstructed viewport placement much higher than off-screen placement", () => {
      const viewState = { x: 0, y: 0, scale: 1.0 }
      const container: ContainerDimensions = { width: 1000, height: 700 }
      const occlusion: UiOcclusion = { top: 80, bottom: 80, left: 0, right: 0 }
      const vp = computeUnobstructedVisibleViewport(viewState, container, occlusion)

      // In the middle of unobstructed viewport
      const visibleCandidate: RectBox = { x: 200, y: 200, w: 200, h: 100 }
      const visibleScore = scoreCandidatePlacement(visibleCandidate, [], vp)

      // Occluded by top toolbar (y: 35 is within BOARD_PADDING 32, but < 80)
      const occludedCandidate: RectBox = { x: 200, y: 35, w: 200, h: 40 }
      const occludedScore = scoreCandidatePlacement(occludedCandidate, [], vp)

      // Completely off-screen (y: 850 is > 700 viewport, but within BOARD_H 1200)
      const offscreenCandidate: RectBox = { x: 200, y: 850, w: 200, h: 100 }
      const offscreenScore = scoreCandidatePlacement(offscreenCandidate, [], vp)

      expect(visibleScore).toBeGreaterThan(1200)
      expect(visibleScore).toBeGreaterThan(occludedScore)
      expect(occludedScore).toBeGreaterThan(offscreenScore)
    })

    it("returns -Infinity for candidates that collide with existing elements", () => {
      const existing: RectBox[] = [{ x: 100, y: 100, w: 200, h: 100 }]
      const colliding: RectBox = { x: 150, y: 150, w: 100, h: 100 }
      const score = scoreCandidatePlacement(colliding, existing)
      expect(score).toBe(-Infinity)
    })
  })

  describe("doBoxesIntersect and collision detection", () => {
    it("detects overlapping boxes with safety buffer", () => {
      const box1: RectBox = { x: 100, y: 100, w: 200, h: 100 }
      const box2: RectBox = { x: 150, y: 120, w: 200, h: 100 }
      expect(doBoxesIntersect(box1, box2)).toBe(true)

      const boxFar: RectBox = { x: 400, y: 400, w: 100, h: 100 }
      expect(doBoxesIntersect(box1, boxFar)).toBe(false)
    })

    it("handles rotated elements in bounding box calculation", () => {
      const el: BoardElement = {
        id: "e1",
        kind: "shape",
        author: "coach",
        seq: 1,
        x: 100,
        y: 100,
        w: 200,
        h: 100,
        rotation: 90,
      }
      const aabb = getElementBoundingBox(el)
      expect(aabb.w).toBe(100)
      expect(aabb.h).toBe(200)
    })
  })

  describe("findCollisionFreePosition", () => {
    it("finds non-overlapping position away from existing student work", () => {
      const boardWithStudent: Board = {
        ...EMPTY_BOARD,
        elements: [
          {
            id: "s1",
            kind: "text",
            author: "student",
            seq: 1,
            x: 100,
            y: 100,
            w: 300,
            h: 120,
            text: "Student work: 2x + 4 = 10",
          },
        ],
      }

      const pos = findCollisionFreePosition(boardWithStudent, 250, 100, { x: 100, y: 100 })
      const candidate: RectBox = { x: pos.x, y: pos.y, w: 250, h: 100 }
      const studentBox: RectBox = { x: 100, y: 100, w: 300, h: 120 }

      expect(doBoxesIntersect(candidate, studentBox)).toBe(false)
      expect(pos.x).toBeGreaterThanOrEqual(24)
      expect(pos.y).toBeGreaterThanOrEqual(24)
    })

    it("places content inside visible unobstructed viewport when viewState is provided", () => {
      const board: Board = { ...EMPTY_BOARD }
      const viewState = { x: 300, y: 200, scale: 0.8 }
      const container: ContainerDimensions = { width: 800, height: 600 }
      const occlusion: UiOcclusion = { top: 70, bottom: 70, left: 0, right: 0 }

      const pos = findCollisionFreePosition(board, 200, 100, undefined, [], viewState, 20, container, occlusion)
      const vp = computeUnobstructedVisibleViewport(viewState, container, occlusion)

      // Placed box must be inside the unobstructed viewport
      expect(pos.x).toBeGreaterThanOrEqual(vp.unobstructedVisibleRect.x)
      expect(pos.x + 200).toBeLessThanOrEqual(vp.unobstructedVisibleRect.x + vp.unobstructedVisibleRect.w + 1)
      expect(pos.y).toBeGreaterThanOrEqual(vp.unobstructedVisibleRect.y)
      expect(pos.y + 100).toBeLessThanOrEqual(vp.unobstructedVisibleRect.y + vp.unobstructedVisibleRect.h + 1)
    })
  })

  describe("computeArrowEndpoints", () => {
    it("calculates arrow endpoints at boundaries of shapes rather than centers", () => {
      const boxA: RectBox = { x: 100, y: 100, w: 100, h: 60 }
      const boxB: RectBox = { x: 300, y: 100, w: 100, h: 60 }

      const endpoints = computeArrowEndpoints(boxA, boxB)
      expect(endpoints.x1).toBe(200)
      expect(endpoints.x2).toBe(300)
      expect(endpoints.y1).toBe(130)
      expect(endpoints.y2).toBe(130)
    })
  })

  describe("planBatchLayout", () => {
    it("places multiple elements with distinct, non-overlapping positions in reading order", () => {
      const functionCalls = [
        { name: "write_text", args: { text: "Neural Network Architecture" } },
        { name: "draw_rectangle", args: { width: 120, height: 80 } },
        { name: "draw_circle", args: { radius: 40 } },
        { name: "add_equation", args: { latex: "y = \\sigma(Wx + b)" } },
        { name: "draw_arrow", args: {} },
      ]

      const plan = planBatchLayout(functionCalls, EMPTY_BOARD)
      expect(plan.items.length).toBe(5)

      // Verify that no two content boxes intersect
      for (let i = 0; i < plan.items.length; i++) {
        for (let j = i + 1; j < plan.items.length; j++) {
          const itemA = plan.items[i]
          const itemB = plan.items[j]
          if (itemA.kind !== "arrow" && itemB.kind !== "arrow") {
            const overlaps = doBoxesIntersect(itemA.box, itemB.box, 10)
            expect(overlaps).toBe(false)
          }
        }
      }
    })

    it("preserves relative coordinates for flowchart/diagram groups", () => {
      const functionCalls = [
        { name: "draw_rectangle", args: { x: 100, y: 100, width: 120, height: 60, id: "step1" } },
        { name: "draw_rectangle", args: { x: 100, y: 220, width: 120, height: 60, id: "step2" } },
        { name: "draw_arrow", args: { fromId: "step1", toId: "step2" } },
      ]

      const plan = planBatchLayout(functionCalls, EMPTY_BOARD)
      expect(plan.items.length).toBe(3)

      const box1 = plan.items[0].box
      const box2 = plan.items[1].box
      // Step 2 should be positioned below Step 1 preserving the vertical flow
      expect(box2.y).toBeGreaterThan(box1.y + box1.h)
    })
  })

  describe("readBoardState", () => {
    it("analyzes student vs coach elements and occupancy fraction", () => {
      const board: Board = {
        ...EMPTY_BOARD,
        elements: [
          { id: "s1", kind: "text", author: "student", seq: 1, x: 50, y: 50, w: 200, h: 50, text: "Student idea" },
          { id: "c1", kind: "equation", author: "coach", seq: 2, x: 50, y: 150, w: 240, h: 80, latex: "E = mc^2" },
        ],
        strokes: [{ t: "p", w: 2, pts: [[10, 10], [20, 20]] }],
      }

      const analysis = readBoardState(board)
      expect(analysis.totalElements).toBe(2)
      expect(analysis.studentElements.length).toBe(1)
      expect(analysis.coachElements.length).toBe(1)
      expect(analysis.totalStrokes).toBe(1)
      expect(analysis.summary).toContain("Student idea")
      expect(analysis.occupiedAreaFraction).toBeGreaterThan(0)
    })
  })

  describe("verifyAndReflowLayout", () => {
    it("reflows coach elements when rendered DOM size causes overlap, strictly protecting student work", () => {
      const board: Board = {
        ...EMPTY_BOARD,
        elements: [
          { id: "s1", kind: "text", author: "student", seq: 1, x: 100, y: 100, w: 200, h: 60, text: "Student note" },
          { id: "c1", kind: "text", author: "coach", seq: 2, x: 100, y: 170, w: 200, h: 60, text: "Coach explanation" },
        ],
      }

      const actualBounds: Record<string, RectBox> = {
        s1: { x: 100, y: 100, w: 200, h: 90 },
        c1: { x: 100, y: 170, w: 200, h: 60 },
      }

      const { needsReflow, updatedElements } = verifyAndReflowLayout(board, actualBounds, 20)
      expect(needsReflow).toBe(true)

      const studentEl = updatedElements.find((e) => e.id === "s1")!
      const coachEl = updatedElements.find((e) => e.id === "c1")!

      // Student work must NOT be moved!
      expect(studentEl.y).toBe(100)
      expect(coachEl.y).toBeGreaterThanOrEqual(210)
    })
  })

  describe("typography hierarchy and multi-column expansion", () => {
    it("assigns appropriate font sizes for headings, body, and annotations", () => {
      const heading = estimateContentDimensions({ kind: "text", text: "# Key Concept", role: "heading" })
      expect(heading.fontSize).toBe(32)

      const shortTitle = estimateContentDimensions({ kind: "text", text: "Step 1: Understand the Goal" })
      expect(shortTitle.fontSize).toBe(32)

      const body = estimateContentDimensions({ kind: "text", text: "Here is a standard paragraph of explanation." })
      expect(body.fontSize).toBe(24)

      const note = estimateContentDimensions({ kind: "text", text: "Note: keep in mind x > 0", role: "annotation" })
      expect(note.fontSize).toBe(18)
    })

    it("wraps to next column when vertical space in current column is full", () => {
      const boardWithTallContent: Board = {
        ...EMPTY_BOARD,
        elements: [
          { id: "e1", kind: "shape", author: "student", seq: 1, x: 24, y: 24, w: 500, h: 1100, shape: "rect" },
        ],
      }

      const pos = findCollisionFreePosition(boardWithTallContent, 300, 200)
      expect(pos.x).toBeGreaterThanOrEqual(300)
    })
  })

  // ------------------------------------------------------------------------------------------------
  // Critical bug #2: visible viewport geometry. Expected values are worked out by hand from the contract:
  // board point b is on screen at (b - view) * scale, so a screen interval [a, b] shows the board interval
  // [view + a/scale, view + b/scale], which is THEN clipped to [0, boardSize].
  // ------------------------------------------------------------------------------------------------
  describe("computeUnobstructedVisibleViewport regression (clip AFTER converting screen -> board)", () => {
    const C: ContainerDimensions = { width: 500, height: 400 }
    const NONE: UiOcclusion = { top: 0, bottom: 0, left: 0, right: 0 }
    const rect = (x: number, y: number, w: number, h: number) => ({ x, y, w, h })

    it("prompt example: view.x = -100, zoom 1, 500px wide shows board x 0..400, not 0..500", () => {
      const r = computeUnobstructedVisibleViewport({ x: -100, y: 0, scale: 1 }, C, NONE)
      expect(r.rawVisibleRect).toEqual(rect(0, 0, 400, 400))
      expect(r.unobstructedVisibleRect).toEqual(rect(0, 0, 400, 400))
    })

    it.each([
      ["left edge", { x: -100, y: 0, scale: 1 }, rect(0, 0, 400, 400)],
      ["top edge", { x: 0, y: -100, scale: 1 }, rect(0, 0, 500, 300)],
      ["right edge", { x: 1700, y: 0, scale: 1 }, rect(1700, 0, 300, 400)],
      ["bottom edge", { x: 0, y: 900, scale: 1 }, rect(0, 900, 500, 300)],
      ["top-left corner at zoom 2", { x: -50, y: -50, scale: 2 }, rect(0, 0, 200, 150)],
      ["zoomed out past both edges (0.5x)", { x: -200, y: 0, scale: 0.5 }, rect(0, 0, 800, 800)],
      ["fully inside the board at zoom 4", { x: 300, y: 300, scale: 4 }, rect(300, 300, 125, 100)],
    ])("%s", (_name, view, expected) => {
      const r = computeUnobstructedVisibleViewport(view, C, NONE)
      expect(r.rawVisibleRect).toEqual(expected)
      expect(r.unobstructedVisibleRect).toEqual(expected)
    })

    it("a view that misses the board entirely has an EMPTY visible rect (nothing is inflated to a minimum)", () => {
      const r = computeUnobstructedVisibleViewport({ x: -1000, y: 0, scale: 1 }, C, NONE)
      expect(r.rawVisibleRect.w).toBe(0)
      expect(r.unobstructedVisibleRect.w).toBe(0)
      expect(r.usableWidth).toBe(0)
    })

    it("occlusion is applied in SCREEN space before clipping: toolbar 80, left dock 40, chat 60, right 20", () => {
      // screen x 40..480 -> board -60..380 -> 0..380 ; screen y 80..340 -> board 30..290
      const r = computeUnobstructedVisibleViewport({ x: -100, y: -50, scale: 1 }, C, { top: 80, left: 40, bottom: 60, right: 20 })
      expect(r.rawVisibleRect).toEqual(rect(0, 0, 400, 350))
      expect(r.unobstructedVisibleRect).toEqual(rect(0, 30, 380, 260))
    })

    it("a left dock that covers only empty space left of the board removes nothing from the board", () => {
      // dock covers screen x 0..40 = board -100..-60 (off the board)
      const r = computeUnobstructedVisibleViewport({ x: -100, y: 0, scale: 1 }, C, { top: 0, left: 40, bottom: 0, right: 0 })
      expect(r.unobstructedVisibleRect).toEqual(rect(0, 0, 400, 400))
    })

    it("a top toolbar over empty space above the board removes only what it really covers", () => {
      // view.y = -200: screen y 80..400 -> board -120..200 -> 0..200
      const r = computeUnobstructedVisibleViewport({ x: 0, y: -200, scale: 1 }, C, { top: 80, bottom: 0, left: 0, right: 0 })
      expect(r.rawVisibleRect).toEqual(rect(0, 0, 500, 200))
      expect(r.unobstructedVisibleRect).toEqual(rect(0, 0, 500, 200))
    })

    it("occlusion converts through zoom (px / scale) at scale 2", () => {
      // screen y 80..340 -> board 100 + 40 .. 100 + 170 = 140..270
      const r = computeUnobstructedVisibleViewport({ x: 100, y: 100, scale: 2 }, C, { top: 80, bottom: 60, left: 0, right: 0 })
      expect(r.unobstructedVisibleRect).toEqual(rect(100, 140, 250, 130))
    })

    it("tolerates a null occlusion and an unusable container without throwing", () => {
      expect(() => computeUnobstructedVisibleViewport({ x: 0, y: 0, scale: 1 }, C, null)).not.toThrow()
      const r = computeUnobstructedVisibleViewport({ x: 0, y: 0, scale: 1 }, { width: 0, height: 0 }, NONE)
      expect(r.rawVisibleRect.w).toBeGreaterThan(0)
    })

    it("the unobstructed rect is always contained in the raw rect and in the board", () => {
      for (const view of [{ x: -300, y: -300, scale: 0.7 }, { x: 1800, y: 1100, scale: 1.5 }, { x: 10, y: 10, scale: 3 }]) {
        const { rawVisibleRect: a, unobstructedVisibleRect: u } = computeUnobstructedVisibleViewport(view, C, { top: 70, bottom: 90, left: 20, right: 20 })
        expect(u.x).toBeGreaterThanOrEqual(a.x)
        expect(u.y).toBeGreaterThanOrEqual(a.y)
        expect(u.x + u.w).toBeLessThanOrEqual(a.x + a.w)
        expect(u.y + u.h).toBeLessThanOrEqual(a.y + a.h)
        expect(u.x + u.w).toBeLessThanOrEqual(2000)
        expect(u.y + u.h).toBeLessThanOrEqual(1200)
      }
    })

    it("isPlacementVisible never calls off-screen boxes visible (prompt scenario: x 400..500 is off-screen)", () => {
      const view = { x: -100, y: 0, scale: 1 }
      expect(isPlacementVisible({ x: 420, y: 50, w: 60, h: 40 }, view, C, NONE)).toBe(false)
      expect(isPlacementVisible({ x: 350, y: 50, w: 60, h: 40 }, view, C, NONE)).toBe(false) // spills past 400
      expect(isPlacementVisible({ x: 300, y: 50, w: 60, h: 40 }, view, C, NONE)).toBe(true)
    })

    it("isPlacementVisible honours occlusion in the right coordinate system", () => {
      const view = { x: 0, y: 0, scale: 2 }
      const occ = { top: 80, bottom: 0, left: 0, right: 0 } // hides board y 0..40
      expect(isPlacementVisible({ x: 10, y: 10, w: 30, h: 20 }, view, C, occ)).toBe(false)
      expect(isPlacementVisible({ x: 10, y: 50, w: 30, h: 20 }, view, C, occ)).toBe(true)
    })

    it("isPlacementVisible is false for every box when the visible region is empty, and tolerates null occlusion", () => {
      expect(isPlacementVisible({ x: 10, y: 10, w: 20, h: 20 }, { x: -1000, y: 0, scale: 1 }, C, NONE)).toBe(false)
      expect(() => isPlacementVisible({ x: 10, y: 10, w: 20, h: 20 }, { x: 0, y: 0, scale: 1 }, C, null)).not.toThrow()
    })

    it("findCollisionFreePosition prefers spots inside the TRUE visible region when one is free", () => {
      const view = { x: -100, y: 0, scale: 1 }
      const pos = findCollisionFreePosition(EMPTY_BOARD, 120, 60, undefined, [], view, 20, C, NONE)
      expect(pos.x + 120).toBeLessThanOrEqual(400)
      expect(isPlacementVisible({ ...pos, w: 120, h: 60 }, view, C, NONE)).toBe(true)
    })
  })

  // ------------------------------------------------------------------------------------------------
  // Critical bug #1: planned geometry for lines, arrows and paths
  // ------------------------------------------------------------------------------------------------
  describe("planBatchLayout geometry (lines, arrows, paths)", () => {
    const student = (over: Partial<BoardElement> = {}): BoardElement => ({
      id: "stu", kind: "text", author: "student", seq: 0, x: 100, y: 100, w: 300, h: 76, text: "student work", ...over,
    })
    const boardWith = (...els: BoardElement[]): Board => ({ ...EMPTY_BOARD, elements: els, nextSeq: els.length })
    const byIndex = (plan: ReturnType<typeof planBatchLayout>, i: number) => plan.items.find((it) => it.sourceIndex === i)!

    it("pairs every item with its call by sourceIndex even though items are listed content-first", () => {
      const calls = [
        { name: "draw_arrow", args: {} },
        { name: "write_text", args: { text: "First" } },
        { name: "write_text", args: { text: "Second" } },
      ]
      const plan = planBatchLayout(calls, EMPTY_BOARD)
      expect(plan.items.map((i) => i.sourceIndex).sort()).toEqual([0, 1, 2])
      expect(plan.items[plan.items.length - 1].sourceIndex).toBe(0) // the arrow is listed last...
      expect(byIndex(plan, 0).kind).toBe("arrow") // ...but still identifies as call 0
      expect(byIndex(plan, 1).args.text).toBe("First")
      expect(byIndex(plan, 2).args.text).toBe("Second")
      const a = byIndex(plan, 0).args
      for (const k of ["x1", "y1", "x2", "y2"]) expect(Number.isFinite(a[k])).toBe(true)
    })

    it("moves a diagram rigidly: relative positions, line direction and length survive relocation", () => {
      const board = boardWith(student()) // occupies (100,100)-(400,176), right where the AI drew
      const calls = [
        { name: "draw_rectangle", args: { x: 100, y: 100, width: 120, height: 60 } },
        { name: "draw_rectangle", args: { x: 400, y: 100, width: 120, height: 60 } },
        { name: "draw_line", args: { x1: 220, y1: 130, x2: 400, y2: 130 } },
      ]
      const plan = planBatchLayout(calls, board)
      const r1 = byIndex(plan, 0).box
      const r2 = byIndex(plan, 1).box
      const l = byIndex(plan, 2).args
      expect(doBoxesIntersect(r1, getElementBoundingBox(board.elements[0]), 0)).toBe(false)
      expect(r2.x - r1.x).toBe(300)
      expect(r2.y - r1.y).toBe(0)
      expect(l.x1 - r1.x).toBe(120)
      expect(l.y1 - r1.y).toBe(30)
      expect(l.x2 - l.x1).toBe(180) // same length...
      expect(l.y2 - l.y1).toBe(0) // ...and direction
    })

    it("keeps a right-to-left, bottom-to-top line pointing the same way after relocation", () => {
      const board = boardWith(student({ x: 600, y: 400, w: 200, h: 200 }))
      const calls = [
        { name: "draw_rectangle", args: { x: 600, y: 400, width: 100, height: 60 } },
        { name: "draw_line", args: { x1: 800, y1: 500, x2: 700, y2: 430 } },
      ]
      const plan = planBatchLayout(calls, board)
      const l = byIndex(plan, 1).args
      expect(l.x2 - l.x1).toBe(-100)
      expect(l.y2 - l.y1).toBe(-70)
      const r = byIndex(plan, 0).box
      expect(l.x1 - r.x).toBe(200)
      expect(l.y1 - r.y).toBe(100)
    })

    it("translates the WHOLE path with its group: only x/y move, pathData stays local and the size is the real extent", () => {
      const board = boardWith(student())
      const calls = [
        { name: "draw_rectangle", args: { x: 100, y: 100, width: 120, height: 60 } },
        { name: "draw_path", args: { x: 200, y: 100, pathData: "M 50 20 L 150 70 L 250 20", width: 999, height: 999 } },
      ]
      const plan = planBatchLayout(calls, board)
      const rect = byIndex(plan, 0).box
      const path = byIndex(plan, 1)
      expect(path.args.pathData).toBe("M 0 0 L 100 50 L 200 0")
      expect(path.box.w).toBe(200) // measured from the path, not the bogus width argument
      expect(path.box.h).toBe(50)
      expect(path.box.x - rect.x).toBe(150) // drawn region started at (250,120): +150 / +20 from the rect
      expect(path.box.y - rect.y).toBe(20)
      expect(path.args.x).toBe(path.box.x)
    })

    it("a lone annotation line is preserved exactly, even on top of existing content", () => {
      const board = boardWith(student())
      const plan = planBatchLayout([{ name: "draw_line", args: { x1: 120, y1: 180, x2: 380, y2: 180 } }], board)
      expect(byIndex(plan, 0).args).toMatchObject({ x1: 120, y1: 180, x2: 380, y2: 180 })
    })

    it("a lone arrow keeps its direction (left/up)", () => {
      const plan = planBatchLayout([{ name: "draw_arrow", args: { x1: 800, y1: 300, x2: 500, y2: 250 } }], EMPTY_BOARD)
      expect(byIndex(plan, 0).args).toMatchObject({ x1: 800, y1: 300, x2: 500, y2: 250 })
    })

    it("invalid line coordinates never reach the layout: a default horizontal segment is placed in free space", () => {
      const plan = planBatchLayout([{ name: "draw_line", args: { x1: NaN, y1: 50, x2: "abc", y2: 50 } }], boardWith(student()))
      const a = byIndex(plan, 0).args
      for (const k of ["x1", "y1", "x2", "y2"]) expect(Number.isFinite(a[k])).toBe(true)
      expect(a.x2 - a.x1).toBe(140)
      expect(a.y2).toBe(a.y1)
    })

    it("a valid vector parked at the origin keeps its length and direction but is moved into free space", () => {
      const plan = planBatchLayout([{ name: "draw_line", args: { x1: 0, y1: 0, x2: 200, y2: 120 } }], EMPTY_BOARD)
      const a = byIndex(plan, 0).args
      expect(a.x2 - a.x1).toBe(200)
      expect(a.y2 - a.y1).toBe(120)
      expect(Math.min(a.x1, a.y1)).toBeGreaterThanOrEqual(32)
    })

    it("rejects a path with no pathData and reports its sourceIndex", () => {
      const plan = planBatchLayout([{ name: "write_text", args: { text: "hi" } }, { name: "draw_path", args: { x: 300, y: 300 } }], EMPTY_BOARD)
      expect(plan.rejected).toHaveLength(1)
      expect(plan.rejected[0].sourceIndex).toBe(1)
      expect(plan.items.some((i) => i.kind === "path")).toBe(false)
    })

    it("NaN / junk x,y on content are treated as 'no position' instead of poisoning the group", () => {
      const calls = [
        { name: "write_text", args: { text: "A", x: NaN, y: 100 } },
        { name: "write_text", args: { text: "B", x: "oops", y: "no" } },
      ]
      const plan = planBatchLayout(calls, EMPTY_BOARD)
      for (const it of plan.items) {
        expect(Number.isFinite(it.box.x) && Number.isFinite(it.box.y)).toBe(true)
      }
    })

    it("never mutates the existing board and is deterministic for the same input", () => {
      const board = boardWith(student(), student({ id: "coach1", author: "coach", x: 700, y: 100 }))
      const snapshot = JSON.stringify(board)
      const calls = [
        { name: "draw_rectangle", args: { x: 100, y: 100, width: 120, height: 60 } },
        { name: "draw_path", args: { x: 300, y: 100, pathData: "M 0 0 L 80 40" } },
        { name: "draw_line", args: { x1: 220, y1: 130, x2: 300, y2: 130 } },
      ]
      const a = planBatchLayout(calls, board)
      const b = planBatchLayout(calls, board)
      expect(JSON.stringify(board)).toBe(snapshot)
      const boxes = (p: typeof a) => p.items.map((i) => [i.sourceIndex, i.box])
      expect(boxes(a)).toEqual(boxes(b))
    })

    it("attached connectors follow the final (relocated) boxes of their targets", () => {
      const board = boardWith(student())
      const calls = [
        { name: "draw_rectangle", args: { x: 100, y: 100, width: 120, height: 60 }, element_id: "n1" },
        { name: "draw_rectangle", args: { x: 100, y: 260, width: 120, height: 60 }, element_id: "n2" },
        { name: "draw_arrow", args: { fromId: "n1", toId: "n2" } },
      ]
      const plan = planBatchLayout(calls, board)
      const n1 = byIndex(plan, 0).box
      const n2 = byIndex(plan, 1).box
      const arrow = byIndex(plan, 2).args
      expect(arrow.x1).toBeGreaterThanOrEqual(n1.x)
      expect(arrow.x1).toBeLessThanOrEqual(n1.x + n1.w)
      expect(Math.abs(arrow.y1 - (n1.y + n1.h))).toBeLessThanOrEqual(1) // leaves n1's bottom edge
      expect(Math.abs(arrow.y2 - n2.y)).toBeLessThanOrEqual(1) // enters n2's top edge
    })
  })

  describe("getElementBoundingBox for arrows", () => {
    it("follows the drawn arrow (x,y)->(x+w,y+h), ignoring a stale x2/y2 left over from a drag", () => {
      const el = { id: "a", kind: "arrow", author: "coach", seq: 0, x: 500, y: 500, w: -200, h: 0, x2: 10, y2: 10 } as BoardElement
      expect(getElementBoundingBox(el)).toEqual({ x: 300, y: 500, w: 200, h: 16 })
    })
  })

  describe("verifyAndReflowLayout scoping and idempotence", () => {
    const mk = (id: string, author: "student" | "coach", x: number, y: number, extra: Partial<BoardElement> = {}): BoardElement => ({
      id, kind: "text", author, seq: 0, x, y, w: 200, h: 60, text: id, ...extra,
    })

    it("with onlyIds, older coach content is never shifted or resized", () => {
      const board: Board = { ...EMPTY_BOARD, elements: [mk("oldA", "coach", 100, 100), mk("oldB", "coach", 100, 110), mk("new", "coach", 100, 120)] }
      const bounds = { oldA: { x: 100, y: 100, w: 999, h: 999 }, oldB: { x: 100, y: 110, w: 999, h: 999 }, new: { x: 100, y: 120, w: 200, h: 60 } }
      const { updatedElements } = verifyAndReflowLayout(board, bounds, 20, { onlyIds: new Set(["new"]) })
      const get = (id: string) => updatedElements.find((e) => e.id === id)!
      expect(get("oldA")).toMatchObject({ x: 100, y: 100, w: 200, h: 60 })
      expect(get("oldB")).toMatchObject({ x: 100, y: 110, w: 200, h: 60 })
      expect(get("new").y).toBeGreaterThan(110) // the new element is the one that yields
    })

    it("is idempotent: reflowing its own output changes nothing (no progressive drift)", () => {
      const board: Board = { ...EMPTY_BOARD, elements: [mk("stu", "student", 100, 100), mk("c1", "coach", 100, 110), mk("c2", "coach", 100, 120)] }
      const once = verifyAndReflowLayout(board, {})
      const twice = verifyAndReflowLayout({ ...board, elements: once.updatedElements }, {})
      expect(twice.needsReflow).toBe(false)
      expect(twice.updatedElements).toEqual(once.updatedElements)
    })

    it("never grows a rotated element, however many times it runs", () => {
      let els: BoardElement[] = [mk("rot", "coach", 400, 400, { rotation: 45 })]
      const axisAligned = { rot: { x: 380, y: 380, w: 300, h: 300 } }
      for (let i = 0; i < 5; i++) els = verifyAndReflowLayout({ ...EMPTY_BOARD, elements: els }, axisAligned).updatedElements
      expect(els[0]).toMatchObject({ w: 200, h: 60 })
    })

    it("keeps an attached arrow's direction when its target is shifted (signed w/h, not min/abs)", () => {
      const board: Board = {
        ...EMPTY_BOARD,
        elements: [
          mk("stu", "student", 100, 100, { w: 400 }),
          mk("left", "coach", 700, 300),
          mk("right", "coach", 100, 110), // overlaps the student text -> gets shifted
          { id: "arr", kind: "arrow", author: "coach", seq: 0, x: 0, y: 0, w: 1, h: 1, fromId: "left", toId: "right" } as BoardElement,
        ],
      }
      const out = verifyAndReflowLayout(board, {}, 20, { onlyIds: new Set(["right", "arr"]) }).updatedElements
      const arr = out.find((e) => e.id === "arr")!
      const right = out.find((e) => e.id === "right")!
      expect(right.y).toBeGreaterThan(110)
      expect(arr.x + arr.w).toBeLessThan(arr.x) // arrow points left, from `left` toward `right`
    })

    it("does not rewrite connectors unrelated to anything that moved", () => {
      const line = { id: "ln", kind: "line", author: "coach", seq: 0, x: 900, y: 900, w: 100, h: 50, x2: 1000, y2: 850 } as BoardElement
      const board: Board = { ...EMPTY_BOARD, elements: [mk("stu", "student", 100, 100), mk("c", "coach", 100, 110), line] }
      const out = verifyAndReflowLayout(board, {}).updatedElements
      expect(out.find((e) => e.id === "ln")).toEqual(line)
    })
  })
})
