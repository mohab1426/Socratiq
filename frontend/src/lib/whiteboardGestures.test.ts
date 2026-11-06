import { describe, expect, it } from "vitest"
import { camelize } from "./api"
import { circleFromDrag, dragBox, isDrawableBox, MIN_CIRCLE_SIZE } from "./shapeDrag"
import {
  BOARD_H, BOARD_W, EMPTY_BOARD, arrowEndpoints, clampElementPosition, clampGroupDelta, commit, fromServer, hitAnyElement, hitElement,
  moveElement, moveElements, redo, startHistory, toWire, undo, type Board, type BoardElement,
} from "./whiteboard"

const el = (over: Partial<BoardElement> & { id: string; kind: BoardElement["kind"] }): BoardElement =>
  ({ author: "student", seq: 0, x: 100, y: 100, w: 100, h: 60, ...over }) as BoardElement
const boardOf = (...els: BoardElement[]): Board => ({ ...EMPTY_BOARD, elements: els, nextSeq: els.length })

describe("history coalescing (one gesture = one undo step)", () => {
  const b = (n: number): Board => boardOf(el({ id: "a", kind: "shape", w: n }))

  it("merges successive updates that share a key into a single history entry", () => {
    let h = startHistory(b(100))
    for (let i = 1; i <= 200; i++) h = commit(h, b(100 + i), "resize:1")
    expect(h.past).toHaveLength(1) // not 200
    expect(h.present.elements[0].w).toBe(300)
    expect(undo(h).present.elements[0].w).toBe(100) // ONE undo restores the pre-gesture state
  })

  it("a long gesture does not evict earlier history (it used to push 60+ entries and drop the rest)", () => {
    let h = startHistory(b(1))
    for (let i = 2; i <= 6; i++) h = commit(h, b(i)) // five earlier, separate user actions
    for (let i = 0; i < 500; i++) h = commit(h, b(1000 + i), "rotate:9")
    expect(h.past).toHaveLength(6)
    const back = undo(h)
    expect(back.present.elements[0].w).toBe(6)
    expect(undo(undo(undo(undo(undo(back))))).present.elements[0].w).toBe(1)
  })

  it("different keys, and unkeyed commits, always start a new undo step", () => {
    let h = startHistory(b(1))
    h = commit(h, b(2), "resize:1")
    h = commit(h, b(3), "resize:2")
    h = commit(h, b(4))
    h = commit(h, b(5), "resize:2") // same key as before, but an unkeyed step intervened
    expect(h.past).toHaveLength(4)
  })

  it("undo/redo still behave after coalesced gestures and clear the key", () => {
    let h = startHistory(b(1))
    for (let i = 2; i <= 30; i++) h = commit(h, b(i), "g")
    const u = undo(h)
    expect(u.key).toBeUndefined()
    expect(redo(u).present.elements[0].w).toBe(30)
    expect(commit(u, b(99), "g").past).toHaveLength(1) // a new gesture after undo is a new step
  })

  it("committing the same board object is a no-op", () => {
    const h = startHistory(b(1))
    expect(commit(h, h.present, "x")).toBe(h)
  })
})

describe("moveElement / group clamping keeps the WHOLE drawn extent on the board", () => {
  const leftLine = el({ id: "l", kind: "line", x: 500, y: 300, w: 300, h: 50, x2: 200, y2: 350 }) // points left and down
  const leftArrow = el({ id: "a", kind: "arrow", x: 600, y: 400, w: -250, h: -80 }) // points left and up

  it("a left-pointing line cannot be dragged off the LEFT edge (its end is 300 left of its anchor)", () => {
    const c = clampElementPosition(leftLine, -50, 300)
    expect(c.x).toBe(300) // anchor stays >= the 300 the line reaches to the left
  })

  it("a left/up-pointing arrow cannot be dragged off the left or top edge", () => {
    const c = clampElementPosition(leftArrow, 10, 10)
    expect(c.x).toBe(250)
    expect(c.y).toBe(80)
  })

  it("moving a line keeps both endpoints rigidly together", () => {
    const moved = moveElement(boardOf(leftLine), "l", 700, 500).elements[0]
    expect([moved.x, moved.y, moved.x2, moved.y2]).toEqual([700, 500, 400, 550])
  })

  it("a plain rectangle is clamped exactly as before (right/bottom edges)", () => {
    const r = el({ id: "r", kind: "shape", w: 200, h: 100 })
    expect(clampElementPosition(r, 5000, 5000)).toEqual({ x: BOARD_W - 200, y: BOARD_H - 100 })
    expect(clampElementPosition(r, -5, -5)).toEqual({ x: 0, y: 0 })
  })

  it("a group dragged into the right edge moves rigidly instead of squashing together", () => {
    const a = el({ id: "a", kind: "text", x: 1800, y: 100, w: 150, h: 50 })
    const b = el({ id: "b", kind: "text", x: 1500, y: 300, w: 150, h: 50 })
    const { board, dx } = moveElements(boardOf(a, b), new Set(["a", "b"]), 500, 0)
    const [na, nb] = board.elements
    expect(dx).toBe(50) // limited by the element nearest the edge
    expect(na.x - nb.x).toBe(300) // relative layout preserved (per-element clamping made this 0)
    expect(na.x + na.w).toBeLessThanOrEqual(BOARD_W)
  })

  it("clampGroupDelta never moves a group that is wider than the board", () => {
    const wide = [el({ id: "a", kind: "shape", x: 0, w: 1100 }), el({ id: "b", kind: "shape", x: 1000, w: 1000 })]
    expect(clampGroupDelta(wide, 300, 0).dx).toBe(0)
  })

  it("group moves carry line endpoints along", () => {
    const { board } = moveElements(boardOf(leftLine, el({ id: "r", kind: "shape" })), new Set(["l", "r"]), 40, 30)
    const l = board.elements[0]
    expect([l.x, l.y, l.x2, l.y2]).toEqual([540, 330, 240, 380])
  })
})

