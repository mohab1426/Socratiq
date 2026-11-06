// @vitest-environment jsdom
import { describe, expect, it } from "vitest"
import { BOARD_H, BOARD_W } from "@/lib/whiteboard"
import {
  FULL_BOARD_BOX, MAX_FIT_SCALE_CONTENT, MAX_FIT_SCALE_EMPTY, MIN_SCALE,
  computeFitView, contentFitBox, isUsableSize, measureOcclusion,
} from "@/lib/boardViewport"

const screenOf = (v: { x: number; y: number; scale: number }, bx: number, by: number) => [(bx - v.x) * v.scale, (by - v.y) * v.scale]

describe("logical board invariant", () => {
  it("stays 2000 x 1200", () => { expect([BOARD_W, BOARD_H]).toEqual([2000, 1200]) })
})

describe("isUsableSize", () => {
  it("rejects zero, tiny, NaN and missing sizes", () => {
    for (const [w, h] of [[0, 0], [320, 0], [0, 700], [1, 1], [NaN, 500], [undefined, 500]] as const) expect(isUsableSize(w as any, h as any)).toBe(false)
    expect(isUsableSize(320, 720)).toBe(true)
  })
})

describe("computeFitView", () => {
  it("returns null for a hidden / zero-sized container", () => {
    expect(computeFitView({ width: 0, height: 0 }, FULL_BOARD_BOX)).toBeNull()
  })
  it("fits the whole board and centres it in the container", () => {
    const c = { width: 1366, height: 723 }
    const v = computeFitView(c, FULL_BOARD_BOX)!
    expect(v.scale).toBeCloseTo(Math.min((1366 - 24) / 2000, (723 - 24) / 1200), 5)
    const [sx, sy] = screenOf(v, 1000, 600)
    expect(sx).toBeCloseTo(c.width / 2, 3)
    expect(sy).toBeCloseTo(c.height / 2, 3)
  })
  it("centres in the unobstructed band when UI covers the top and bottom", () => {
    const c = { width: 390, height: 803 }
    const v = computeFitView(c, FULL_BOARD_BOX, { top: 95, bottom: 108, left: 0, right: 0 })!
    const [, sy] = screenOf(v, 1000, 600)
    expect(sy).toBeCloseTo(95 + (803 - 95 - 108) / 2, 3)
  })
  it("keeps the whole board inside the container on a 320px phone", () => {
    const v = computeFitView({ width: 320, height: 679 }, FULL_BOARD_BOX)!
    expect(v.scale).toBeGreaterThanOrEqual(MIN_SCALE)
    expect(BOARD_W * v.scale).toBeLessThanOrEqual(320)
  })
  it("never lets absurd occlusion produce a non-positive scale", () => {
    const v = computeFitView({ width: 300, height: 300 }, FULL_BOARD_BOX, { top: 9999, bottom: 9999, left: 9999, right: 9999 })!
    expect(v.scale).toBeGreaterThanOrEqual(MIN_SCALE)
    expect(Number.isFinite(v.x) && Number.isFinite(v.y)).toBe(true)
  })
  it("caps the scale (1.0 empty, 1.2 content) on huge containers", () => {
    const big = { width: 8000, height: 6000 }
    expect(computeFitView(big, FULL_BOARD_BOX)!.scale).toBe(MAX_FIT_SCALE_EMPTY)
    expect(computeFitView(big, contentFitBox([{ x: 0, y: 0, w: 100, h: 100 }]), undefined, { maxScale: MAX_FIT_SCALE_CONTENT })!.scale).toBe(MAX_FIT_SCALE_CONTENT)
  })
})

describe("contentFitBox", () => {
  it("is the whole board when empty", () => { expect(contentFitBox([])).toEqual(FULL_BOARD_BOX) })
  it("pads and centres on the content, with a minimum span", () => {
    const b = contentFitBox([{ x: 100, y: 100, w: 600, h: 400 }])
    expect(b.w).toBe(760); expect(b.h).toBe(560)
    expect(b.x + b.w / 2).toBe(400); expect(b.y + b.h / 2).toBe(300)
    expect(contentFitBox([{ x: 0, y: 0, w: 10, h: 10 }]).w).toBe(300)
  })
})

describe("measureOcclusion", () => {
  const rect = (l: number, t: number, w: number, h: number) => ({ left: l, top: t, width: w, height: h, right: l + w, bottom: t + h, x: l, y: t, toJSON() {} }) as DOMRect
  const mk = (r: DOMRect, kids: Array<[string, DOMRect]>) => {
    const area = document.createElement("div"); area.getBoundingClientRect = () => r
    for (const [n, kr] of kids) { const k = document.createElement("div"); k.setAttribute("data-board-occluder", n); k.getBoundingClientRect = () => kr; area.appendChild(k) }
    return area
  }
  it("measures top and bottom intrusion from real rects", () => {
    const a = mk(rect(0, 41, 390, 800), [["toolbar", rect(8, 49, 300, 46)], ["chat", rect(8, 41 + 800 - 60, 374, 52)]])
    expect(measureOcclusion(a)).toEqual({ top: 54, bottom: 60, left: 0, right: 0 })
  })
  it("returns null with no measurable occluders, a null or zero-size area", () => {
    expect(measureOcclusion(null)).toBeNull()
    expect(measureOcclusion(mk(rect(0, 0, 0, 0), [["t", rect(0, 0, 10, 10)]]))).toBeNull()
    expect(measureOcclusion(mk(rect(0, 0, 400, 400), []))).toBeNull()
  })
  it("ignores zero-size and out-of-area occluders", () => {
    const a = mk(rect(0, 0, 400, 400), [["z", rect(0, 0, 0, 0)], ["out", rect(0, 900, 100, 50)]])
    expect(measureOcclusion(a)).toBeNull()
  })
})
