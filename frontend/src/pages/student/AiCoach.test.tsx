// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { installDomStubs, pointer } from "@/test/domStubs"

const h = vi.hoisted(() => ({
  send: vi.fn(),
  save: vi.fn(async (..._a: unknown[]) => ({})),
  state: {
    board: { steps: [] as string[], strokes: [] as unknown[], elements: [] as unknown[], nextSeq: 0 },
    assignment: { id: "A1", title: "Gradient descent", topic: "Gradient descent", dueDate: "2099-01-01T00:00:00Z", status: "in_progress" },
  },
}))

vi.mock("@/lib/supabase", () => ({ supabase: { auth: { getSession: async () => ({ data: { session: null } }) } } }))
vi.mock("@/lib/queries", () => ({
  sendCoachStream: (...a: unknown[]) => h.send(...a),
  saveWhiteboard: (...a: unknown[]) => h.save(...a),
  useCoachHistory: () => ({ data: [], isPending: false }),
  useStartAttempt: () => ({ mutate: vi.fn() }),
  useStudentAssignment: () => ({ data: h.state.assignment }),
  useStudentCourse: () => ({ data: { course: { name: "CS101" } } }),
  useWhiteboard: () => ({ data: h.state.board, isError: false }),
}))
vi.mock("@/components/layout/AppShell", () => ({ AppShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }))
vi.mock("@/components/ui/States", () => ({ QueryState: ({ query, children }: { query: { data: unknown }; children: (d: unknown) => React.ReactNode }) => children(query.data) }))

import { ApiError } from "@/lib/api"
import AiCoach from "./AiCoach"

const COACH_ITEM = { id: "e1", kind: "equation", author: "coach", seq: 0, x: 60, y: 60, w: 260, h: 100, latex: "2x + 4 = 10" }
const STUDENT_ITEM = { id: "s1", kind: "text", author: "student", seq: 0, x: 60, y: 60, w: 300, h: 76, text: "my work" }
const reply = (over = {}) => ({
  interactionId: "i1", turn: 1, sources: [],
  message: { id: "m1", role: "coach", content: "Here is the first step." },
  board: { steps: [], strokes: [], elements: [COACH_ITEM], nextSeq: 1, report: { applied: [{ action: "add_equation", id: "e1" }], rejected: [] } },
  ...over,
})

beforeEach(() => {
  // These tests drive the LEGACY workspace's DOM (its toolbar, pointer selection, "Ask SocratiQ" menu). They also protect engine-independent page logic
  // (modes, flush-before-send, lock while busy, retry, read-only), so they stay pinned to the legacy engine via the fallback flag.
  vi.stubEnv("VITE_SMARTBOARD_ENGINE", "legacy")
  installDomStubs()
  if (!globalThis.crypto?.randomUUID) Object.defineProperty(globalThis, "crypto", { value: { randomUUID: () => Math.random().toString(36).slice(2) }, configurable: true })
  h.send.mockReset()
  h.save.mockClear()
  h.state.board = { steps: [], strokes: [], elements: [], nextSeq: 0 }
  h.state.assignment.status = "in_progress"
})
afterEach(() => { cleanup(); vi.unstubAllEnvs() })

const mount = () => render(
  <MemoryRouter initialEntries={["/student/courses/C1/assignments/A1/coach"]}>
    <Routes><Route path="/student/courses/:courseId/assignments/:assignmentId/coach" element={<AiCoach />} /></Routes>
  </MemoryRouter>,
)
const tab = (n: string) => screen.getByRole("tab", { name: n })
const say = (text: string) => {
  fireEvent.change(screen.getByLabelText("Message SocratiQ AI"), { target: { value: text } })
  fireEvent.click(screen.getByRole("button", { name: "Send message" }))
}
const hidden = (el: Element | null) => !!el?.closest(".hidden")
const visible = (re: string | RegExp) => screen.getAllByText(re).some((el) => !hidden(el))

