// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { createRef } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { at, installDomStubs, pointer } from "@/test/domStubs"
import { EMPTY_BOARD, type Board } from "@/lib/whiteboard"
import { BoardWorkspace, type BoardApi } from "./BoardWorkspace"

const save = vi.fn(async (..._a: unknown[]) => ({}))
vi.mock("@/lib/queries", () => ({ saveWhiteboard: (...a: unknown[]) => save(...a) }))

const STUDENT: Board = { ...EMPTY_BOARD, nextSeq: 1, elements: [{ id: "s1", kind: "text", author: "student", seq: 0, x: 60, y: 60, w: 300, h: 76, text: "2x + 4 = 10" }] }
const SERVER: Board = { ...STUDENT, nextSeq: 3, elements: [...STUDENT.elements,
  { id: "e1", kind: "equation", author: "coach", seq: 1, x: 60, y: 200, w: 260, h: 100, latex: "2x = 6" },
  { id: "e2", kind: "text", author: "coach", seq: 2, x: 60, y: 330, w: 400, h: 76, text: "Subtract 4" }] }

beforeEach(() => { installDomStubs(); save.mockClear() })
afterEach(() => { cleanup(); vi.useRealTimers() })

function mount(over: Partial<React.ComponentProps<typeof BoardWorkspace>> = {}) {
  const api = createRef<BoardApi>()
  const onAsk = vi.fn()
  const r = render(<BoardWorkspace ref={api} assignmentId="A1" initial={STUDENT} busy={false} onAsk={onAsk} {...over} />)
  return { ...r, api, onAsk }
}
const btn = (name: string) => screen.getByRole("button", { name })
const overlay = (c: HTMLElement) => c.querySelector<HTMLElement>('div[style*="crosshair"], div[style*="cursor: text"]')

describe("toolbar", () => {
  it("exposes the tools, with exactly one active at a time", () => {
    mount()
    for (const t of ["Select and move", "Pen", "Highlighter", "Eraser", "Text", "Equation", "Arrow", "Rectangle", "Ellipse", "Undo", "Redo", "Clear the board"]) expect(btn(t)).toBeTruthy()
    expect(btn("Select and move").getAttribute("aria-pressed")).toBe("true")
    fireEvent.click(btn("Pen"))
    expect(btn("Pen").getAttribute("aria-pressed")).toBe("true")
    expect(btn("Select and move").getAttribute("aria-pressed")).toBe("false")
  })

  it("busy: tools lock and the status says SocratiQ is writing", () => {
    mount({ busy: true })
    expect(btn("Pen").hasAttribute("disabled")).toBe(true)
    expect(screen.getByRole("button", { name: /Ask SocratiQ/ }).hasAttribute("disabled")).toBe(true)
    expect(screen.getByText("SocratiQ is writing on the board…")).toBeTruthy()
  })

  it("read-only boards (submitted attempts) have no toolbar", () => {
    mount({ readOnly: true })
    expect(screen.queryByRole("toolbar")).toBeNull()
  })
})

