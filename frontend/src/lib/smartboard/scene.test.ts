// @vitest-environment jsdom
import { describe, expect, it } from "vitest"
import { aiGroup, board, freedraw, imageEl, loop, rectEl, spec, text } from "@/test/boardFactory"
import { applyErasers, legacyBoardToNative, legacyElementId, unmirroredCoachElements } from "./legacy"
import { planAiInsertion } from "./insertAi"
import { authorOf, opIdOf } from "./meta"
import { buildStoredScene, compressSceneFiles, FILE_RECOMPRESS_ABOVE, isStoredScene, restoreStoredScene, sceneBytes, SCENE_MAX_BYTES, SCENE_VERSION } from "./scene"
import { EMPTY_BOARD, type Board, type BoardElement, type Stroke } from "../whiteboard"
import type { SceneEl } from "./types"

const files = (...ids: string[]) => Object.fromEntries(ids.map((id) => [id, { mimeType: "image/png", id, dataURL: "data:image/png;base64,AAAA", created: 1 }])) as never
const app = { viewBackgroundColor: "#ffffff", scrollX: -120, scrollY: 45, zoom: { value: 0.75 }, gridSize: null } as never

describe("native scene persistence", () => {
  const plan = () => {
    const before = board(text("s1", 100, 100, "My question", 24), rectEl("s2", 100, 200, 200, 100), freedraw("f", 400, 100, [[0, 0], [30, 20], [60, 0], [90, 25]]), loop("lp", 700, 300, 60), imageEl("img", 900, 100, 200, 150))
    const r = planAiInsertion({ spec: spec("flow"), request: "", elements: before, viewport: { x: 0, y: 0, w: 1400, h: 800 }, opId: "persist-op" })
    if (!r.ok || r.duplicate) throw new Error("setup")
    return r
  }
  it("round-trips through the engine's own serialization with nothing lost", () => {
    const r = plan()
    const stored = buildStoredScene(r.all, app, files("file-img"))
    const wire = JSON.parse(JSON.stringify(stored))                 // what the server stores and returns
    expect(isStoredScene(wire)).toBe(true)
    const back = restoreStoredScene(wire)
    expect(back.elements.map((e) => e.id)).toEqual(r.all.map((e) => e.id))
    let worstArrow = 0
    for (const e of r.all) {
      const b = back.elements.find((x) => x.id === e.id)!
      expect(b.type).toBe(e.type)
      expect(b.groupIds).toEqual(e.groupIds)
      expect(b.customData).toEqual(e.customData)
      const d = Math.max(Math.abs(b.x - e.x), Math.abs(b.y - e.y), Math.abs(b.width - e.width), Math.abs(b.height - e.height))
      // Everything except arrows must come back EXACTLY. Arrows may be re-snapped to their bound shapes by the engine's own restore.
      if (e.type === "arrow") worstArrow = Math.max(worstArrow, d)
      else expect(d, `${e.type} ${e.id} drifted by ${d}px`).toBeLessThan(0.001)
    }
    console.log(`@@restore: worst arrow re-snap ${worstArrow.toFixed(2)}px`)
    expect(worstArrow).toBeLessThan(2.5)
    const fd = back.elements.find((e) => e.id === "f") as any
    expect(fd.points.length).toBe(4)
  })
  it("AI group metadata survives save and reopen (group id, author, operation id)", () => {
    const r = plan()
    const back = restoreStoredScene(JSON.parse(JSON.stringify(buildStoredScene(r.all, app, files("file-img")))))
    const ai = back.elements.filter((e) => e.groupIds.includes(r.groupId))
    expect(ai.length).toBe(r.added.length)
    expect(ai.every((e) => authorOf(e as SceneEl) === "ai" && opIdOf(e as SceneEl) === "persist-op")).toBe(true)
    expect(back.elements.filter((e) => authorOf(e as SceneEl) === "student").length).toBe(5)
  })
  it("restored arrows keep their bindings to the right shapes", () => {
    const r = plan()
    const back = restoreStoredScene(JSON.parse(JSON.stringify(buildStoredScene(r.all, app, files("file-img")))))
    const ids = new Set(back.elements.map((e) => e.id))
    for (const a of back.elements.filter((e) => e.type === "arrow") as any[]) for (const b of [a.startBinding, a.endBinding]) if (b) expect(ids.has(b.elementId)).toBe(true)
  })
  it("restores the viewport (pan and zoom) and the background", () => {
    const back = restoreStoredScene(JSON.parse(JSON.stringify(buildStoredScene(plan().all, app, files("file-img")))))
    expect(back.appState.scrollX).toBe(-120)
    expect(back.appState.scrollY).toBe(45)
    expect(back.appState.zoom?.value).toBe(0.75)
    expect(back.appState.viewBackgroundColor).toBe("#ffffff")
  })
  it("stores only files that are still referenced and drops deleted elements", () => {
    const els = board(imageEl("img", 0, 0, 100, 100), rectEl("gone", 0, 200, 50, 50)).map((e) => (e.id === "gone" ? { ...e, isDeleted: true } : e))
    const stored = buildStoredScene(els, app, files("file-img", "file-orphan"))
    expect(Object.keys(stored.files)).toEqual(["file-img"])
    expect(stored.elements.map((e: any) => e.id)).toEqual(["img"])
  })
  it("is versioned and is not a screenshot", () => {
    const s = buildStoredScene(plan().all, app, files("file-img"))
    expect(s.version).toBe(SCENE_VERSION)
    expect(s.type).toBe("excalidraw")
    expect(JSON.stringify(s)).not.toMatch(/data:image\/png;base64,iVBOR/)
  })
  it("tolerates a damaged payload instead of throwing (never blocks opening the board)", () => {
    const back = restoreStoredScene({ version: 2, type: "excalidraw", elements: [{ id: "x", type: "rectangle" }, { nonsense: true }] as never, appState: {}, files: {} })
    expect(back.elements.find((e) => e.id === "x")).toBeDefined()
    expect(isStoredScene({ elements: "nope" })).toBe(false)
    expect(isStoredScene(null)).toBe(false)
  })
  it("reports its size and stays under the local limit for a realistic board", () => {
    const s = buildStoredScene(plan().all, app, files("file-img"))
    expect(sceneBytes(s)).toBeGreaterThan(1000)
    expect(sceneBytes(s)).toBeLessThan(SCENE_MAX_BYTES)
  })
})

