// @vitest-environment jsdom
import { describe, expect, it } from "vitest"
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types"
import { aiGroup, arrowEl, board, rectEl, spec, text } from "@/test/boardFactory"
import { layoutDiagram } from "./diagramLayout"
import { assignIndices, planAiInsertion, validateInsertion } from "./insertAi"
import { elementBounds } from "./geometry"
import { authorOf, opIdOf, readMeta } from "./meta"
import { ObstacleIndex } from "./obstacles"
import { findPlacement, MAX_GROUP_SIDE } from "./placement"
import { layoutToNative } from "./toNative"
import type { SceneEl } from "./types"

const VP = { x: 0, y: 0, w: 1400, h: 800 }
const plan = (before: ExcalidrawElement[], k: Parameters<typeof spec>[0], opId: string) => {
  const r = planAiInsertion({ spec: spec(k), request: "", elements: before, viewport: VP, opId, now: 1_700_000_000_000 })
  if (!r.ok || r.duplicate) throw new Error(r.ok ? "duplicate" : r.message + r.diagnostics.join("\n"))
  return r
}
const types = (els: readonly ExcalidrawElement[]) => new Set<string>(els.map((e) => e.type))

describe("native element generation: same representation the student's tools produce", () => {
  it("a flowchart is made of diamonds, ellipses, rectangles, arrows and text, not just rectangles and lines", () => {
    const t = types(plan([], "flow", "f1").added)
    for (const k of ["rectangle", "ellipse", "diamond", "arrow", "text"]) expect(t.has(k), k).toBe(true)
  })
  it("an illustration mixes freehand strokes, shapes, arrows (leaders) and text labels", () => {
    const t = types(plan([], "fig", "i1").added)
    for (const k of ["freedraw", "ellipse", "rectangle", "arrow", "text"]) expect(t.has(k), k).toBe(true)
  })
  it("freehand parts are smoothed into many points, not left as 4 jagged segments", () => {
    const fd = plan([], "fig", "i2").added.find((e) => e.type === "freedraw") as any
    expect(fd.points.length).toBeGreaterThan(10)
    expect(fd.width).toBeGreaterThan(0)
  })
  it("every spec type produces elements with no random ids (stable, reproducible)", () => {
    for (const k of ["flow", "cycle", "tree", "map", "steps", "cmp", "fig"] as const) {
      const a = plan([], k, "same-" + k), b = plan([], k, "same-" + k)
      expect(JSON.stringify(a.added), k).toBe(JSON.stringify(b.added))
    }
  })
  it("arrows are bound to shapes of the same group, and shapes know about their arrows", () => {
    const added = plan([], "flow", "b1").added
    const ids = new Set(added.map((e) => e.id))
    const arrows = added.filter((e) => e.type === "arrow") as any[]
    const bound = arrows.filter((a) => a.startBinding && a.endBinding)
    expect(bound.length).toBe(6)
    for (const a of bound) {
      expect(ids.has(a.startBinding.elementId)).toBe(true)
      expect(ids.has(a.endBinding.elementId)).toBe(true)
      const target = added.find((e) => e.id === a.endBinding.elementId)!
      expect(target.boundElements?.some((b) => b.id === a.id)).toBe(true)
    }
  })
  it("labels are real bound text: they carry the group and authorship, so the group selects/moves/deletes as one", () => {
    const r = plan([], "flow", "l1")
    const labels = r.added.filter((e) => e.type === "text" && (e as any).containerId)
    expect(labels.length).toBeGreaterThanOrEqual(8)
    for (const l of labels) {
      expect(l.groupIds).toEqual([r.groupId])
      expect(readMeta(l)?.author).toBe("ai")
      expect(r.added.some((c) => c.id === (l as any).containerId)).toBe(true)
    }
  })
  it("bound labels fit inside their shapes (no overflow)", () => {
    const r = plan([], "flow", "fit")
    expect(validateInsertion(new ObstacleIndex([]), r.added)).toEqual([])
  })
  it("bidirectional links: container.boundElements references labels that exist", () => {
    const r = plan([], "cmp", "bl")
    const ids = new Set(r.added.map((e) => e.id))
    for (const e of r.added) for (const b of e.boundElements ?? []) expect(ids.has(b.id), `${e.id} -> ${b.id}`).toBe(true)
  })
  it("elements use the hand-drawn style (roughness 1), solid fills and the readable font sizes", () => {
    const els = plan([], "map", "style").added
    expect(els.every((e) => e.roughness === 1)).toBe(true)
    expect(els.filter((e) => e.type === "text").every((e) => (e as any).fontSize >= 14)).toBe(true)
  })
  it("indices are valid, unique, and sort after every existing element", () => {
    const before = board(rectEl("a", 0, 0, 10, 10), rectEl("b", 50, 0, 10, 10))
    const r = plan(before, "steps", "ix")
    const idx = r.added.map((e) => e.index as string)
    expect(new Set(idx).size).toBe(idx.length)
    expect([...idx].sort()).toEqual(idx)
    expect(idx[0] > (before[1].index as string)).toBe(true)
  })
  it("assignIndices works when the scene has no indices yet", () => {
    const out = assignIndices([], [{ id: "x" } as ExcalidrawElement, { id: "y" } as ExcalidrawElement])
    expect(out[0].index! < out[1].index!).toBe(true)
  })
})

