// @vitest-environment jsdom
import "@/test/excalidrawEnv"
import { describe, expect, it } from "vitest"
import { absolutePoints, elementBounds, polylineIntersectsRect, rectGap, rectsIntersect, rotatedBoxBounds, segmentIntersectsRect, union } from "./geometry"
import { ObstacleIndex } from "./obstacles"
import type { SceneEl } from "./types"

const el = (p: Partial<SceneEl> & { id: string; type: string }): SceneEl => ({ x: 0, y: 0, width: 100, height: 50, ...p })

describe("rect helpers", () => {
  it("edges that merely touch do not intersect at margin 0, but do with clearance", () => {
    const a = { x: 0, y: 0, w: 100, h: 100 }, b = { x: 100, y: 0, w: 50, h: 50 }
    expect(rectsIntersect(a, b)).toBe(false)
    expect(rectsIntersect(a, b, 1)).toBe(true)
    expect(rectGap(a, { x: 130, y: 0, w: 10, h: 10 })).toBe(30)
  })
  it("union of nothing is null", () => expect(union([])).toBeNull())
  it("a rotated box has larger axis-aligned bounds", () => {
    const b = rotatedBoxBounds({ x: 0, y: 0, width: 100, height: 20, angle: Math.PI / 2 })
    expect(Math.round(b.w)).toBe(20)
    expect(Math.round(b.h)).toBe(100)
  })
  it("handles negative width/height", () => {
    expect(rotatedBoxBounds({ x: 100, y: 100, width: -40, height: -30 })).toEqual({ x: 60, y: 70, w: 40, h: 30 })
  })
})

describe("segments", () => {
  const r = { x: 10, y: 10, w: 20, h: 20 }
  it("detects a segment passing through, touching with padding, and missing", () => {
    expect(segmentIntersectsRect([0, 20], [50, 20], r)).toBe(true)
    expect(segmentIntersectsRect([0, 0], [5, 0], r)).toBe(false)
    expect(segmentIntersectsRect([0, 5], [50, 5], r, 6)).toBe(true)
    expect(segmentIntersectsRect([0, 5], [50, 5], r, 2)).toBe(false)
  })
  it("a diagonal that misses the box corner does not collide", () => {
    expect(segmentIntersectsRect([0, 70], [70, 0], r)).toBe(false)
    expect(polylineIntersectsRect([[0, 0], [100, 0], [100, 100]], r)).toBe(false)
  })
})

describe("elementBounds uses real geometry", () => {
  it("lines use their points, not width/height (which may be 0 or stale)", () => {
    const line = el({ id: "l", type: "line", x: 100, y: 100, width: 0, height: 0, points: [[0, 0], [200, -80]] })
    const b = elementBounds(line)
    expect(b.x).toBeLessThanOrEqual(100)
    expect(b.y).toBeLessThanOrEqual(20)
    expect(b.w).toBeGreaterThanOrEqual(200)
    expect(b.h).toBeGreaterThanOrEqual(80)
  })
  it("rotated linear elements rotate about their own centre", () => {
    const pts = absolutePoints(el({ id: "l", type: "line", x: 0, y: 0, points: [[0, 0], [100, 0]], angle: Math.PI / 2 }))
    expect(Math.round(pts[0][0])).toBe(50)
    expect(Math.round(pts[0][1])).toBe(-50)
  })
  it("text gets a readability allowance", () => {
    const b = elementBounds(el({ id: "t", type: "text", x: 10, y: 10, width: 80, height: 20 }))
    expect(b).toEqual({ x: 6, y: 6, w: 88, h: 28 })
  })
})

describe("ObstacleIndex", () => {
  it("skips deleted elements and bound labels inside shapes, keeps labels bound to arrows", () => {
    const box = el({ id: "box", type: "rectangle", x: 0, y: 0, width: 200, height: 100 })
    const label = el({ id: "lbl", type: "text", x: 50, y: 40, width: 60, height: 20, containerId: "box" })
    const arrow = el({ id: "ar", type: "arrow", x: 300, y: 0, width: 200, height: 0, points: [[0, 0], [200, 0]] })
    const arrowLabel = el({ id: "al", type: "text", x: 380, y: -10, width: 40, height: 20, containerId: "ar" })
    const gone = el({ id: "gone", type: "rectangle", x: 1000, y: 1000, isDeleted: true })
    const idx = new ObstacleIndex([box, label, arrow, arrowLabel, gone])
    expect(idx.obstacles.map((o) => o.id).sort()).toEqual(["al", "ar", "box"])
  })
  it("a long diagonal arrow does not wall off the canvas; its own path does collide", () => {
    const diag = el({ id: "d", type: "arrow", x: 0, y: 0, width: 2000, height: 2000, points: [[0, 0], [2000, 2000]] })
    const idx = new ObstacleIndex([diag])
    expect(idx.collides({ x: 1500, y: 200, w: 200, h: 100 })).toBe(false)
    expect(idx.collides({ x: 900, y: 900, w: 200, h: 200 })).toBe(true)
  })
  it("closed freehand loops are treated as filled; open strokes are path-accurate", () => {
    const circle = el({ id: "c", type: "freedraw", x: 200, y: 0, width: 200, height: 200, points: Array.from({ length: 25 }, (_, i) => [100 * (Math.cos((2 * Math.PI * i) / 24) - 1), 100 * Math.sin((2 * Math.PI * i) / 24)] as [number, number]) })
    const open = el({ id: "o", type: "freedraw", x: 1000, y: 0, width: 300, height: 300, points: [[0, 0], [150, 150], [300, 300]] })
    const idx = new ObstacleIndex([circle, open])
    expect(idx.obstacles.find((o) => o.id === "c")!.path).toBeUndefined()
    expect(idx.obstacles.find((o) => o.id === "o")!.path).toBeDefined()
    expect(idx.collides({ x: 1200, y: 20, w: 60, h: 40 })).toBe(false)
  })
  it("pathHits finds a route running through a box and ignores one that passes beside it", () => {
    const idx = new ObstacleIndex([el({ id: "b", type: "rectangle", x: 100, y: 100, width: 100, height: 100 })])
    expect(idx.pathHits([[0, 150], [400, 150]]).length).toBe(1)
    expect(idx.pathHits([[0, 20], [400, 20]]).length).toBe(0)
  })
  it("scales: 5000 elements index and query quickly", () => {
    const els = Array.from({ length: 5000 }, (_, i) => el({ id: "e" + i, type: "rectangle", x: (i % 100) * 150, y: Math.floor(i / 100) * 120, width: 100, height: 60 }))
    const t0 = performance.now()
    const idx = new ObstacleIndex(els)
    const built = performance.now() - t0
    const t1 = performance.now()
    for (let i = 0; i < 2000; i++) idx.collides({ x: (i * 37) % 15000, y: (i * 53) % 6000, w: 300, h: 200 }, 32)
    const queried = performance.now() - t1
    console.log(`@@perf index: build ${built.toFixed(1)}ms for 5000 elements, 2000 queries ${queried.toFixed(1)}ms`)
    expect(built).toBeLessThan(1500)
    expect(queried).toBeLessThan(1500)
  })
})
