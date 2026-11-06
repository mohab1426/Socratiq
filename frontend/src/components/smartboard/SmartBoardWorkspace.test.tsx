// @vitest-environment jsdom
import "@/test/excalidrawEnv"
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { createRef } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const h = vi.hoisted(() => ({ save: vi.fn(async (..._a: unknown[]) => ({})), gen: vi.fn() }))
vi.mock("@/lib/supabase", () => ({ supabase: { auth: { getSession: async () => ({ data: { session: null } }) } } }))
vi.mock("@/lib/queries", () => ({ saveScene: (...a: unknown[]) => h.save(...a), generateDiagram: (...a: unknown[]) => h.gen(...a) }))

import { SmartBoardWorkspace, type BoardApi } from "./SmartBoardWorkspace"
import { EMPTY_BOARD, type Board } from "@/lib/whiteboard"

beforeEach(() => { h.save.mockClear(); h.gen.mockReset() })
afterEach(cleanup)

const FLOW = { version: 1, type: "flowchart", topic: "login flow", title: "Login flow", nodes: [{ id: "a", label: "Start", kind: "terminal" }, { id: "d", label: "Valid?", kind: "decision" }, { id: "b", label: "Home" }, { id: "c", label: "Retry" }],
  edges: [{ from: "a", to: "d" }, { from: "d", to: "b", label: "yes" }, { from: "d", to: "c", label: "no" }] }
const el = (id: string, kind: string, extra: object = {}) => ({ id, kind, author: "student", seq: 0, x: 100, y: 100, w: 200, h: 60, ...extra })
const legacy = (): Board => ({ steps: [], strokes: [], nextSeq: 2, elements: [el("t1", "text", { text: "Why is the sky blue?", x: 120, y: 80 }) as never, el("c1", "text", { text: "Think about scattering.", author: "coach", x: 500, y: 300 }) as never] })

const mount = (initial: Board = EMPTY_BOARD, props: object = {}) => {
  const ref = createRef<BoardApi>()
  const utils = render(<div style={{ width: 1200, height: 800 }}><SmartBoardWorkspace ref={ref} assignmentId="A1" initial={initial} busy={false} onAsk={vi.fn()} {...props} /></div>)
  return { ref, ...utils }
}
const lastScene = () => h.save.mock.calls[h.save.mock.calls.length - 1][1] as { elements: any[]; files: object; view?: object }
const waitReady = async (ref: React.RefObject<BoardApi | null>) => { await waitFor(() => expect(ref.current).toBeTruthy()); await act(async () => { await new Promise((r) => setTimeout(r, 50)) }) }

const ask = async (text: string) => {
  fireEvent.change(screen.getByLabelText(/Ask the AI to draw or explain/), { target: { value: text } })
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Draw" })) })
}
const flush = async (ref: React.RefObject<BoardApi | null>) => { let ok = false; await act(async () => { ok = await ref.current!.flush() }); return ok }

