import { describe, expect, it } from "vitest"
import {
  arrowElementGeometry,
  connectorEndpoints,
  finiteNumber,
  getPathBounds,
  isMeaningfulBox,
  lineElementGeometry,
  parsePathData,
  readSegment,
  resolvePathIntent,
  segmentBox,
  translatePathCommands,
  translateSegment,
  translationIntoBoard,
} from "./aiGeometry"
import { arrowEndpoints, type BoardElement } from "./whiteboard"

describe("finiteNumber", () => {
  it("accepts finite numbers and numeric strings, rejects everything else", () => {
    expect(finiteNumber(5)).toBe(5)
    expect(finiteNumber("12.5")).toBe(12.5)
    expect(finiteNumber(NaN)).toBeUndefined()
    expect(finiteNumber(Infinity)).toBeUndefined()
    expect(finiteNumber("abc")).toBeUndefined()
    expect(finiteNumber("")).toBeUndefined()
    expect(finiteNumber(null)).toBeUndefined()
    expect(finiteNumber(undefined)).toBeUndefined()
  })
})

describe("readSegment", () => {
  it("reads four finite endpoints", () => {
    expect(readSegment({ x1: 10, y1: 20, x2: "30", y2: 40 })).toEqual({ x1: 10, y1: 20, x2: 30, y2: 40 })
  })
  it("returns null for missing, non-finite or zero-length input", () => {
    expect(readSegment({ x1: 10, y1: 20, x2: 30 })).toBeNull()
    expect(readSegment({ x1: NaN, y1: 20, x2: 30, y2: 40 })).toBeNull()
    expect(readSegment({ x1: 5, y1: 5, x2: 5, y2: 5 })).toBeNull()
  })
})

describe("line / arrow geometry keeps direction and length", () => {
  const seg = { x1: 800, y1: 300, x2: 500, y2: 250 } // points left and slightly up
  it("translateSegment moves both endpoints by the same amount", () => {
    const t = translateSegment(seg, 40, -20)
    expect(t).toEqual({ x1: 840, y1: 280, x2: 540, y2: 230 })
    expect(Math.hypot(t.x2 - t.x1, t.y2 - t.y1)).toBeCloseTo(Math.hypot(seg.x2 - seg.x1, seg.y2 - seg.y1), 10)
  })
  it("a line is stored start + absolute extents + end point", () => {
    expect(lineElementGeometry(seg)).toEqual({ x: 800, y: 300, w: 300, h: 50, x2: 500, y2: 250 })
  })
  it("a free arrow is stored with SIGNED extents so the renderer's (x,y)->(x+w,y+h) keeps its direction", () => {
    const g = arrowElementGeometry(seg)
    expect(g).toEqual({ x: 800, y: 300, w: -300, h: -50 })
    const el = { id: "a", kind: "arrow", author: "coach", seq: 0, ...g } as BoardElement
    expect(arrowEndpoints(el, new Map())).toEqual([[800, 300], [500, 250]])
  })
  it("connectorEndpoints reads lines via x2/y2 and arrows via x+w / y+h (a stale x2 on an arrow is ignored)", () => {
    expect(connectorEndpoints({ kind: "line", x: 10, y: 10, w: 90, h: 0, x2: 100, y2: 10 })).toEqual({ x1: 10, y1: 10, x2: 100, y2: 10 })
    expect(connectorEndpoints({ kind: "arrow", x: 100, y: 100, w: -50, h: 20, x2: 999, y2: 999 })).toEqual({ x1: 100, y1: 100, x2: 50, y2: 120 })
  })
  it("segmentBox is the axis-aligned bounds regardless of direction", () => {
    expect(segmentBox(seg)).toEqual({ x: 500, y: 250, w: 300, h: 50 })
  })
})

describe("translationIntoBoard", () => {
  it("is zero for a box that already fits", () => {
    expect(translationIntoBoard({ x: 100, y: 100, w: 50, h: 50 })).toEqual({ dx: 0, dy: 0 })
  })
  it("moves a box that hangs over an edge back inside, by the smallest amount", () => {
    expect(translationIntoBoard({ x: -30, y: 1190, w: 100, h: 50 })).toEqual({ dx: 30, dy: -40 })
  })
  it("centres a box larger than the board rather than scaling it", () => {
    const { dx } = translationIntoBoard({ x: -100, y: 0, w: 2400, h: 100 })
    expect(-100 + dx + 2400 / 2).toBe(1000) // centred on the 2000-wide board
    expect(dx).toBe(-100)
  })
})