describe("manual editing", () => {
  it("adds typed text, then undo / redo walk it back and forth", () => {
    const { container } = mount({ initial: EMPTY_BOARD })
    fireEvent.click(btn("Text"))
    act(() => pointer(overlay(container)!, "pointerdown", ...at(300, 300)))
    const box = screen.getByLabelText("Text on the board")
    fireEvent.change(box, { target: { value: "x = 7" } })
    fireEvent.keyDown(box, { key: "Enter" })
    expect(container.querySelector('[data-author="student"]')?.textContent).toBe("x = 7")
    fireEvent.click(btn("Undo"))
    expect(container.querySelector("[data-element-id]")).toBeNull()
    fireEvent.click(btn("Redo"))
    expect(container.querySelector('[data-author="student"]')?.textContent).toBe("x = 7")
  })

  it("adds an equation through the editor with a live preview", async () => {
    const { container } = mount({ initial: EMPTY_BOARD })
    fireEvent.click(btn("Equation"))
    act(() => pointer(overlay(container)!, "pointerdown", ...at(300, 300)))
    expect(screen.getByRole("dialog", { name: "Add an equation" })).toBeTruthy()
    const add = screen.getByRole("button", { name: "Add to board" })
    expect(add.hasAttribute("disabled")).toBe(true)                               // nothing typed yet
    fireEvent.change(document.getElementById("eq-input")!, { target: { value: "a^2 + b^2 = c^2" } })
    await waitFor(() => expect(document.querySelector('[aria-label="Preview"] .katex')).not.toBeNull())
    await waitFor(() => expect(add.hasAttribute("disabled")).toBe(false))
    fireEvent.click(add)
    await waitFor(() => expect(container.querySelector('[data-author="student"] .katex')).not.toBeNull())
    expect(screen.queryByRole("dialog")).toBeNull()                                // dialog closed
  })

  it("refuses an equation that cannot be displayed", async () => {
    const { container } = mount({ initial: EMPTY_BOARD })
    fireEvent.click(btn("Equation"))
    act(() => pointer(overlay(container)!, "pointerdown", ...at(300, 300)))
    fireEvent.change(document.getElementById("eq-input")!, { target: { value: "\\frac{" } })
    await screen.findByText(/can't be displayed as an equation/)
    expect(screen.getByRole("button", { name: "Add to board" }).hasAttribute("disabled")).toBe(true)
  })

  it("clearing needs a confirmation and is undoable", () => {
    const { container } = mount()
    fireEvent.click(btn("Clear the board"))
    expect(container.querySelector("[data-element-id]")).not.toBeNull()           // nothing happened yet
    fireEvent.click(btn("Clear everything?"))
    expect(container.querySelector("[data-element-id]")).toBeNull()
    fireEvent.click(btn("Undo"))
    expect(container.querySelector('[data-element-id="s1"]')).not.toBeNull()
  })

  it("Delete removes the selected element but not while typing", () => {
    const { container } = mount()
    act(() => pointer(container.querySelector('[data-element-id="s1"]')!, "pointerdown", 40, 40))
    fireEvent.keyDown(window, { key: "Delete" })
    expect(container.querySelector('[data-element-id="s1"]')).toBeNull()
  })
})

describe("SocratiQ writing on the board", () => {
  it("applyServer shows the coach's items one after another and reports how many appeared", () => {
    const { container, api } = mount()
    let n = 0
    act(() => { n = api.current!.applyServer(SERVER) })
    expect(n).toBe(2)
    expect(container.querySelectorAll('[data-author="coach"]')).toHaveLength(2)
    const fresh = [...container.querySelectorAll<HTMLElement>(".sb-appear")]
    expect(fresh.map((e) => e.dataset.elementId)).toEqual(["e1", "e2"])
    expect(fresh.map((e) => e.style.animationDelay)).toEqual(["0ms", "650ms"])
    expect(container.querySelector('[data-element-id="s1"]')!.className).not.toContain("sb-appear")   // the student's own item does not animate
  })

  it("one Undo reverts the whole AI turn; Redo brings it back", () => {
    const { container, api } = mount()
    act(() => { api.current!.applyServer(SERVER) })
    fireEvent.click(btn("Undo"))
    expect(container.querySelectorAll('[data-author="coach"]')).toHaveLength(0)
    expect(container.querySelector('[data-element-id="s1"]')).not.toBeNull()
    fireEvent.click(btn("Redo"))
    expect(container.querySelectorAll('[data-author="coach"]')).toHaveLength(2)
  })

  it("a server turn does not trigger a redundant save (the server already holds that state)", async () => {
    vi.useFakeTimers()
    const { api } = mount()
    act(() => { api.current!.applyServer(SERVER) })
    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    expect(save).not.toHaveBeenCalled()
  })
})

describe("Ask SocratiQ", () => {
  it("offers the board actions and sends the matching intent", () => {
    const { onAsk } = mount()
    fireEvent.click(screen.getByRole("button", { name: /Ask SocratiQ/ }))
    expect(screen.getAllByRole("menuitem").map((m) => m.textContent)).toEqual(["Explain this", "Continue", "Check my work", "Summarize", "Organize the board", "Highlight the key point", "Turn into steps"])
    fireEvent.click(screen.getByRole("menuitem", { name: "Continue" }))
    expect(onAsk).toHaveBeenCalledWith("continue", "Continue from the last step on the board.")
    expect(screen.queryByRole("menu")).toBeNull()
  })

  it("acts on the selected item when there is one", () => {
    const { container, onAsk, api } = mount()
    act(() => pointer(container.querySelector('[data-element-id="s1"]')!, "pointerdown", 40, 40))
    expect(api.current!.selectedId()).toBe("s1")
    fireEvent.click(screen.getByRole("button", { name: /Ask SocratiQ/ }))
    expect(screen.getByText("Acts on the selected item.")).toBeTruthy()
    fireEvent.click(screen.getByRole("menuitem", { name: "Explain this" }))
    expect(onAsk).toHaveBeenCalledWith("explain", "Explain the selected part of the board.")
  })
})

describe("persistence", () => {
  it("autosaves edits after a short pause, in the wire format the server expects", async () => {
    vi.useFakeTimers()
    const { container } = mount()
    act(() => pointer(container.querySelector('[data-element-id="s1"]')!, "pointerdown", 40, 40))
    fireEvent.keyDown(window, { key: "Delete" })
    expect(save).not.toHaveBeenCalled()
    await act(async () => { await vi.advanceTimersByTimeAsync(1300) })
    expect(save).toHaveBeenCalledTimes(1)
    expect(save.mock.calls[0][0]).toBe("A1")
    expect(save.mock.calls[0][1]).toMatchObject({ steps: [], strokes: [], elements: [], next_seq: 1 })
  })

  it("flush() saves pending edits immediately (called before every message) and is a no-op when clean", async () => {
    const { container, api } = mount()
    await act(async () => { expect(await api.current!.flush()).toBe(true) })
    expect(save).not.toHaveBeenCalled()
    act(() => pointer(container.querySelector('[data-element-id="s1"]')!, "pointerdown", 40, 40))
    fireEvent.keyDown(window, { key: "Backspace" })
    await act(async () => { await api.current!.flush() })
    expect(save).toHaveBeenCalledTimes(1)
  })

  it("old typed steps are converted to student text elements and saved once", async () => {
    const { container, api } = mount({ initial: { ...EMPTY_BOARD, steps: ["x + 5 = 12", "x = 7"] } })
    expect([...container.querySelectorAll('[data-author="student"]')].map((e) => e.textContent)).toEqual(["x + 5 = 12", "x = 7"])
    await act(async () => { await api.current!.flush() })
    const wire = save.mock.calls[0][1] as { steps: string[]; elements: { author: string; text: string }[] }
    expect(wire.steps).toEqual([])
    expect(wire.elements.map((e) => e.text)).toEqual(["x + 5 = 12", "x = 7"])
  })

  it("a failed save is reported and retried, never silently dropped", async () => {
    vi.useFakeTimers()
    save.mockRejectedValueOnce(new Error("offline"))
    const { container, api } = mount()
    act(() => pointer(container.querySelector('[data-element-id="s1"]')!, "pointerdown", 40, 40))
    fireEvent.keyDown(window, { key: "Delete" })
    await act(async () => { expect(await api.current!.flush()).toBe(false) })
    expect(screen.getAllByText("Couldn't save. Will retry.").length).toBeGreaterThan(0)
    await act(async () => { await vi.advanceTimersByTimeAsync(4100) })
    expect(save).toHaveBeenCalledTimes(2)
  })
})

describe("smartboard floating chat bar", () => {
  it("renders the floating chat input when not read-only", () => {
    mount()
    const input = screen.getByPlaceholderText("Ask Gemini to draw, simulate, or explain…")
    expect(input).toBeTruthy()
    expect(screen.getByTitle("Toggle AI Chat History")).toBeTruthy()
    expect(screen.getByTitle("Voice Message")).toBeTruthy()
  })

  it("allows typing instructions and toggling chat history", () => {
    mount()
    const input = screen.getByPlaceholderText("Ask Gemini to draw, simulate, or explain…")
    fireEvent.change(input, { target: { value: "Draw a circuit diagram" } })
    expect(input).toHaveProperty("value", "Draw a circuit diagram")

    const toggle = screen.getByTitle("Toggle AI Chat History")
    fireEvent.click(toggle)
  })

  it("hides floating chat bar when read-only", () => {
    mount({ readOnly: true })
    expect(screen.queryByPlaceholderText("Ask Gemini to draw, simulate, or explain…")).toBeNull()
  })
})

describe("content sizing and viewport controls", () => {
  it("renders zoom controls and handles zoom in/out/fit", () => {
    mount()
    expect(btn("Zoom In")).toBeTruthy()
    expect(btn("Zoom Out")).toBeTruthy()
    expect(btn("Fit to Screen")).toBeTruthy()
    fireEvent.click(btn("Zoom In"))
    fireEvent.click(btn("Zoom Out"))
    fireEvent.click(btn("Fit to Screen"))
  })

  it("reveals contextual sizing presets when an element is selected", () => {
    const { container } = mount()
    // Select student element s1
    act(() => pointer(container.querySelector('[data-element-id="s1"]')!, "pointerdown", 40, 40))
    expect(screen.getByTitle("Set size: Small")).toBeTruthy()
    expect(screen.getByTitle("Set size: Medium")).toBeTruthy()
    expect(screen.getByTitle("Set size: Large")).toBeTruthy()
    expect(screen.getByTitle("Scale down 15%")).toBeTruthy()
    expect(screen.getByTitle("Scale up 15%")).toBeTruthy()

    // Test clicking size preset
    fireEvent.click(screen.getByTitle("Set size: Large"))
    fireEvent.click(screen.getByTitle("Scale up 15%"))
  })
})

describe("color persistence and toolbar synchronization", () => {
  it("picking color while element is selected updates element immediately and does not clobber when switching to pen", () => {
    const { container } = mount()
    // Select student element s1
    act(() => pointer(container.querySelector('[data-element-id="s1"]')!, "pointerdown", 40, 40))

    // Click red swatch
    const redBtn = screen.getByTitle("Color: #ef4444")
    fireEvent.click(redBtn)

    // Verify element color updated to #ef4444
    const s1 = container.querySelector('[data-element-id="s1"]') as HTMLElement
    expect(s1.style.color).toBe("rgb(239, 68, 68)")

    // Switch tool to pen
    fireEvent.click(btn("Pen"))
    expect(btn("Pen").getAttribute("aria-pressed")).toBe("true")

    // The current color remains red (#ef4444)
    expect(redBtn.className).toContain("ring-teal-600")
  })

  it("selecting an element syncs toolbar swatches to that element's color", () => {
    const customBoard: Board = {
      ...EMPTY_BOARD,
      elements: [
        { id: "blue1", kind: "text", author: "student", seq: 0, x: 50, y: 50, w: 200, h: 50, text: "Blue text", color: "#3b82f6" },
      ],
    }
    const { container } = mount({ initial: customBoard })

    // Select blue element
    act(() => pointer(container.querySelector('[data-element-id="blue1"]')!, "pointerdown", 40, 40))
    const blueBtn = screen.getByTitle("Color: #3b82f6")
    expect(blueBtn.className).toContain("ring-teal-600")
  })
})

describe("keyboard shortcuts and clipboard", () => {
  it("supports Ctrl+C copy and Ctrl+V paste to duplicate selected elements", () => {
    const { container } = mount()
    // Select s1
    act(() => pointer(container.querySelector('[data-element-id="s1"]')!, "pointerdown", 40, 40))

    // Copy
    fireEvent.keyDown(window, { key: "c", ctrlKey: true })

    // Paste
    fireEvent.keyDown(window, { key: "v", ctrlKey: true })

    // There should now be two text elements
    const elements = container.querySelectorAll('[data-author="student"]')
    expect(elements.length).toBe(2)
  })
})

describe("storage payload limit handling", () => {
  it("reports board too large error if payload exceeds limit", async () => {
    save.mockRejectedValueOnce({ status: 413, message: "Whiteboard payload exceeds storage limit" })
    const { container, api } = mount()
    act(() => pointer(container.querySelector('[data-element-id="s1"]')!, "pointerdown", 40, 40))
    fireEvent.keyDown(window, { key: "Delete" })
    await act(async () => {
      const ok = await api.current!.flush()
      expect(ok).toBe(false)
    })
    expect(screen.getAllByText(/Board exceeds storage limit/).length).toBeGreaterThan(0)
  })
})