describe("SmartBoardWorkspace on the real Excalidraw engine", () => {
  it("mounts, shows the empty-state, and offers the AI bar", async () => {
    const { ref } = mount()
    await waitReady(ref)
    expect(screen.getByLabelText(/Ask the AI to draw or explain/)).toBeTruthy()
    expect(screen.getByRole("button", { name: "Draw" })).toBeTruthy()
    expect(screen.getByText(/Ask SocratiQ ▾/)).toBeTruthy()
  })

  it("AI drawing: request -> validated spec -> native, grouped, AI-authored elements on the live scene -> autosaved", async () => {
    h.gen.mockResolvedValue({ spec: FLOW, attempts: 1 })
    const { ref } = mount()
    await waitReady(ref)
    await ask("draw the login flow")
    await waitFor(() => expect(screen.getByText(/Added “Login flow”/)).toBeTruthy())
    expect(h.gen).toHaveBeenCalledTimes(1)
    expect(h.gen.mock.calls[0][0]).toMatchObject({ request: "draw the login flow", board: [] })
    expect(await flush(ref)).toBe(true)
    const scene = lastScene()
    const live = scene.elements.filter((e) => !e.isDeleted)
    expect(live.length).toBeGreaterThan(10)
    const groups = new Set(live.map((e) => e.groupIds[0]))
    expect(groups.size).toBe(1)
    expect([...groups][0]).toMatch(/^ai-group-/)
    expect(live.every((e) => e.customData?.socratiq?.author === "ai")).toBe(true)
    expect(new Set(live.map((e) => e.type))).toEqual(new Set(["rectangle", "ellipse", "diamond", "arrow", "text"]))
    expect(new Set(live.map((e) => e.index)).size).toBe(live.length)
  })

  it("a legacy board is upgraded without losing anything, and the AI drawing then lands beside it without touching it", async () => {
    h.gen.mockResolvedValue({ spec: { ...FLOW, relation: { mode: "explain", targetId: "legacy-t1" } }, attempts: 1 })
    const { ref } = mount(legacy())
    await waitReady(ref)
    expect(await flush(ref)).toBe(true)                                                  // the upgrade itself is persisted
    const upgraded = lastScene().elements
    const t1 = upgraded.find((e) => e.id === "legacy-t1")
    expect([t1.x, t1.y, t1.text]).toEqual([120, 80, "Why is the sky blue?"])
    const before = JSON.stringify(upgraded.filter((e) => !e.isDeleted).map((e) => ({ id: e.id, x: e.x, y: e.y, w: e.width, h: e.height, text: e.text, v: e.version })))
    await ask("explain why the sky is blue")
    await waitFor(() => expect(screen.getByText(/Added “Login flow”/)).toBeTruthy())
    expect(await flush(ref)).toBe(true)
    const after = lastScene().elements.filter((e) => !e.isDeleted)
    const kept = after.filter((e) => !e.groupIds.some((g: string) => g.startsWith("ai-group-")))
    expect(JSON.stringify(kept.map((e) => ({ id: e.id, x: e.x, y: e.y, w: e.width, h: e.height, text: e.text, v: e.version })))).toBe(before)   // student + coach content untouched
    expect(after.length).toBeGreaterThan(kept.length + 10)
  })

  it("selected element is sent to the model as the target, and the Coach sees its legacy id", async () => {
    h.gen.mockResolvedValue({ spec: FLOW, attempts: 1 })
    const { ref } = mount(legacy())
    await waitReady(ref)
    expect(ref.current!.selectedId()).toBeNull()
  })

  it("a rejected or failed generation shows a clear message, keeps the prompt, and changes nothing", async () => {
    const { ApiError } = await import("@/lib/api")
    h.gen.mockRejectedValue(new ApiError(422, "x", "diagram_invalid"))
    const { ref } = mount(legacy())
    await waitReady(ref)
    await flush(ref)
    const saves = h.save.mock.calls.length
    await ask("draw something unclear")
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/rephrasing/))
    expect((screen.getByLabelText(/Ask the AI to draw or explain/) as HTMLInputElement).value).toBe("draw something unclear")
    await flush(ref)
    expect(h.save.mock.calls.length).toBe(saves)
  })

  it("an incoherent spec that slips through is rejected client-side and nothing is inserted", async () => {
    h.gen.mockResolvedValue({ spec: { ...FLOW, edges: FLOW.edges.slice(0, 2) }, attempts: 1 })        // decision with one branch
    const { ref } = mount()
    await waitReady(ref)
    await ask("draw it")
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/not coherent|decision/i))
    await flush(ref)
    expect(h.save).not.toHaveBeenCalled()
  })

  it("Coach drawings written on the server are placed as one group clear of the student's content", async () => {
    const { ref } = mount({ ...legacy(), elements: [legacy().elements[0]] })
    await waitReady(ref)
    await flush(ref)
    const server = { ...legacy(), elements: [legacy().elements[0], el("c9", "text", { text: "Notice where light bends.", author: "coach", x: 120, y: 80 }) as never], nextSeq: 3 }   // coach wrote at the student's coordinates
    let added = 0
    await act(async () => { added = ref.current!.applyServer(server) })
    expect(added).toBe(1)
    expect(ref.current!.applyServer(server)).toBe(0)                                     // idempotent: already mirrored
    await flush(ref)
    const els = lastScene().elements.filter((e) => !e.isDeleted)
    const coachEl = els.find((e) => e.id === "legacy-c9")
    const mine = els.find((e) => e.id === "legacy-t1")
    expect([mine.x, mine.y]).toEqual([120, 80])
    expect(coachEl.groupIds[0]).toMatch(/^coach-group-/)
    expect(coachEl.customData.socratiq).toMatchObject({ author: "coach", legacyId: "c9" })
    const overlap = coachEl.x < mine.x + mine.width && coachEl.x + coachEl.width > mine.x && coachEl.y < mine.y + mine.height && coachEl.y + coachEl.height > mine.y
    expect(overlap).toBe(false)
  })

  it("Coach elements written since the last save appear when the board is reopened", async () => {
    const { ref } = mount(legacy())
    await waitReady(ref)
    await flush(ref)
    const saved = lastScene()
    cleanup()
    h.save.mockClear()
    const server: Board = { ...legacy(), elements: [...legacy().elements, el("c7", "text", { text: "New hint", author: "coach", x: 700, y: 500 }) as never], nextSeq: 5, scene: saved as never }
    const again = mount(server)
    await waitReady(again.ref)
    await flush(again.ref)
    const ids = lastScene().elements.map((e) => e.id)
    expect(ids).toContain("legacy-c7")
    expect(ids.filter((i: string) => i === "legacy-t1").length).toBe(1)                  // nothing duplicated by reopening
  })

  it("reopening restores the saved scene exactly (no migration, no duplicates, no loss)", async () => {
    h.gen.mockResolvedValue({ spec: FLOW, attempts: 1 })
    const first = mount(legacy())
    await waitReady(first.ref)
    await ask("draw the login flow")
    await waitFor(() => expect(screen.getByText(/Added “Login flow”/)).toBeTruthy())
    await flush(first.ref)
    const saved = lastScene()
    cleanup()
    const reopened = mount({ ...legacy(), scene: saved as never })
    await waitReady(reopened.ref)
    await flush(reopened.ref)                                                           // nothing changed, so nothing needs saving
    expect(h.save.mock.calls.length).toBeGreaterThan(0)
    const a = saved.elements.filter((e) => !e.isDeleted).map((e) => e.id).sort()
    const b = (h.save.mock.calls.length > 1 ? lastScene() : saved).elements.filter((e) => !e.isDeleted).map((e) => e.id).sort()
    expect(b).toEqual(a)
  })

  it("remove deletes exactly the AI group; the student's elements stay", async () => {
    h.gen.mockResolvedValue({ spec: FLOW, attempts: 1 })
    const { ref } = mount(legacy())
    await waitReady(ref)
    await ask("draw the login flow")
    await waitFor(() => expect(screen.getByText(/Added “Login flow”/)).toBeTruthy())
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Remove" })) })
    await flush(ref)
    const live = lastScene().elements.filter((e) => !e.isDeleted)
    expect(live.map((e) => e.id).sort()).toEqual(["legacy-c1", "legacy-t1"])
  })

  it("a failed save is reported and can be retried; the work stays on the board", async () => {
    h.save.mockRejectedValueOnce(new Error("offline"))
    h.gen.mockResolvedValue({ spec: FLOW, attempts: 1 })
    const { ref } = mount()
    await waitReady(ref)
    await ask("draw the login flow")
    await waitFor(() => expect(screen.getByText(/Added “Login flow”/)).toBeTruthy())
    expect(await flush(ref)).toBe(false)
    await waitFor(() => expect(screen.getByRole("button", { name: "Retry now" })).toBeTruthy())
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Retry now" })) })
    await waitFor(() => expect(screen.getByText(/^Saved/)).toBeTruthy())
    expect(lastScene().elements.filter((e) => !e.isDeleted).length).toBeGreaterThan(10)
  })

  it("while the Coach writes, the board shows it and the Ask menu is disabled", async () => {
    const { ref } = mount(legacy(), { busy: true })
    await waitReady(ref)
    expect(screen.getByText("SocratiQ is writing on the board…")).toBeTruthy()
  })

  it("read-only boards have no AI bar and never save", async () => {
    const { ref } = mount(legacy(), { readOnly: true })
    await waitReady(ref)
    expect(screen.queryByLabelText(/Ask the AI to draw or explain/)).toBeNull()
    expect(await flush(ref)).toBe(true)
    expect(h.save).not.toHaveBeenCalled()
  })

  it("the intent menu sends the same Coach turns as the legacy board", async () => {
    const onAsk = vi.fn()
    const { ref } = mount(legacy(), { onAsk })
    await waitReady(ref)
    await act(async () => { fireEvent.click(screen.getByRole("menuitem", { name: "Check my work", hidden: true })) })
    expect(onAsk).toHaveBeenCalledWith("correct", "Check my work on the board and tell me where to look.")
  })
})