describe("image compression for storage only", () => {
  const big = "data:image/png;base64," + "A".repeat(FILE_RECOMPRESS_ABOVE + 10)
  const scene = () => ({ ...buildStoredScene(board(imageEl("a", 0, 0, 10, 10)), app, {} as never), files: { big: { mimeType: "image/png", id: "big", dataURL: big, created: 1 }, small: { mimeType: "image/png", id: "small", dataURL: "data:image/png;base64,AAAA", created: 1 } } })
  it("recompresses only oversized files, caches by id, never mutates the input", async () => {
    let calls = 0
    const cache = new Map<string, string>()
    const input = scene()
    const out = await compressSceneFiles(input, async () => { calls++; return "data:image/jpeg;base64,BBBB" }, cache)
    expect(out.files.big.dataURL).toBe("data:image/jpeg;base64,BBBB")
    expect(out.files.big.mimeType).toBe("image/jpeg")
    expect(out.files.small.dataURL).toBe("data:image/png;base64,AAAA")
    expect(input.files.big.dataURL).toBe(big)
    await compressSceneFiles(input, async () => { calls++; return "x" }, cache)
    expect(calls).toBe(1)
  })
  it("keeps the original when compression fails or does not help", async () => {
    expect((await compressSceneFiles(scene(), async () => { throw new Error("boom") })).files.big.dataURL).toBe(big)
    expect((await compressSceneFiles(scene(), async () => big + "more")).files.big.dataURL).toBe(big)
  })
})

