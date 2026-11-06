import { describe, expect, it } from "vitest"
import {
  EMPTY_BOARD, LIMITS, addElement, arrowEndpoints, canAddElement, canAddStroke, commit, edgePoint, estimateSize, fromLegacy, fromServer, hitElement, isEmptyBoard,
  moveElement, nextSeq, redo, removeElement, simplify, startHistory, studentItems, toWire, totalPoints, undo, updateElement, type Board,
} from "./whiteboard"

const board = (over: Partial<Board> = {}): Board => ({ ...EMPTY_BOARD, ...over })
const stroke = { t: "p" as const, w: 3, pts: [[1, 1]] as [number, number][] }

describe("freehand strokes", () => {
  it("simplify keeps both endpoints and drops points closer than the minimum distance", () => {
    const pts: [number, number][] = [[0, 0], [1, 1], [2, 2], [50, 50], [51, 51], [100, 100]]
    expect(simplify(pts, 6)).toEqual([[0, 0], [50, 50], [100, 100]])
  })
  it("simplify never exceeds the per-stroke point cap the server enforces", () => {
    const pts: [number, number][] = Array.from({ length: 20000 }, (_, i) => [i % 2000, (i * 7) % 2000])
    expect(simplify(pts, 0).length).toBeLessThanOrEqual(LIMITS.strokePoints)
  })
  it("a one- or two-point stroke is returned unchanged", () => {
    expect(simplify([[5, 5]])).toEqual([[5, 5]])
    expect(simplify([[5, 5], [5, 6]])).toEqual([[5, 5], [5, 6]])
  })
  it("canAddStroke stops before the server's stroke and total-point limits", () => {
    expect(canAddStroke(board())).toBe(true)
    expect(canAddStroke(board({ strokes: Array(LIMITS.strokes).fill(stroke) }))).toBe(false)
    const heavy = board({ strokes: Array(8).fill({ t: "p", w: 3, pts: Array(3750).fill([1, 1]) }) })
    expect(totalPoints(heavy)).toBeGreaterThan(LIMITS.totalPoints - 200)
    expect(canAddStroke(heavy)).toBe(false)
  })
})