describe("isMeaningfulBox", () => {
  it("rejects the top-left origin, out-of-board and non-finite boxes", () => {
    expect(isMeaningfulBox({ x: 0, y: 0, w: 100, h: 100 })).toBe(false)
    expect(isMeaningfulBox({ x: 10, y: 10, w: 100, h: 100 })).toBe(false)
    expect(isMeaningfulBox({ x: 1950, y: 100, w: 100, h: 50 })).toBe(false)
    expect(isMeaningfulBox({ x: NaN, y: 100, w: 10, h: 10 })).toBe(false)
  })
  it("accepts a box placed inside the board", () => {
    expect(isMeaningfulBox({ x: 400, y: 300, w: 120, h: 60 })).toBe(true)
    expect(isMeaningfulBox({ x: 0, y: 400, w: 120, h: 60 })).toBe(true)
  })
})

describe("path parsing", () => {
  it("parses absolute and relative commands and expands implicit repeats", () => {
    const c = parsePathData("M 10 10 20 20 l 5 5 H 50 V 60 Z")!
    expect(c.map((x) => x.cmd)).toEqual(["M", "L", "l", "H", "V", "Z"])
  })
  it("returns null for junk, empty input, missing leading move and wrong argument counts", () => {
    expect(parsePathData("")).toBeNull()
    expect(parsePathData("hello")).toBeNull()
    expect(parsePathData("L 10 10")).toBeNull()
    expect(parsePathData("M 10")).toBeNull()
    expect(parsePathData("M 10 10 L 20")).toBeNull()
    expect(parsePathData("M 10 10 # L 20 20")).toBeNull()
    expect(parsePathData(undefined)).toBeNull()
  })
  it("computes bounds including relative commands and curves", () => {
    const b = getPathBounds(parsePathData("M 10 20 l 30 0 l 0 40 C 60 100 80 100 90 60")!)!
    expect(b).toEqual({ x: 10, y: 20, w: 80, h: 80 })
  })
  it("the first moveto is absolute even when written lowercase", () => {
    expect(getPathBounds(parsePathData("m 10 10 l 20 20")!)).toEqual({ x: 10, y: 10, w: 20, h: 20 })
  })
})

describe("translatePathCommands moves the WHOLE path (not only the first point)", () => {
  it("shifts every absolute coordinate and leaves relative offsets alone", () => {
    const out = translatePathCommands(parsePathData("M 10 10 L 50 10 l 0 30 H 20 V 5 Q 30 30 40 40 Z")!, 100, 200)
    expect(out).toBe("M 110 210 L 150 210 l 0 30 H 120 V 205 Q 130 230 140 240 Z")
  })
  it("round-trips: translate then translate back gives the original geometry", () => {
    const orig = "M 3 4 C 10 20 30 40 50 60 S 70 80 90 100 A 5 5 0 0 1 120 130"
    const there = translatePathCommands(parsePathData(orig)!, 37, -11)
    const back = translatePathCommands(parsePathData(there)!, -37, 11)
    expect(back).toBe(orig)
  })
  it("translated bounds equal original bounds shifted by the same amount", () => {
    const cmds = parsePathData("M 0 0 L 100 40 L 200 0 L 100 -40")!
    const b0 = getPathBounds(cmds)!
    const b1 = getPathBounds(parsePathData(translatePathCommands(cmds, 55, 66))!)!
    expect(b1).toEqual({ x: b0.x + 55, y: b0.y + 66, w: b0.w, h: b0.h })
  })
})

describe("resolvePathIntent", () => {
  it("re-bases the path to local (0,0) and reports the drawn region in board coordinates", () => {
    const r = resolvePathIntent({ pathData: "M 50 20 L 150 70 L 250 20", x: 200, y: 100 })!
    expect(r.parsed).toBe(true)
    expect(r.pathData).toBe("M 0 0 L 100 50 L 200 0")
    expect(r.box).toEqual({ x: 250, y: 120, w: 200, h: 50 })
    expect(r.anchored).toBe(true)
  })
  it("a path drawn in local coordinates with no x/y is parked at the origin, so it is NOT anchored", () => {
    const r = resolvePathIntent({ pathData: "M 0 0 L 100 50" })!
    expect(r.box.x).toBe(0)
    expect(r.anchored).toBe(false)
  })
  it("keeps an unparseable path untouched and trusts the declared size", () => {
    const r = resolvePathIntent({ pathData: "M 1 2 a1 1 0 01.5.5", x: 400, y: 300, width: 80, height: 40 })!
    expect(r.parsed).toBe(false)
    expect(r.pathData).toBe("M 1 2 a1 1 0 01.5.5")
    expect(r.box).toEqual({ x: 400, y: 300, w: 80, h: 40 })
  })
  it("returns null when there is no pathData to draw", () => {
    expect(resolvePathIntent({})).toBeNull()
    expect(resolvePathIntent({ pathData: "   " })).toBeNull()
    expect(resolvePathIntent({ pathData: 42 })).toBeNull()
  })
})