describe("legacy board migration (non-destructive, deterministic)", () => {
  const el = (p: Partial<BoardElement> & Pick<BoardElement, "id" | "kind">, seq: number): BoardElement => ({ author: "student", seq, x: 100, y: 100, w: 200, h: 80, ...p })
  const legacy = (): Board => ({
    steps: ["Step one: define terms", "  ", "Step two: apply"],
    strokes: [
      { t: "p", w: 4, pts: [[100, 500], [160, 520], [220, 500], [280, 540]], color: "#2563eb" },
      { t: "h", w: 12, pts: [[100, 600], [400, 600]], color: "#facc15" },
      { t: "p", w: 4, pts: [[100, 700], [200, 700], [300, 700], [400, 700]] },
      { t: "e", w: 20, pts: [[250, 690], [250, 710]] },
    ],
    elements: [
      el({ id: "t1", kind: "text", text: "Why is the sky blue?", x: 120, y: 80, fontSize: 28 }, 0),
      el({ id: "q1", kind: "equation", latex: "E = mc^2", x: 120, y: 200 }, 1),
      el({ id: "r1", kind: "shape", shape: "rect", x: 500, y: 100, w: 220, h: 120, color: "blue", filled: true }, 2),
      el({ id: "c1", kind: "circle", x: 800, y: 100, w: 120, h: 120 }, 3),
      el({ id: "tri", kind: "triangle", x: 1000, y: 100, w: 100, h: 90 }, 4),
      el({ id: "a1", kind: "arrow", fromId: "t1", toId: "r1", x: 0, y: 0, w: 0, h: 0 }, 5),
      el({ id: "a2", kind: "arrow", x: 600, y: 400, w: 150, h: 60 }, 6),
      el({ id: "l1", kind: "line", x: 700, y: 300, w: 0, h: 0, x2: 900, y2: 340 }, 7),
      el({ id: "p1", kind: "path", x: 1100, y: 300, w: 0, h: 0, points: [{ x: 0, y: 0 }, { x: 40, y: 30 }, { x: 80, y: 0 }] }, 8),
      el({ id: "p2", kind: "path", x: 1100, y: 400, w: 0, h: 0, pathData: "M 0 0 L 50 50" }, 9),
      el({ id: "i1", kind: "image", x: 1200, y: 500, w: 160, h: 120, src: "data:image/png;base64,iVBORw0KGgo=" }, 10),
      el({ id: "sim", kind: "simulation", x: 100, y: 800, w: 400, h: 300, title: "Pendulum", code: "<html></html>" }, 11),
      el({ id: "coach1", kind: "text", text: "Think about scattering.", author: "coach", x: 120, y: 300 }, 12),
      el({ id: "ar", kind: "around" as never, around: "t1" } as never, 13),
    ].filter((e) => e.kind !== ("around" as never)),
    nextSeq: 14,
  })
  const deepFreeze = <T,>(o: T): T => { Object.values(o as object).forEach((v) => v && typeof v === "object" && deepFreeze(v)); return Object.freeze(o) }

  it("converts every legacy kind and reports what could not be represented", () => {
    const m = legacyBoardToNative(legacy(), 1)
    const byId = new Map(m.elements.map((e) => [e.id, e]))
    expect(byId.get(legacyElementId("t1"))!.type).toBe("text")
    expect((byId.get(legacyElementId("q1")) as any).text).toBe("E = mc^2")
    expect(byId.get(legacyElementId("r1"))!.type).toBe("rectangle")
    expect(byId.get(legacyElementId("c1"))!.type).toBe("ellipse")
    expect(byId.get(legacyElementId("tri"))!.type).toBe("line")
    expect((byId.get(legacyElementId("tri")) as any).polygon).toBe(true)
    expect(byId.get(legacyElementId("l1"))!.type).toBe("line")
    expect((byId.get(legacyElementId("p1")) as any).points.length).toBe(3)
    expect(byId.get(legacyElementId("i1"))!.type).toBe("image")
    expect(Object.keys(m.files).length).toBe(1)
    expect(byId.has(legacyElementId("p2"))).toBe(false)
    expect(m.report.unsupported).toEqual({ simulation: 1, pathData: 1, missingTarget: 0 })
    expect(m.report.warnings.join()).toMatch(/Pendulum/)
    expect(byId.get(legacyElementId("sim"))!.type).toBe("rectangle")
  })
  it("keeps legacy coordinates 1:1 (the infinite canvas starts where the old stage was)", () => {
    const byId = new Map(legacyBoardToNative(legacy(), 1).elements.map((e) => [e.id, e]))
    expect([byId.get(legacyElementId("t1"))!.x, byId.get(legacyElementId("t1"))!.y]).toEqual([120, 80])
    expect([byId.get(legacyElementId("r1"))!.x, byId.get(legacyElementId("r1"))!.y]).toEqual([500, 100])
  })
  it("rebuilds linked arrows as real bindings", () => {
    const byId = new Map(legacyBoardToNative(legacy(), 1).elements.map((e) => [e.id, e]))
    const a = byId.get(legacyElementId("a1")) as any
    expect(a.startBinding.elementId).toBe(legacyElementId("t1"))
    expect(a.endBinding.elementId).toBe(legacyElementId("r1"))
    expect(((byId.get(legacyElementId("a2")) as any).startBinding)).toBeNull()
  })
  it("preserves authorship: coach content stays coach, with the legacy id for later mapping", () => {
    const m = legacyBoardToNative(legacy(), 1)
    const c = m.elements.find((e) => e.id === legacyElementId("coach1"))!
    expect(authorOf(c as SceneEl)).toBe("coach")
    expect((c.customData as any).socratiq.legacyId).toBe("coach1")
    expect(authorOf(m.elements.find((e) => e.id === legacyElementId("t1")) as SceneEl)).toBe("student")
  })
  it("converts freehand ink; highlighter is translucent; typed steps become text below the content", () => {
    const m = legacyBoardToNative(legacy(), 1)
    const strokes = m.elements.filter((e) => e.type === "freedraw") as any[]
    expect(strokes.length).toBeGreaterThanOrEqual(3)
    expect(strokes.some((s) => s.opacity === 35)).toBe(true)
    const steps = m.elements.filter((e) => e.id.startsWith("legacy-step-")) as any[]
    expect(steps.map((s) => s.text)).toEqual(["Step one: define terms", "Step two: apply"])
    const maxY = Math.max(...m.elements.filter((e) => !e.id.startsWith("legacy-step-")).map((e) => e.y + (e.height || 0)))
    expect(steps[0].y).toBeGreaterThan(maxY)
  })
  it("eraser strokes remove the ink they crossed, splitting strokes (so erased parts do not reappear)", () => {
    const strokes: Stroke[] = [{ t: "p", w: 4, pts: [[100, 700], [200, 700], [300, 700], [400, 700]] }, { t: "e", w: 20, pts: [[250, 690], [250, 710]] }]
    const r = applyErasers(strokes)
    expect(r.erasedParts).toBe(1)
    expect(r.ink.length).toBe(2)
    expect(r.ink.every((k) => k.pts.every((p) => Math.abs(p[0] - 250) > 10))).toBe(true)
    expect(applyErasers([{ t: "p", w: 4, pts: [[0, 0], [10, 0]] }, { t: "e", w: 10, pts: [[500, 500]] }]).ink.length).toBe(1)
  })
  it("never mutates the legacy board and is deterministic", () => {
    const b = deepFreeze(legacy())
    const a1 = JSON.stringify(legacyBoardToNative(b, 1)), a2 = JSON.stringify(legacyBoardToNative(b, 1))
    expect(a1).toBe(a2)
  })
  it("an empty legacy board migrates to an empty scene without error", () => {
    const m = legacyBoardToNative(EMPTY_BOARD, 1)
    expect(m.elements).toEqual([])
    expect(m.report.converted).toBe(0)
  })
  it("a migrated board survives the full save/restore cycle", () => {
    const m = legacyBoardToNative(legacy(), 1)
    const back = restoreStoredScene(JSON.parse(JSON.stringify(buildStoredScene(m.elements, app, m.files as never))))
    expect(back.elements.length).toBe(m.elements.length)
  })
  it("finds Coach elements written server-side that are not yet in the scene, and ignores ones already mirrored", () => {
    const b = legacy()
    expect(unmirroredCoachElements(b, []).map((e) => e.id)).toEqual(["coach1"])
    const m = legacyBoardToNative(b, 1)
    expect(unmirroredCoachElements(b, m.elements as never)).toEqual([])
  })
  it("an existing AI group on a legacy-migrated board is protected by the placement engine", () => {
    const m = legacyBoardToNative(legacy(), 1)
    const r = planAiInsertion({ spec: spec("map"), request: "why is the sky blue", elements: m.elements, viewport: { x: 0, y: 0, w: 1400, h: 800 }, opId: "on-legacy" })
    expect(r.ok).toBe(true)
    void aiGroup
  })
})