describe("independent AI group", () => {
  it("every operation gets its own unique group; student groups are never touched or joined", () => {
    const studentGroup = board(rectEl("s1", 100, 100, 100, 60), rectEl("s2", 220, 100, 100, 60)).map((e) => ({ ...e, groupIds: ["student-g"] }))
    const r1 = plan(studentGroup, "cycle", "op-a")
    const r2 = plan(r1.all, "steps", "op-b")
    expect(r1.groupId).not.toBe(r2.groupId)
    expect(r1.groupId).toBe("ai-group-op-a")
    expect(r2.all.filter((e) => e.groupIds.includes("student-g")).map((e) => e.id)).toEqual(["s1", "s2"])
    expect(r2.all.filter((e) => e.groupIds.includes(r1.groupId)).length).toBe(r1.added.length)
    expect(r2.all.filter((e) => e.groupIds.includes(r2.groupId)).length).toBe(r2.added.length)
  })
  it("ungrouping/editing one element keeps it a normal, authored element (metadata lives on each element)", () => {
    const r = plan([], "steps", "edit")
    const one = r.added.find((e) => e.type === "rectangle")!
    expect(opIdOf(one as SceneEl)).toBe("edit")
    expect(authorOf({ customData: { other: 1 } })).toBe("student")
  })
  it("student elements are authored 'student' (default) and AI elements are distinguishable", () => {
    const before = board(text("s", 10, 10, "mine"))
    const r = plan(before, "steps", "auth")
    expect(authorOf(r.all[0] as SceneEl)).toBe("student")
    expect(r.added.every((e) => authorOf(e as SceneEl) === "ai")).toBe(true)
  })
})

describe("atomic, undoable, idempotent insertion", () => {
  it("is one atomic result: before-state + a single contiguous AI block (what one undo removes)", () => {
    const before = board(text("s", 10, 10, "mine"), rectEl("r", 300, 10, 100, 60))
    const r = plan(before, "flow", "atom")
    expect(r.all.slice(0, before.length)).toEqual(before)
    expect(r.all.slice(before.length)).toEqual(r.added)
    // Undoing the operation == removing exactly the elements of its group: the board is back to the original, element for element.
    const undone = r.all.filter((e) => !e.groupIds.includes(r.groupId))
    expect(undone).toEqual(before)
  })
  it("a retry with the same operation id adds nothing (no duplicate AI groups)", () => {
    const first = plan([], "cycle", "retry-1")
    const again = planAiInsertion({ spec: spec("cycle"), request: "", elements: first.all, viewport: VP, opId: "retry-1" })
    expect(again.ok && again.duplicate).toBe(true)
    if (again.ok) { expect(again.all.length).toBe(first.all.length); expect(again.added).toEqual([]) }
  })
  it("a different operation id with the same spec is a new, separate group", () => {
    const first = plan([], "cycle", "r-a")
    const second = plan(first.all, "cycle", "r-b")
    expect(second.all.length).toBe(first.all.length + second.added.length)
    expect(second.rect.x).not.toBe(first.rect.x)
  })
  it("never mutates its input array or elements", () => {
    const before = board(text("s", 10, 10, "mine"))
    const snap = JSON.stringify(before)
    Object.freeze(before); before.forEach((e) => Object.freeze(e))
    plan(before, "flow", "frozen")
    expect(JSON.stringify(before)).toBe(snap)
  })
})

