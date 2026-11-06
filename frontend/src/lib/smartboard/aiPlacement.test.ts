// @vitest-environment jsdom
/**
 * Intelligent-placement regression suite. Each scenario runs the FULL pipeline (spec -> layout -> board analysis -> placement ->
 * native elements -> validation) against boards built from real Excalidraw elements, and checks the same safety contract.
 */
import { describe, expect, it } from "vitest"
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types"
import { arrowEl, bigFlow, board, ellipseEl, freedraw, imageEl, loop, rectEl, spec, text } from "@/test/boardFactory"
import { elementBounds, rectGap, union } from "./geometry"
import { authorOf, opIdOf } from "./meta"
import { ObstacleIndex } from "./obstacles"
import { planAiInsertion, type PlanResult } from "./insertAi"
import type { DiagramSpec } from "./diagramSpec"
import type { Rect, SceneEl } from "./types"

const VP: Rect = { x: 0, y: 0, w: 1400, h: 800 }
let counter = 0
const run = (before: ExcalidrawElement[], s: DiagramSpec, o: { request?: string; viewport?: Rect | null; selectedIds?: string[]; opId?: string } = {}) =>
  planAiInsertion({ spec: s, request: o.request ?? "", elements: before, viewport: o.viewport === undefined ? VP : o.viewport, selectedIds: o.selectedIds, opId: o.opId ?? `op${++counter}`, now: 1_700_000_000_000 })

type Ok = Extract<PlanResult, { ok: true; duplicate: false }>

/** The safety contract that must hold for EVERY insertion. */
function assertSafe(before: ExcalidrawElement[], snapshot: string, plan: PlanResult): Ok {
  if (!plan.ok) throw new Error(`placement failed: ${plan.reason}: ${plan.message}\n${plan.diagnostics.join("\n")}`)
  if (plan.duplicate) throw new Error("unexpected duplicate")
  // Additive only, and the student's elements are the very same objects, in the same order, byte-for-byte unchanged.
  expect(plan.all.length).toBe(before.length + plan.added.length)
  before.forEach((e, i) => expect(plan.all[i]).toBe(e))
  expect(JSON.stringify(plan.all.slice(0, before.length))).toBe(snapshot)
  // One independent group, authored by the AI, tagged with the operation.
  expect(plan.added.length).toBeGreaterThan(2)
  for (const e of plan.added) {
    expect(e.groupIds).toEqual([plan.groupId])
    expect(authorOf(e as SceneEl)).toBe("ai")
    expect(opIdOf(e as SceneEl)).toBe(plan.opId)
  }
  expect(before.some((e) => e.groupIds.includes(plan.groupId))).toBe(false)
  // Not a single added element covers existing content.
  const idx = new ObstacleIndex(before as SceneEl[])
  const byId = new Map(plan.added.map((e) => [e.id, e as SceneEl]))
  for (const e of plan.added as SceneEl[]) {
    if (e.type === "text" && e.containerId && byId.has(e.containerId) && byId.get(e.containerId)!.type !== "arrow") continue
    const hits = idx.hits(elementBounds(e), 0)
    expect(hits.map((h) => h.id), `${e.type} ${e.id} covers existing content`).toEqual([])
  }
  // Arrow routes cross nothing that already exists.
  for (const e of plan.added as SceneEl[]) if (e.type === "arrow") expect(idx.pathHits(absolute(e), 2).map((h) => h.id), `arrow ${e.id}`).toEqual([])
  // Reported rect really bounds the group.
  const real = union(plan.added.map((e) => elementBounds(e as SceneEl)))!
  expect(Math.abs(real.x - plan.rect.x) + Math.abs(real.y - plan.rect.y)).toBeLessThan(1)
  return plan
}
const absolute = (e: SceneEl): [number, number][] => (e.points ?? [[0, 0], [e.width, e.height]]).map(([x, y]) => [e.x + x, e.y + y] as [number, number])
const snap = (b: ExcalidrawElement[]) => JSON.stringify(b)
const gapTo = (plan: Ok, rect: Rect) => rectGap(plan.rect, rect)

