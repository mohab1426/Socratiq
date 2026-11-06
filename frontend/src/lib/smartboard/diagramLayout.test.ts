// @vitest-environment jsdom
import { describe, expect, it } from "vitest"
import { boundaryPoint, edgeRoute, layoutDiagram, measure, validateLayout, wrapText, type LBox } from "./diagramLayout"
import { rectsIntersect } from "./geometry"
import { bigFlow, mustParse, SPECS, spec } from "@/test/boardFactory"

describe("text measurement", () => {
  it("wraps on words and breaks over-long words", () => {
    expect(wrapText("one two three four", 9)).toEqual(["one two", "three", "four"])
    expect(wrapText("abcdefghijkl", 5)).toEqual(["abcde", "fghij", "kl"])
    const m = measure("hello world again", 11, 12)
    expect(m.lines).toBe(2)
    expect(m.w).toBeGreaterThan(0)
  })
})

describe("layoutDiagram", () => {
  it.each(Object.keys(SPECS) as (keyof typeof SPECS)[])("%s: produces a valid, non-overlapping layout", (k) => {
    const layout = layoutDiagram(spec(k))
    expect(layout.width).toBeGreaterThan(50)
    expect(layout.height).toBeGreaterThan(50)
    const errors = validateLayout(layout).filter((i) => i.severity === "error")
    expect(errors, errors.map((e) => e.message).join("; ")).toEqual([])
  })
  it("is deterministic: the same spec always yields byte-identical layout", () => {
    for (const k of Object.keys(SPECS) as (keyof typeof SPECS)[]) expect(JSON.stringify(layoutDiagram(spec(k)))).toBe(JSON.stringify(layoutDiagram(spec(k))))
  })
  it("normalises to the origin", () => {
    const l = layoutDiagram(spec("flow"))
    const xs = l.items.filter((i) => i.t === "box" || i.t === "text").map((i: any) => i.x)
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(0)
  })
  it("flowchart: layers follow edge direction, orientation switches axes", () => {
    const tb = layoutDiagram(spec("flow"), "TB"), lr = layoutDiagram(spec("flow"), "LR")
    const y = (l: typeof tb, id: string) => (l.items.find((i) => i.t === "box" && i.id === id) as LBox).y
    const x = (l: typeof tb, id: string) => (l.items.find((i) => i.t === "box" && i.id === id) as LBox).x
    expect(y(tb, "s")).toBeLessThan(y(tb, "a"))
    expect(y(tb, "a")).toBeLessThan(y(tb, "d"))
    expect(y(tb, "d")).toBeLessThan(y(tb, "h"))
    expect(x(lr, "s")).toBeLessThan(x(lr, "a"))
    expect(validateLayout(lr).filter((i) => i.severity === "error")).toEqual([])
  })
  it("flowchart: shapes follow node kind (terminal=ellipse, decision=diamond)", () => {
    const boxes = layoutDiagram(spec("flow")).items.filter((i): i is LBox => i.t === "box")
    expect(boxes.find((b) => b.id === "s")!.shape).toBe("ellipse")
    expect(boxes.find((b) => b.id === "d")!.shape).toBe("diamond")
    expect(boxes.find((b) => b.id === "a")!.shape).toBe("rectangle")
  })
  it("flowchart: a feedback edge (e->a) is routed around, not through, other nodes", () => {
    const l = layoutDiagram(spec("flow"))
    const back = l.items.find((i) => i.t === "edge" && i.from === "e" && i.to === "a")!
    expect((back as any).waypoints.length).toBeGreaterThan(0)
    expect(validateLayout(l).filter((i) => i.code === "edge_crosses_node")).toEqual([])
  })
  it("flowchart: long edges get virtual-node waypoints and cross no node", () => {
    const s = mustParse({ version: 1, type: "flowchart", topic: "skip", nodes: ["a", "b", "c", "d"].map((i) => ({ id: i, label: "Node " + i })), edges: [{ from: "a", to: "b" }, { from: "b", to: "c" }, { from: "c", to: "d" }, { from: "a", to: "d", label: "shortcut" }] })
    const l = layoutDiagram(s)
    const long = l.items.find((i) => i.t === "edge" && i.from === "a" && i.to === "d") as any
    expect(long.waypoints.length).toBe(2)
    expect(validateLayout(l).filter((i) => i.severity === "error")).toEqual([])
  })
  it("a two-node cycle does not retrace the forward arrow", () => {
    const s = mustParse({ version: 1, type: "flowchart", topic: "loop", nodes: [{ id: "a", label: "A" }, { id: "b", label: "B" }], edges: [{ from: "a", to: "b" }, { from: "b", to: "a" }] })
    const l = layoutDiagram(s)
    expect((l.items.find((i) => i.t === "edge" && i.from === "b") as any).waypoints.length).toBe(1)
    expect(validateLayout(l).filter((i) => i.severity === "error")).toEqual([])
  })
  it("hierarchy: parents are centred over the extent of their children", () => {
    const l = layoutDiagram(spec("tree"))
    const b = (id: string) => l.items.find((i) => i.t === "box" && i.id === id) as LBox
    const extentMid = (ids: string[]) => (Math.min(...ids.map((i) => b(i).x)) + Math.max(...ids.map((i) => b(i).x + b(i).w))) / 2
    expect(Math.abs(b("b").x + b("b").w / 2 - extentMid(["d", "e"]))).toBeLessThan(2)
    expect(Math.abs(b("a").x + b("a").w / 2 - extentMid(["b", "c", "d", "e", "f"]))).toBeLessThan(l.width)
    expect(b("a").y).toBeLessThan(b("b").y)
    expect(b("b").y).toBeLessThan(b("d").y)
  })
  it("cycle: nodes sit on a ring and do not overlap", () => {
    const boxes = layoutDiagram(spec("cycle")).items.filter((i): i is LBox => i.t === "box")
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) expect(rectsIntersect(boxes[i], boxes[j], 6)).toBe(false)
  })
  it("concept map: the primary concept is at the centre", () => {
    const l = layoutDiagram(spec("map"))
    const boxes = l.items.filter((i): i is LBox => i.t === "box")
    const cx = boxes.reduce((a, b) => a + b.x + b.w / 2, 0) / boxes.length
    const c = boxes.find((b) => b.id === "p")!
    expect(Math.abs(c.x + c.w / 2 - cx)).toBeLessThan(l.width / 4)
  })
  it("comparison: columns have equal width and aligned tops", () => {
    const boxes = layoutDiagram(spec("cmp")).items.filter((i): i is LBox => i.t === "box" && i.role === "header")
    expect(boxes[0].w).toBe(boxes[1].w)
    expect(boxes[0].y).toBe(boxes[1].y)
  })
  it("illustration: every label has a leader and labels on one side never overlap", () => {
    const l = layoutDiagram(spec("fig"))
    const leaders = l.items.filter((i) => i.t === "shape" && i.role === "leader")
    expect(leaders.length).toBe(5)
    const texts = l.items.filter((i): i is any => i.t === "text" && i.role === "label")
    for (let i = 0; i < texts.length; i++) for (let j = i + 1; j < texts.length; j++) expect(rectsIntersect(texts[i], texts[j], 4)).toBe(false)
  })
  it("rejects absurdly large layouts rather than inserting them", () => {
    const l = layoutDiagram(bigFlow(24))
    expect(validateLayout(l, 400).some((i) => i.code === "too_large")).toBe(true)
  })
  it("detects overlap, text coverage and sub-readable text in a deliberately broken layout", () => {
    const l = layoutDiagram(spec("cmp"))
    const bs = l.items.filter((i): i is LBox => i.t === "box")
    bs[1].x = bs[0].x; bs[1].y = bs[0].y
    expect(validateLayout(l).some((i) => i.code === "boxes_overlap")).toBe(true)
    const t = layoutDiagram(spec("steps"))
    ;(t.items.find((i) => i.t === "box") as LBox).fontSize = 9
    expect(validateLayout(t).some((i) => i.code === "small_text")).toBe(true)
  })
})

describe("edge geometry", () => {
  it("boundary points lie on the shape outline for each shape kind", () => {
    const r = { x: 0, y: 0, w: 200, h: 100 }
    expect(boundaryPoint({ ...r, shape: "rectangle" }, [400, 50])).toEqual([200, 50])
    const d = boundaryPoint({ ...r, shape: "diamond" }, [400, 50])
    expect(Math.round(d[0])).toBe(200)
    const e = boundaryPoint({ ...r, shape: "ellipse" }, [100, 400])
    expect(Math.round(e[1])).toBe(100)
  })
  it("edgeRoute starts and ends on the connected boxes", () => {
    const l = layoutDiagram(spec("flow"))
    const boxes = new Map(l.items.filter((i): i is LBox => i.t === "box").map((b) => [b.id, b]))
    const e = l.items.find((i) => i.t === "edge" && i.from === "s") as any
    const route = edgeRoute(e, boxes)
    const a = boxes.get("a")!
    expect(route[route.length - 1][1]).toBeCloseTo(a.y, 0)
  })
})