describe("hitAnyElement: the eraser can reach every element kind", () => {
  const rect = el({ id: "rect", kind: "shape", shape: "rect", x: 100, y: 100, w: 200, h: 100 })
  const circle = el({ id: "circ", kind: "circle", shape: "circle", x: 400, y: 100, w: 100, h: 100 })
  const line = el({ id: "line", kind: "line", x: 600, y: 100, w: 200, h: 100, x2: 800, y2: 200 })
  const arrow = el({ id: "arrow", kind: "arrow", x: 1000, y: 100, w: -200, h: 100 }) // drawn from (1000,100) to (800,200)
  const path = el({ id: "path", kind: "path", x: 1100, y: 100, w: 100, h: 50, pathData: "M 0 0 L 100 50" })
  const image = el({ id: "img", kind: "image", x: 1300, y: 100, w: 100, h: 100 })
  const board = boardOf(rect, circle, line, arrow, path, image)

  it.each([
    ["shape", 200, 150, "rect"],
    ["circle", 450, 150, "circ"],
    ["line", 700, 150, "line"],
    ["left/down-pointing arrow", 900, 150, "arrow"],
    ["path", 1150, 125, "path"],
    ["image", 1350, 150, "img"],
  ])("finds a %s", (_n, x, y, id) => {
    expect(hitAnyElement(board, x, y)?.id).toBe(id)
  })

  it("uses the segment, not the bounding box, for lines and arrows", () => {
    expect(hitAnyElement(board, 780, 110)).toBeNull() // inside the line's box, far from the line
    expect(hitAnyElement(board, 702, 152)?.id).toBe("line") // within tolerance of the line
  })

  it("misses empty space and returns the topmost of overlapping elements", () => {
    expect(hitAnyElement(board, 20, 20)).toBeNull()
    const over = boardOf(rect, el({ id: "top", kind: "shape", x: 150, y: 120, w: 100, h: 50 }))
    expect(hitAnyElement(over, 200, 140)?.id).toBe("top")
  })

  it("tests rotated elements in their own frame", () => {
    // 200x40 bar centred at (300,300), rotated 90deg => occupies x 280..320, y 200..400
    const bar = el({ id: "bar", kind: "shape", x: 200, y: 280, w: 200, h: 40, rotation: 90 })
    const b = boardOf(bar)
    expect(hitAnyElement(b, 300, 210)?.id).toBe("bar")
    expect(hitAnyElement(b, 380, 300)).toBeNull() // inside the UNrotated box only
  })

  it("follows attached arrows to the live positions of their endpoints", () => {
    const a = el({ id: "a", kind: "shape", x: 100, y: 100, w: 100, h: 100 })
    const c = el({ id: "c", kind: "shape", x: 500, y: 100, w: 100, h: 100 })
    const link = el({ id: "k", kind: "arrow", x: 0, y: 0, w: 1, h: 0, fromId: "a", toId: "c" })
    const pts = arrowEndpoints(link, new Map([["a", a], ["c", c]]))!
    const midX = (pts[0][0] + pts[1][0]) / 2
    expect(hitAnyElement(boardOf(a, c, link), midX, 150)?.id).toBe("k")
  })

  it("hitElement (link targets, click-to-edit) is still text/equation only", () => {
    expect(hitElement(board, 200, 150)).toBeNull()
    expect(hitElement(boardOf(el({ id: "t", kind: "text", x: 10, y: 10, w: 100, h: 40 })), 20, 20)?.id).toBe("t")
  })
})