describe("placement scenarios", () => {
  it("1. empty board: lands in the middle of what the student is looking at, fully visible", () => {
    const plan = assertSafe([], snap([]), run([], spec("flow")))
    expect(plan.placement.strategy).toBe("empty-board")
    expect(plan.visible).toBe(true)
    const cx = plan.rect.x + plan.rect.w / 2, cy = plan.rect.y + plan.rect.h / 2
    expect(Math.abs(cx - 700)).toBeLessThan(60)
    expect(Math.abs(cy - 400)).toBeLessThan(60)
  })

  it("2. student paragraph: explanation goes next to the related paragraph, never over it", () => {
    const para = board(
      text("p1", 300, 200, "Photosynthesis is how plants make food using light", 24),
      text("p2", 300, 240, "I do not understand where the oxygen comes from", 24),
      text("p3", 300, 280, "Why do leaves need water and carbon dioxide?", 24),
      rectEl("far", 1100, 700, 120, 60),
    )
    const plan = assertSafe(para, snap(para), run(para, spec("map"), { request: "explain photosynthesis visually" }))
    expect(plan.anchor.anchor?.kind).toBe("semantic")
    expect(plan.anchor.anchor!.ids).toEqual(expect.arrayContaining(["p1", "p2", "p3"]))
    const paraRect = union(para.slice(0, 3).map((e) => elementBounds(e as SceneEl)))!
    expect(gapTo(plan, paraRect)).toBeLessThan(260)
  })

  it("3. several existing shapes", () => {
    const shapes = board(rectEl("r1", 200, 150, 220, 120), ellipseEl("e1", 520, 140, 180, 140), rectEl("r2", 800, 200, 200, 100), ellipseEl("e2", 300, 420, 160, 160), arrowEl("a1", 430, 210, 80, 0))
    assertSafe(shapes, snap(shapes), run(shapes, spec("tree")))
  })

  it("4. freehand drawings: open strokes are respected path-accurately, closed loops as filled", () => {
    const ink = board(
      freedraw("s1", 100, 100, [[0, 0], [300, 200], [600, 400], [900, 600]]),
      loop("c1", 900, 250, 120),
      freedraw("s2", 200, 650, [[0, 0], [100, 30], [250, 0], [400, 40]]),
    )
    const plan = assertSafe(ink, snap(ink), run(ink, spec("steps")))
    const idx = new ObstacleIndex(ink as SceneEl[])
    expect(idx.collides(plan.rect, 0)).toBe(false)
  })

  it("5. several existing AI groups: each new group is independent and none overlap", () => {
    let current: ExcalidrawElement[] = board(text("t", 500, 300, "My notes on cells", 24))
    const groups: Rect[] = []
    const ids = new Set<string>()
    for (const k of ["cmp", "cycle", "steps", "tree"] as const) {
      const before = current
      const plan = assertSafe(before, snap(before), run(before, spec(k), { request: `draw ${k}` }))
      expect(ids.has(plan.groupId)).toBe(false)
      ids.add(plan.groupId)
      groups.push(plan.rect)
      current = plan.all
    }
    for (let i = 0; i < groups.length; i++) for (let j = i + 1; j < groups.length; j++) expect(rectGap(groups[i], groups[j]), `groups ${i} and ${j}`).toBeGreaterThan(0)
    expect(ids.size).toBe(4)
  })

  it("6. images are protected like everything else", () => {
    const imgs = board(imageEl("i1", 150, 120, 400, 300), imageEl("i2", 700, 200, 300, 400), text("cap", 150, 440, "Figure 1: leaf cross-section", 20))
    assertSafe(imgs, snap(imgs), run(imgs, spec("fig")))
  })

  it("7. crowded viewport: nothing is forced into occupied space, the group goes to the nearest safe region outside it", () => {
    const grid = board(...Array.from({ length: 8 * 6 }, (_, i) => rectEl(`g${i}`, 20 + (i % 8) * 170, 20 + Math.floor(i / 8) * 125, 150, 105)))
    const plan = assertSafe(grid, snap(grid), run(grid, spec("flow")))
    expect(plan.visible).toBe(false)
    expect(["extend", "nearby"]).toContain(plan.placement.strategy)
    expect(plan.diagnostics.join()).toMatch(/rejected for collisions/)
  })

  it("8. related content boxed in on every side: still additive, nearest safe region", () => {
    const anchorText = text("q", 600, 380, "What is osmosis in plant roots?", 22)
    const walls = [rectEl("w1", 380, 250, 700, 50), rectEl("w2", 380, 520, 700, 50), rectEl("w3", 380, 250, 50, 320), rectEl("w4", 1030, 250, 50, 320)]
    const boxed = board(anchorText, walls.flat())
    const plan = assertSafe(boxed, snap(boxed), run(boxed, spec("cycle"), { request: "explain osmosis in plant roots" }))
    expect(plan.anchor.anchor?.ids).toContain("q")
    expect(plan.placement.strategy).not.toBe("empty-board")
    expect(gapTo(plan, elementBounds(boxed[0] as SceneEl))).toBeLessThan(900)
  })

  it("9. a very long text line is protected along its whole length", () => {
    const long = board(text("long", 100, 120, "This is a very long sentence the student typed without ever pressing enter and it keeps going ".repeat(8), 20), text("short", 100, 600, "short", 20))
    const plan = assertSafe(long, snap(long), run(long, spec("cmp")))
    expect(long[0].width).toBeGreaterThan(VP.w)
    expect(rectGap(plan.rect, elementBounds(long[0] as SceneEl))).toBeGreaterThan(0)
  })

  it("10. large diagrams: bigger than the viewport, still safe, student is guided to it (not visible)", () => {
    const some = board(text("n", 100, 100, "Notes", 24), rectEl("r", 300, 100, 200, 100))
    const plan = assertSafe(some, snap(some), run(some, bigFlow(20)))
    expect(plan.rect.h).toBeGreaterThan(VP.h)
    expect(plan.visible).toBe(false)
  })

  it.each([0.25, 0.5, 1, 2, 3])("11. zoom %s: the viewport region changes, safety does not", (zoom) => {
    const vp: Rect = { x: -300 / zoom + 400, y: -200 / zoom + 300, w: 1400 / zoom, h: 800 / zoom }
    const b = board(text("t", 400, 300, "Newton's laws of motion", 24), rectEl("r", 800, 300, 200, 100), loop("c", 500, 600, 90))
    const plan = assertSafe(b, snap(b), run(b, spec("steps"), { viewport: vp, request: "explain newton laws" }))
    if (zoom <= 1) expect(plan.visible).toBe(true)
  })

  it("12. content outside the viewport is protected too, and a far-away selection is a valid anchor", () => {
    const far = board(text("here", 100, 100, "visible note", 20), rectEl("off1", 1500, 100, 400, 300), rectEl("off2", 1500, 450, 400, 300), text("faraway", 6000, 4000, "Chapter 9 summary", 22), rectEl("below", 0, 900, 1400, 80))
    const plan = assertSafe(far, snap(far), run(far, spec("map")))
    expect(rectGap(plan.rect, elementBounds(far[2] as SceneEl))).toBeGreaterThan(0)
    const sel = assertSafe(far, snap(far), run(far, spec("steps"), { selectedIds: ["faraway"] }))
    expect(sel.anchor.anchor?.kind).toBe("selection")
    expect(gapTo(sel, elementBounds(far[3] as SceneEl))).toBeLessThan(400)
    expect(sel.visible).toBe(false)
  })
})