describe("board content", () => {
  it("isEmptyBoard ignores blank legacy steps but not drawings or elements", () => {
    expect(isEmptyBoard(board({ steps: ["", "  "] }))).toBe(true)
    expect(isEmptyBoard(board({ strokes: [stroke] }))).toBe(false)
    expect(isEmptyBoard(board({ steps: ["x = 7"] }))).toBe(false)
    expect(isEmptyBoard(addElement(board(), { kind: "text", x: 10, y: 10, text: "hi" }).board)).toBe(false)
  })

  it("size estimates match the server's layout constants (same numbers as ai/whiteboard/engine.py)", () => {
    expect(estimateSize("text", "hi")).toEqual([160, 76])
    expect(estimateSize("text", "x".repeat(100))).toEqual([940, 188])
    expect(estimateSize("text", "a\nb")).toEqual([160, 132])
    expect(estimateSize("equation", "", "a+b")).toEqual([220, 100])
    expect(estimateSize("equation", "", "\\frac{a}{b}")).toEqual([264, 160])
  })

  it("adds, edits, moves and removes elements immutably, keeping ids and sequence numbers unique", () => {
    const a = addElement(board(), { kind: "text", x: 60, y: 60, text: "first" })
    const b = addElement(a.board, { kind: "equation", x: 60, y: 200, latex: "2x=6" })
    expect(a.board.elements).toHaveLength(1)
    expect(b.board.elements.map((e) => e.seq)).toEqual([0, 1])
    expect(new Set(b.board.elements.map((e) => e.id)).size).toBe(2)
    expect(b.board.elements.every((e) => e.author === "student")).toBe(true)
    const moved = moveElement(b.board, a.id!, 9999, -50)
    expect(moved.elements[0].x).toBeLessThanOrEqual(2000)
    expect(moved.elements[0].y).toBe(0)
    expect(b.board.elements[0].y).toBe(60)                                    // the original is untouched
    const edited = updateElement(b.board, a.id!, { text: "a much longer piece of text that changes the estimated box" })
    expect(edited.elements[0].w).toBeGreaterThan(b.board.elements[0].w)
    expect(removeElement(b.board, a.id!).elements.map((e) => e.id)).toEqual([b.id])
  })

  it("an edit makes the element the student's, a move does not", () => {
    const coach = board({ elements: [{ id: "c1", kind: "text", author: "coach", seq: 0, x: 10, y: 10, w: 200, h: 76, text: "Subtract 4" }], nextSeq: 1 })
    expect(moveElement(coach, "c1", 300, 300).elements[0].author).toBe("coach")
    expect(updateElement(coach, "c1", { text: "Subtract 5" }).elements[0].author).toBe("student")
  })

  it("erasing an element also removes arrows and frames attached to it", () => {
    let b = addElement(board(), { kind: "text", x: 60, y: 60, text: "a" })
    const a = b.id!
    b = addElement(b.board, { kind: "text", x: 60, y: 300, text: "b" })
    const bb = b.id!
    let c = addElement(b.board, { kind: "arrow", x: 0, y: 0, w: 1, h: 0, fromId: a, toId: bb })
    c = addElement(c.board, { kind: "shape", shape: "rect", x: 0, y: 0, w: 10, h: 10, around: a })
    expect(c.board.elements).toHaveLength(4)
    expect(removeElement(c.board, a).elements.map((e) => e.id)).toEqual([bb])
  })

  it("refuses new elements once the board is full", () => {
    const els = Array.from({ length: LIMITS.elements }, (_, i) => ({ id: `e${i}`, kind: "text" as const, author: "student" as const, seq: i, x: 0, y: 0, w: 100, h: 76, text: "x" }))
    const full = board({ elements: els, nextSeq: LIMITS.elements })
    expect(canAddElement(full)).toBe(false)
    const r = addElement(full, { kind: "text", x: 1, y: 1, text: "no" })
    expect(r.id).toBeNull()
    expect(r.board).toBe(full)
  })

  it("legacy typed steps become student text elements, top to bottom, and the steps list is emptied", () => {
    const b = fromLegacy(board({ steps: ["x + 5 = 12", " ", "x = 7"] }))
    expect(b.steps).toEqual([])
    expect(b.elements.map((e) => e.text)).toEqual(["x + 5 = 12", "x = 7"])
    expect(b.elements.every((e) => e.author === "student")).toBe(true)
    expect(b.elements[1].y).toBeGreaterThan(b.elements[0].y + b.elements[0].h)
    expect(nextSeq(b)).toBe(2)
    expect(fromLegacy(board())).toEqual(board())
  })

  it("studentItems excludes coach-written content", () => {
    const b = board({ elements: [
      { id: "s", kind: "text", author: "student", seq: 0, x: 0, y: 0, w: 1, h: 1, text: "mine" },
      { id: "c", kind: "text", author: "coach", seq: 1, x: 0, y: 0, w: 1, h: 1, text: "theirs" },
      { id: "a", kind: "arrow", author: "student", seq: 2, x: 0, y: 0, w: 5, h: 5 },
    ] })
    expect(studentItems(b).map((e) => e.id)).toEqual(["s"])
  })
})

describe("geometry", () => {
  it("edgePoint lands on the box edge towards the target", () => {
    const box = { x: 100, y: 100, w: 200, h: 100 }
    expect(edgePoint(box, [1000, 150])).toEqual([300, 150])
    expect(edgePoint(box, [200, -1000])[1]).toBeCloseTo(100, 0)
  })
  it("a linked arrow runs between the two elements' edges; a free arrow uses its own vector", () => {
    const a = { id: "a", kind: "text" as const, author: "student" as const, seq: 0, x: 100, y: 100, w: 200, h: 100 }
    const b = { ...a, id: "b", seq: 1, y: 500 }
    const byId = new Map([[a.id, a], [b.id, b]])
    const link = { id: "l", kind: "arrow" as const, author: "coach" as const, seq: 2, x: 0, y: 0, w: 1, h: 0, fromId: "a", toId: "b" }
    const [p0, p1] = arrowEndpoints(link, byId)!
    expect(p0[1]).toBeCloseTo(200, 0)
    expect(p1[1]).toBeCloseTo(500, 0)
    expect(arrowEndpoints({ ...link, fromId: "a", toId: "gone" }, byId)).toBeNull()
    expect(arrowEndpoints({ id: "f", kind: "arrow", author: "student", seq: 3, x: 10, y: 20, w: 100, h: -5 }, byId)).toEqual([[10, 20], [110, 15]])
  })
  it("hitElement returns the topmost text/equation under a point", () => {
    const b = addElement(addElement(board(), { kind: "text", x: 100, y: 100, text: "under" }).board, { kind: "text", x: 110, y: 110, text: "over" }).board
    expect(hitElement(b, 120, 120)?.text).toBe("over")
    expect(hitElement(b, 1900, 1100)).toBeNull()
  })
})