describe("rejection paths: never force content in, never retry forever", () => {
  it("rejects a semantically incoherent spec and returns the board untouched", () => {
    const bad = spec("flow")
    const broken = { ...bad, edges: bad.edges!.filter((e) => !(e.from === "d" && e.to === "e")) }
    const before = board(text("s", 10, 10, "mine"))
    const r = planAiInsertion({ spec: broken, request: "", elements: before, viewport: VP, opId: "bad" })
    expect(r.ok).toBe(false)
    if (!r.ok) { expect(r.reason).toBe("semantic_invalid"); expect(r.message).toMatch(/decision/) }
  })
  it("findPlacement refuses an unusably large group with a diagnostic", () => {
    const r = findPlacement(new ObstacleIndex([]), { size: { w: MAX_GROUP_SIDE + 1, h: 100 } })
    expect(r.ok).toBe(false)
    if (!r.ok) { expect(r.reason).toBe("group_too_large"); expect(r.diagnostics.join()).toMatch(/exceeds/) }
  })
  it("findPlacement refuses invalid sizes", () => {
    expect(findPlacement(new ObstacleIndex([]), { size: { w: 0, h: 10 } }).ok).toBe(false)
    expect(findPlacement(new ObstacleIndex([]), { size: { w: NaN, h: 10 } }).ok).toBe(false)
  })
  it("post-generation validation failure is bounded: it gives up after a fixed number of tries with a diagnostic", () => {
    let calls = 0
    const r = findPlacement(new ObstacleIndex([]), { size: { w: 200, h: 100 }, viewport: VP, maxValidations: 5, validate: () => { calls++; return "always bad" } })
    expect(r.ok).toBe(false)
    expect(calls).toBe(5)
    if (!r.ok) { expect(r.reason).toBe("validation_failed"); expect(r.diagnostics.join()).toMatch(/gave up after 5/) }
  })
  it("a validator that rejects the first candidates makes placement fall through to a later safe one", () => {
    let n = 0
    const r = findPlacement(new ObstacleIndex([]), { size: { w: 200, h: 100 }, viewport: VP, validate: () => (n++ < 2 ? "no" : null) })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.diagnostics.join()).toMatch(/rejected: no/)
  })
})

describe("validateInsertion: authoritative checks on the real elements", () => {
  const layout = layoutDiagram(spec("steps"))
  const make = (x: number, y: number) => layoutToNative(layout, { offset: { x, y }, opId: "v", groupId: "ai-group-v", now: 1 }).elements
  it("passes on a free area", () => expect(validateInsertion(new ObstacleIndex([]), make(0, 0))).toEqual([]))
  it("detects text coverage", () => {
    const idx = new ObstacleIndex(board(text("student", 20, 20, "My question about the topic", 24)) as SceneEl[])
    expect(validateInsertion(idx, make(0, 0)).join()).toMatch(/covers existing text student \(student\)/)
  })
  it("detects shape and image intersections", () => {
    const idx = new ObstacleIndex(board(rectEl("blocker", 50, 50, 200, 200)) as SceneEl[])
    expect(validateInsertion(idx, make(0, 0)).join()).toMatch(/covers existing rectangle blocker/)
  })
  it("detects an arrow crossing existing content", () => {
    const idx = new ObstacleIndex(board(rectEl("mid", 60, 100, 40, 400)) as SceneEl[])
    expect(validateInsertion(idx, make(0, 0)).length).toBeGreaterThan(0)
  })
  it("detects an arrow bound to an EXISTING element (that would modify the student's element)", () => {
    const els = make(0, 0).map((e) => (e.type === "arrow" ? ({ ...e, endBinding: { elementId: "student-box", focus: 0, gap: 1 } } as any) : e))
    expect(validateInsertion(new ObstacleIndex([]), els).join()).toMatch(/bound to existing element student-box/)
  })
  it("detects unreadable text and overlapping shapes inside the group", () => {
    const small = make(0, 0).map((e) => (e.type === "text" ? ({ ...e, fontSize: 9 } as any) : e))
    expect(validateInsertion(new ObstacleIndex([]), small).join()).toMatch(/readable minimum/)
    const squashed = make(0, 0).map((e) => (e.type === "rectangle" ? ({ ...e, x: 0, y: 0 } as any) : e))
    expect(validateInsertion(new ObstacleIndex([]), squashed).join()).toMatch(/overlap inside the group/)
  })
  it("detects geometry outside the usable canvas", () => {
    expect(validateInsertion(new ObstacleIndex([]), make(1e7, 0)).join()).toMatch(/outside the usable canvas/)
  })
})

describe("group bounds", () => {
  it("elementBounds of the inserted group matches the reported rect", () => {
    const r = plan([], "map", "bounds")
    const xs = r.added.map((e) => elementBounds(e as SceneEl))
    expect(Math.min(...xs.map((b) => b.x))).toBeCloseTo(r.rect.x, 0)
  })
  it("arrow helper factory is a real arrow (sanity for factories)", () => expect(arrowEl("a", 0, 0, 10, 10)[0].type).toBe("arrow"))
  it("aiGroup helper marks elements as AI", () => expect(authorOf(aiGroup("x", board(rectEl("q", 0, 0, 5, 5)))[0] as SceneEl)).toBe("ai"))
})