describe("placement behaviour", () => {
  it("a selected element is the strongest anchor: the group is placed adjacent to it", () => {
    const b = board(rectEl("sel", 500, 300, 240, 140), rectEl("x", 100, 100, 100, 100))
    const plan = assertSafe(b, snap(b), run(b, spec("steps"), { selectedIds: ["sel"] }))
    expect(plan.anchor.anchor?.confidence).toBe(1)
    expect(gapTo(plan, elementBounds(b[0] as SceneEl))).toBeLessThan(160)
  })
  it("an explicit 'new separate diagram' request is not tied to nearby content", () => {
    const b = board(text("t", 300, 300, "Photosynthesis notes", 24))
    const plan = assertSafe(b, snap(b), run(b, spec("map"), { request: "draw a new separate diagram of photosynthesis" }))
    expect(plan.anchor.intent).toBe("new")
  })
  it("Arabic content prefers the left (reading-order) side when below is blocked", () => {
    const b = board(text("ar", 800, 300, "اشرح عملية البناء الضوئي", 24), rectEl("floor", 200, 380, 1400, 60))
    const plan = assertSafe(b, snap(b), run(b, spec("steps"), { request: "اشرح البناء الضوئي" }))
    expect(plan.anchor.anchor?.rtl).toBe(true)
    expect(plan.rect.x + plan.rect.w / 2).toBeLessThan(800 + 150)
  })
  it("deleted elements do not block placement", () => {
    const b = board(rectEl("gone", 600, 300, 300, 200, { isDeleted: true } as never)).map((e) => ({ ...e, isDeleted: true }))
    const plan = assertSafe(b, snap(b), run(b, spec("steps")))
    expect(plan.placement.strategy).toBe("empty-board")
  })
  it("is deterministic: identical inputs give identical placements", () => {
    const b = board(text("t", 300, 300, "cells", 24), rectEl("r", 500, 300, 200, 100))
    const a = run(b, spec("map"), { opId: "same", request: "cells" }) as Ok
    const c = run(b, spec("map"), { opId: "same", request: "cells" }) as Ok
    expect([a.placement.x, a.placement.y, a.placement.strategy]).toEqual([c.placement.x, c.placement.y, c.placement.strategy])
    expect(JSON.stringify(a.added)).toBe(JSON.stringify(c.added))
  })
  it("works without any viewport information (headless / not yet measured)", () => {
    const b = board(rectEl("r", 0, 0, 300, 200))
    const plan = assertSafe(b, snap(b), run(b, spec("flow"), { viewport: null }))
    expect(plan.visible).toBe(false)
  })
})

describe("performance on realistic boards", () => {
  it.each([50, 500, 3000])("%i existing elements: full pipeline stays interactive", (n) => {
    const cols = Math.ceil(Math.sqrt(n * 1.6))
    const b = board(...Array.from({ length: n }, (_, i) => (i % 3 === 0 ? text(`t${i}`, (i % cols) * 260, Math.floor(i / cols) * 90, `Note ${i}`, 20) : rectEl(`r${i}`, (i % cols) * 260, Math.floor(i / cols) * 90, 200, 60))))
    const t0 = performance.now()
    const plan = run(b, spec("flow"), { viewport: { x: 0, y: 0, w: 1400, h: 800 } })
    const ms = performance.now() - t0
    console.log(`@@perf pipeline: ${n} elements -> ${ms.toFixed(0)}ms (${plan.ok && !plan.duplicate ? plan.placement.strategy : plan.ok ? "duplicate" : plan.reason})`)
    expect(plan.ok).toBe(true)
    expect(ms).toBeLessThan(n >= 3000 ? 4000 : 1500)
    if (plan.ok && !plan.duplicate) assertSafe(b, snap(b), plan)
  })
})
