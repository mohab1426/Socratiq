import { describe, expect, it } from "vitest"
import { ApiError, camelize } from "../api"
import { boardDigest, describeAiError, describeSaveError, isPermanentSaveError, sceneSignature, selectedLegacyId } from "./glue"
import type { SceneEl } from "./types"

const t = (id: string, text: string, extra: Partial<SceneEl> = {}): SceneEl => ({ id, type: "text", x: 0, y: 0, width: 10, height: 10, text, ...extra })

describe("boardDigest", () => {
  it("lists live text only, newest first, clipped and bounded", () => {
    const els = [t("old", "first", { updated: 1 }), t("new", "x".repeat(400), { updated: 9 }), t("gone", "deleted", { isDeleted: true }), { id: "r", type: "rectangle", x: 0, y: 0, width: 1, height: 1 }, t("blank", "   ")] as SceneEl[]
    const d = boardDigest(els)
    expect(d.map((x) => x.id)).toEqual(["new", "old"])
    expect(d[0].text.length).toBe(160)
    expect(boardDigest(Array.from({ length: 100 }, (_, i) => t("e" + i, "n")), 40).length).toBe(40)
  })
})

describe("selectedLegacyId", () => {
  const meta = (legacyId: string) => ({ customData: { socratiq: { v: 1, author: "coach", legacyId } } })
  it("maps a selected migrated element (or its bound label's container) to the legacy id the Coach uses", () => {
    const els = [t("a", "x", meta("c1")), { id: "box", type: "rectangle", x: 0, y: 0, width: 1, height: 1, ...meta("c2") }, t("lbl", "in box", { containerId: "box" }), t("native", "mine")] as SceneEl[]
    expect(selectedLegacyId(els, { a: true })).toBe("c1")
    expect(selectedLegacyId(els, { lbl: true })).toBe("c2")
    expect(selectedLegacyId(els, { native: true })).toBeNull()
    expect(selectedLegacyId(els, { a: false })).toBeNull()
    expect(selectedLegacyId(els, {})).toBeNull()
  })
})

describe("error handling", () => {
  it("separates permanent from transient save failures and explains each", () => {
    expect(isPermanentSaveError(new ApiError(413, "x", "board_too_large"))).toBe(true)
    expect(isPermanentSaveError(new ApiError(409, "x", "no_open_attempt"))).toBe(true)
    expect(isPermanentSaveError(new ApiError(503, "x", "x"))).toBe(false)
    expect(isPermanentSaveError(new ApiError(0, "x", "network"))).toBe(false)
    expect(isPermanentSaveError(new Error("boom"))).toBe(false)
    expect(describeSaveError(new ApiError(413, "x", "board_too_large"))).toMatch(/too large/)
    expect(describeSaveError(new ApiError(409, "x", "no_open_attempt"))).toMatch(/submitted/)
    expect(describeSaveError(new ApiError(0, "x", "network"))).toMatch(/back online/)
    expect(describeAiError(new ApiError(422, "x", "diagram_invalid"))).toMatch(/rephrasing/)
  })
})

describe("sceneSignature", () => {
  it("changes when an element is edited or added, not otherwise", () => {
    const a = [{ version: 1 }, { version: 4 }]
    expect(sceneSignature(a)).toBe(sceneSignature([{ version: 1 }, { version: 4 }]))
    expect(sceneSignature(a)).not.toBe(sceneSignature([{ version: 1 }, { version: 5 }]))
    expect(sceneSignature(a)).not.toBe(sceneSignature([...a, { version: 1 }]))
  })
})

describe("camelize leaves the native scene untouched", () => {
  it("rewrites snake_case keys everywhere except inside `scene`", () => {
    const out = camelize<any>({ next_seq: 2, scene: { elements: [{ id: "a", custom_data: { some_key: 1 } }], files: { "id_with_underscore": { data_url: "x" } } }, updated_at: "t" })
    expect(out.nextSeq).toBe(2)
    expect(out.updatedAt).toBe("t")
    expect(out.scene.elements[0].custom_data.some_key).toBe(1)
    expect(Object.keys(out.scene.files)).toEqual(["id_with_underscore"])
  })
})
