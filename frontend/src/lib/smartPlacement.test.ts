import { describe, expect, it } from "vitest"
import { boxesIntersect, getSmartPlacement } from "./smartPlacement"
import { EMPTY_BOARD, type Board, type BoardElement } from "./whiteboard"

describe("smartPlacement", () => {
  it("detects intersecting boxes with buffer", () => {
    const a = { x: 100, y: 100, w: 200, h: 100 }
    const b = { x: 250, y: 150, w: 100, h: 100 }
    expect(boxesIntersect(a, b)).toBe(true)

    const far = { x: 500, y: 500, w: 100, h: 100 }
    expect(boxesIntersect(a, far)).toBe(false)
  })

  it("places new content to the right of selected element if space is available", () => {
    const selected: BoardElement = {
      id: "sel1",
      kind: "text",
      author: "student",
      seq: 0,
      x: 100,
      y: 100,
      w: 200,
      h: 80,
      text: "student work",
    }
    const board: Board = { ...EMPTY_BOARD, elements: [selected] }
    const viewState = { x: 0, y: 0, scale: 1 }

    const pos = getSmartPlacement(board, viewState, 300, 150, "sel1")
    expect(pos.x).toBe(100 + 200 + 24) // 324
    expect(pos.y).toBe(100)
  })

  it("places new content below selected element if right side is occupied", () => {
    const selected: BoardElement = {
      id: "sel1",
      kind: "text",
      author: "student",
      seq: 0,
      x: 100,
      y: 100,
      w: 200,
      h: 80,
    }
    const blockerRight: BoardElement = {
      id: "block1",
      kind: "shape",
      author: "coach",
      seq: 1,
      x: 320,
      y: 100,
      w: 300,
      h: 200,
    }
    const board: Board = { ...EMPTY_BOARD, elements: [selected, blockerRight] }
    const viewState = { x: 0, y: 0, scale: 1 }

    const pos = getSmartPlacement(board, viewState, 200, 100, "sel1")
    expect(pos.x).toBe(100)
    expect(pos.y).toBe(100 + 80 + 24) // 204
  })

  it("scans visible viewport and avoids collisions when no element is selected", () => {
    const existing: BoardElement = {
      id: "e1",
      kind: "text",
      author: "student",
      seq: 0,
      x: 40,
      y: 40,
      w: 300,
      h: 150,
    }
    const board: Board = { ...EMPTY_BOARD, elements: [existing] }
    const viewState = { x: 0, y: 0, scale: 1 }

    const pos = getSmartPlacement(board, viewState, 200, 100, null)
    expect(boxesIntersect({ x: pos.x, y: pos.y, w: 200, h: 100 }, existing)).toBe(false)
  })

  it("places multiple successive items in a turn without collision", () => {
    let board: Board = { ...EMPTY_BOARD }
    const viewState = { x: 0, y: 0, scale: 1 }

    const placed: BoardElement[] = []
    for (let i = 0; i < 3; i++) {
      const pos = getSmartPlacement({ ...board, elements: [...board.elements, ...placed] }, viewState, 250, 100)
      const el: BoardElement = {
        id: `turn-el-${i}`,
        kind: "text",
        author: "coach",
        seq: i,
        x: pos.x,
        y: pos.y,
        w: 250,
        h: 100,
      }
      // Ensure this new element does not collide with any previous placed elements
      for (const prev of placed) {
        expect(boxesIntersect(el, prev)).toBe(false)
      }
      placed.push(el)
    }
    expect(placed).toHaveLength(3)
  })
})