describe("wire format", () => {
  it("sends snake_case links, integers and clamped values the server accepts", () => {
    const wire = toWire(board({ elements: [
      { id: "a", kind: "text", author: "student", seq: 0, x: 10.7, y: 99999, w: 160.2, h: 76, text: "hi" },
      { id: "l", kind: "arrow", author: "student", seq: 1, x: 5, y: 5, w: -3000, h: 10, fromId: "a", toId: "a" },
    ] }))
    expect(wire.elements[0]).toMatchObject({ x: 11, y: 1200, w: 160 })
    expect(wire.elements[1]).toMatchObject({ from_id: "a", to_id: "a", w: -2000 })
    expect(wire.elements[1]).not.toHaveProperty("fromId")
    expect(wire.next_seq).toBe(2)
  })
  it("fromServer tolerates older boards without elements", () => {
    expect(fromServer({ steps: ["x"], strokes: [] })).toEqual({ steps: ["x"], strokes: [], elements: [], nextSeq: 0 })
    expect(fromServer(null)).toEqual(EMPTY_BOARD)
  })
})

describe("undo / redo", () => {
  it("undoes and redoes whole steps, clears redo on a new edit, and ignores no-ops", () => {
    const b0 = board()
    const b1 = addElement(b0, { kind: "text", x: 1, y: 1, text: "one" }).board
    const b2 = addElement(b1, { kind: "text", x: 1, y: 100, text: "two" }).board
    let h = commit(commit(startHistory(b0), b1), b2)
    expect(commit(h, b2)).toBe(h)
    h = undo(h)
    expect(h.present).toBe(b1)
    h = redo(h)
    expect(h.present).toBe(b2)
    h = undo(undo(h))
    expect(h.present).toBe(b0)
    expect(undo(h)).toBe(h)
    h = commit(h, b1)
    expect(h.future).toEqual([])
    expect(redo(h)).toBe(h)
  })
  it("keeps a bounded history", () => {
    let h = startHistory(board())
    for (let i = 0; i < 200; i++) h = commit(h, board({ nextSeq: i + 1 }))
    expect(h.past.length).toBeLessThanOrEqual(60)
  })
})

describe("smartboard extensions", () => {
  it("preserves stroke color and width across serialization", () => {
    const s = { t: "p" as const, w: 6, pts: [[10, 10], [20, 20]] as [number, number][], color: "#ef4444" }
    const b = board({ strokes: [s] })
    const wire = toWire(b)
    expect(wire.strokes[0].color).toBe("#ef4444")
    expect(wire.strokes[0].w).toBe(6)
    const back = fromServer(wire as any)
    expect(back.strokes[0].color).toBe("#ef4444")
    expect(back.strokes[0].w).toBe(6)
  })

  it("serializes path and arrow elements cleanly", () => {
    const p = {
      id: "p1",
      kind: "path" as const,
      author: "coach" as const,
      seq: 0,
      x: 10,
      y: 10,
      w: 100,
      h: 100,
      pathData: "M 0 0 L 50 50",
      color: "#3b82f6",
      strokeWidth: 4,
    }
    const a = {
      id: "a1",
      kind: "arrow" as const,
      author: "coach" as const,
      seq: 1,
      x: 0,
      y: 0,
      w: 100,
      h: 50,
      x2: 100,
      y2: 50,
      color: "#22c55e",
      strokeWidth: 4,
    }
    const b = board({ elements: [p, a], nextSeq: 2 })
    const wire = toWire(b)
    expect(wire.elements[0].path_data).toBe("M 0 0 L 50 50")
    expect(wire.elements[0].stroke_width).toBe(4)
    // When received over HTTP, api() camelizes wire keys:
    const received = {
      ...wire,
      elements: wire.elements.map((el: any) => ({
        ...el,
        pathData: el.path_data,
        strokeWidth: el.stroke_width,
      })),
      nextSeq: wire.next_seq,
    }
    const back = fromServer(received)
    expect(back.elements[0].pathData).toBe("M 0 0 L 50 50")
    expect(back.elements[0].strokeWidth).toBe(4)
    expect(back.elements[1].x2).toBe(100)
    expect(back.elements[1].y2).toBe(50)
  })
})


