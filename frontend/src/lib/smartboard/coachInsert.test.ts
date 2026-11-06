// @vitest-environment jsdom
import { describe, expect, it } from "vitest"
import { board, rectEl, text } from "@/test/boardFactory"
import { elementBounds, union } from "./geometry"
import { planCoachInsertion } from "./coachInsert"
import { authorOf } from "./meta"
import { ObstacleIndex } from "./obstacles"
import type { BoardElement } from "../whiteboard"
import type { SceneEl } from "./types"

const coach = (id: string, x: number, y: number, extra: Partial<BoardElement> = {}): BoardElement => ({ id, kind: "text", text: "Think about why the sample is heated.", author: "coach", seq: 1, x, y, w: 300, h: 60, ...extra })
const VP = { x: 0, y: 0, w: 1400, h: 800 }

describe("Coach elements on the infinite canvas", () => {
  it("are relocated off the student's content, keep their legacy id and coach authorship, and arrive as one group", () => {
    const existing = board(text("mine", 100, 100, "My own working on the experiment", 24), rectEl("box", 90, 90, 600, 120))     // the legacy coordinates (100,100) would land right on this
    const snap = JSON.stringify(existing)
    const p = planCoachInsertion({ existing, coach: [coach("c1", 100, 100)], viewport: VP, opId: "t1", now: 1 })
    if (!p.ok) throw new Error(p.reason + p.diagnostics.join())
    expect(JSON.stringify(p.all.slice(0, existing.length))).toBe(snap)
    existing.forEach((e, i) => expect(p.all[i]).toBe(e))
    expect(p.added.every((e) => e.groupIds[0] === p.groupId && authorOf(e as SceneEl) === "coach")).toBe(true)
    expect((p.added[0].customData as any).socratiq.legacyId).toBe("c1")
    const idx = new ObstacleIndex(existing as SceneEl[])
    expect(idx.collides(union(p.added.map((e) => elementBounds(e as SceneEl)))!, 0)).toBe(false)
  })
  it("keeps the relative geometry of several Coach elements (arrow stays linked to its shapes)", () => {
    const els = [coach("a", 500, 300), coach("b", 800, 300, { text: "Second hint" }), { id: "ar", kind: "arrow", author: "coach", seq: 3, x: 0, y: 0, w: 0, h: 0, fromId: "a", toId: "b" } as BoardElement]
    const p = planCoachInsertion({ existing: board(rectEl("x", 400, 250, 700, 200)), coach: els, viewport: VP, opId: "t2", now: 1 })
    if (!p.ok) throw new Error(p.reason)
    const a = p.added.find((e) => e.id === "legacy-a")!, b = p.added.find((e) => e.id === "legacy-b")!
    expect(b.x - a.x).toBe(300)
    expect(b.y - a.y).toBe(0)
    const arrow = p.added.find((e) => e.id === "legacy-ar") as any
    expect(arrow.startBinding.elementId).toBe("legacy-a")
  })
  it("with nothing to add, changes nothing", () => {
    const existing = board(rectEl("x", 0, 0, 10, 10))
    const p = planCoachInsertion({ existing, coach: [], viewport: VP, opId: "t3" })
    expect(p.ok && p.added.length).toBe(0)
    expect(p.ok && p.all).toEqual(existing)
  })
  it("works on an empty board and in a crowded one", () => {
    expect(planCoachInsertion({ existing: [], coach: [coach("c", 0, 0)], viewport: VP, opId: "t4" }).ok).toBe(true)
    const crowd = board(...Array.from({ length: 40 }, (_, i) => rectEl(`g${i}`, 20 + (i % 8) * 170, 20 + Math.floor(i / 8) * 150, 150, 120)))
    const p = planCoachInsertion({ existing: crowd, coach: [coach("c", 0, 0)], viewport: VP, opId: "t5" })
    expect(p.ok).toBe(true)
  })
})