describe("drag-shape geometry (preview == commit)", () => {
  it.each([
    ["right/down", [100, 100], [220, 180]],
    ["left/down", [300, 100], [180, 180]],
    ["right/up", [100, 300], [220, 220]],
    ["left/up", [300, 300], [180, 220]],
  ] as const)("circle inscribed in the drag box, %s", (_n, a, b) => {
    const box = dragBox(a, b)
    const c = circleFromDrag(a, b)
    expect(c.w).toBe(c.h)
    expect(c.w).toBe(Math.min(box.w, box.h)) // 80, never the 144 diagonal
    expect(c.x).toBeGreaterThanOrEqual(box.x)
    expect(c.y).toBeGreaterThanOrEqual(box.y)
    expect(c.x + c.w).toBeLessThanOrEqual(box.x + box.w)
    expect(c.y + c.h).toBeLessThanOrEqual(box.y + box.h)
    // anchored at the corner where the drag started
    expect(c.x === a[0] || c.x + c.w === a[0]).toBe(true)
    expect(c.y === a[1] || c.y + c.h === a[1]).toBe(true)
  })

  it("dragBox is direction independent", () => {
    expect(dragBox([300, 300], [100, 120])).toEqual({ x: 100, y: 120, w: 200, h: 180 })
  })

  it("thin bars are drawable; clicks and specks are not", () => {
    expect(isDrawableBox(200, 12)).toBe(true)
    expect(isDrawableBox(12, 200)).toBe(true)
    expect(isDrawableBox(0, 0)).toBe(false)
    expect(isDrawableBox(40, 3)).toBe(false)
    expect(isDrawableBox(20, 20)).toBe(false)
    expect(MIN_CIRCLE_SIZE).toBeGreaterThan(0)
  })
})

describe("save -> reload keeps element geometry (toWire -> JSON -> camelize -> fromServer)", () => {
  const original: BoardElement[] = [
    el({ id: "t", kind: "text", x: 120, y: 80, w: 310, h: 64, text: "hello", fontSize: 32, color: "#112233" }),
    el({ id: "s", kind: "shape", shape: "rect", x: 500, y: 100, w: 200, h: 90, filled: true, strokeWidth: 5, rotation: 33.5 }),
    el({ id: "l", kind: "line", x: 900, y: 500, w: 300, h: 80, x2: 600, y2: 420 }),
    el({ id: "a", kind: "arrow", x: 1400, y: 700, w: -350, h: -120 }),
    el({ id: "p", kind: "path", x: 300, y: 600, w: 200, h: 50, pathData: "M 0 0 L 100 50 L 200 0" }),
    el({ id: "k", kind: "arrow", x: 0, y: 0, w: 1, h: 0, fromId: "t", toId: "s" }),
  ]
  const reloaded = (): Board => {
    const wire = toWire({ ...EMPTY_BOARD, elements: original, strokes: [{ t: "h", w: 20, pts: [[10, 20], [30, 40]], color: "#facc15" } as any], nextSeq: 6 })
    return fromServer(camelize<Board>(JSON.parse(JSON.stringify(wire))))
  }

  it("round-trips every element's geometry exactly, including signed arrow extents and line end points", () => {
    const back = reloaded()
    for (const o of original) {
      const r = back.elements.find((e) => e.id === o.id)!
      expect([r.x, r.y, r.w, r.h]).toEqual([o.x, o.y, o.w, o.h])
      expect(r.x2).toBe(o.x2)
      expect(r.y2).toBe(o.y2)
      expect(r.rotation).toBe(o.rotation)
      expect(r.pathData).toBe(o.pathData)
      expect(r.fromId).toBe(o.fromId)
      expect(r.toId).toBe(o.toId)
    }
  })

  it("a reloaded left/up arrow still draws in the same direction", () => {
    const a = reloaded().elements.find((e) => e.id === "a")!
    expect(arrowEndpoints(a, new Map())).toEqual([[1400, 700], [1050, 580]])
  })

  it("keeps strokes (colour, width, tool) intact", () => {
    expect(reloaded().strokes[0]).toMatchObject({ t: "h", w: 20, color: "#facc15", pts: [[10, 20], [30, 40]] })
  })

  it("serialised size stays far below the 400 KB storage limit for a realistic board", () => {
    expect(JSON.stringify(toWire({ ...EMPTY_BOARD, elements: original })).length).toBeLessThan(4000)
  })
})