describe("Chat | Whiteboard modes", () => {
  it("opens in Chat mode with the board mounted but out of the way", () => {
    mount()
    expect(tab("Chat").getAttribute("aria-selected")).toBe("true")
    expect(tab("Whiteboard").getAttribute("aria-selected")).toBe("false")
    expect(screen.getByPlaceholderText("Start your chat here…")).toBeTruthy()
    expect(hidden(screen.getByRole("toolbar", { hidden: true }))).toBe(true)
    expect(hidden(screen.getByText(/Tell SocratiQ where you're stuck/))).toBe(false)
  })

  it("Whiteboard mode makes the board the workspace and hides the chat transcript", () => {
    mount()
    fireEvent.click(tab("Whiteboard"))
    expect(tab("Whiteboard").getAttribute("aria-selected")).toBe("true")
    expect(hidden(screen.getByRole("toolbar"))).toBe(false)
    expect(hidden(screen.getByText(/Tell SocratiQ where you're stuck/))).toBe(true)
    expect(screen.getByPlaceholderText(/Ask SocratiQ about the board/)).toBeTruthy()
    fireEvent.click(tab("Chat"))
    expect(hidden(screen.getByRole("toolbar", { hidden: true }))).toBe(true)
  })

  it("switching modes keeps the board (and its undo history) alive", () => {
    h.state.board = { ...h.state.board, elements: [STUDENT_ITEM], nextSeq: 1 }
    const { container } = mount()
    fireEvent.click(tab("Whiteboard"))
    act(() => pointer(container.querySelector('[data-element-id="s1"]')!, "pointerdown", 40, 40))
    fireEvent.keyDown(window, { key: "Delete" })
    expect(container.querySelector('[data-element-id="s1"]')).toBeNull()
    fireEvent.click(tab("Chat"))
    fireEvent.click(tab("Whiteboard"))
    expect(screen.getByRole("button", { name: "Undo" }).hasAttribute("disabled")).toBe(false)
  })
})

describe("talking to SocratiQ from the board", () => {
  it("sends the board mode and the selected item with the message", async () => {
    h.state.board = { ...h.state.board, elements: [STUDENT_ITEM], nextSeq: 1 }
    h.send.mockResolvedValue(reply({ board: undefined }))
    const { container } = mount()
    fireEvent.click(tab("Whiteboard"))
    act(() => pointer(container.querySelector('[data-element-id="s1"]')!, "pointerdown", 40, 40))
    say("اشرح الخطوة دي")
    await waitFor(() => expect(h.send).toHaveBeenCalledTimes(1))
    expect(h.send.mock.calls[0][0]).toMatchObject({ assignmentId: "A1", message: "اشرح الخطوة دي", mode: "board", selectedId: "s1" })
  })

  it("chat messages say chat mode", async () => {
    h.send.mockResolvedValue(reply({ board: undefined }))
    mount()
    say("hello")
    await waitFor(() => expect(h.send).toHaveBeenCalledTimes(1))
    expect(h.send.mock.calls[0][0]).toMatchObject({ mode: "chat", message: "hello" })
  })

  it("applies what SocratiQ wrote, shows its reply under the board, and leaves a 'view board' chip in the chat", async () => {
    h.send.mockResolvedValue(reply())
    const { container } = mount()
    fireEvent.click(tab("Whiteboard"))
    say("write the equation on the board")
    await waitFor(() => expect(container.querySelector('[data-author="coach"].sb-appear')).not.toBeNull())
    expect(visible("Here is the first step.")).toBe(true)                                              // reply strip under the board
    fireEvent.click(tab("Chat"))
    const chip = screen.getByRole("button", { name: /Wrote 1 item on the board/ })
    fireEvent.click(chip)
    expect(tab("Whiteboard").getAttribute("aria-selected")).toBe("true")
  })

  it("Ask SocratiQ sends the chosen intent as a normal Coach turn", async () => {
    h.send.mockResolvedValue(reply({ board: undefined }))
    mount()
    fireEvent.click(tab("Whiteboard"))
    fireEvent.click(screen.getByRole("button", { name: /Ask SocratiQ/ }))
    fireEvent.click(screen.getByRole("menuitem", { name: "Continue" }))
    await waitFor(() => expect(h.send).toHaveBeenCalledTimes(1))
    expect(h.send.mock.calls[0][0]).toMatchObject({ mode: "board", boardIntent: "continue", message: "Continue from the last step on the board." })
  })

  it("while SocratiQ works the board is locked and shows live progress, then unlocks", async () => {
    let finish!: (v: unknown) => void
    h.send.mockImplementation((_v: unknown, onStage: (l: string) => void) => { onStage("Working out where you are"); return new Promise((r) => { finish = r }) })
    mount()
    fireEvent.click(tab("Whiteboard"))
    say("solve it with me")
    await screen.findByText("SocratiQ is writing on the board…")
    expect(screen.getByRole("button", { name: "Pen" }).hasAttribute("disabled")).toBe(true)
    expect(visible(/Working out where you are/)).toBe(true)
    await act(async () => { finish(reply({ board: undefined })) })
    await waitFor(() => expect(screen.getByRole("button", { name: "Pen" }).hasAttribute("disabled")).toBe(false))
  })

  it("saves pending board edits BEFORE the message goes out, so the Coach reads the latest board", async () => {
    h.state.board = { ...h.state.board, steps: ["x + 5 = 12"] }            // old-format steps get converted and must be saved first
    h.send.mockResolvedValue(reply({ board: undefined }))
    mount()
    say("is this right?")
    await waitFor(() => expect(h.send).toHaveBeenCalledTimes(1))
    expect(h.save).toHaveBeenCalledTimes(1)
    expect(h.save.mock.invocationCallOrder[0]).toBeLessThan(h.send.mock.invocationCallOrder[0])
  })

  it("a failed turn shows a clear error with Retry and leaves the board untouched", async () => {
    h.send.mockRejectedValue(new ApiError(503, "down", "ai_unavailable"))
    const { container } = mount()
    fireEvent.click(tab("Whiteboard"))
    say("write it")
    const alert = await screen.findByRole("alert")
    expect(alert.textContent).toContain("SocratiQ AI is unavailable right now")
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy()
    expect(container.querySelector('[data-author="coach"]')).toBeNull()
  })
})

describe("after submission", () => {
  it("the board is shown read-only and the composer is disabled", () => {
    h.state.assignment.status = "submitted"
    h.state.board = { ...h.state.board, elements: [STUDENT_ITEM], nextSeq: 1 }
    mount()
    fireEvent.click(tab("Whiteboard"))
    expect(screen.queryByRole("toolbar")).toBeNull()
    expect(screen.getByLabelText("Message SocratiQ AI").hasAttribute("disabled")).toBe(true)
    expect(screen.getByText("my work")).toBeTruthy()
  })
})
