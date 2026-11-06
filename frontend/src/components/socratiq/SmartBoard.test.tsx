// @vitest-environment jsdom
import { createRef } from "react"
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { at, installDomStubs, pointer } from "@/test/domStubs"
import { EMPTY_BOARD, toWire, fromServer, type Board } from "@/lib/whiteboard"
import { SmartBoard, type Tool } from "./SmartBoard"

const BOARD: Board = {
  ...EMPTY_BOARD,
  nextSeq: 2,
  elements: [
    { id: "s1", kind: "text", author: "student", seq: 0, x: 60, y: 60, w: 300, h: 76, text: "2x + 4 = 10" },
    { id: "c1", kind: "equation", author: "coach", seq: 1, x: 60, y: 200, w: 260, h: 100, latex: "2x = 6" },
  ],
}

beforeEach(() => installDomStubs())
afterEach(cleanup)

const overlay = (c: HTMLElement) => c.querySelector<HTMLElement>('div[style*="crosshair"], div[style*="cursor: text"]')
const run = (fn: () => void) => act(fn)

function mount(tool: Tool, extra: Partial<React.ComponentProps<typeof SmartBoard>> = {}) {
  const onChange = vi.fn()
  const onSelect = vi.fn()
  const onEquationRequest = vi.fn()
  const r = render(<SmartBoard board={BOARD} tool={tool} onChange={onChange} onSelect={onSelect} onEquationRequest={onEquationRequest} {...extra} />)
  return { ...r, onChange, onSelect, onEquationRequest }
}

describe("SmartBoard rendering", () => {
  it("renders text and equations and marks who wrote them", async () => {
    const { container } = mount("select", { readOnly: true })
    expect(screen.getByText("2x + 4 = 10")).toBeTruthy()
    expect(container.querySelector('[data-element-id="s1"]')?.getAttribute("data-author")).toBe("student")
    expect(container.querySelector('[data-element-id="c1"]')?.getAttribute("data-author")).toBe("coach")
    await waitFor(() => expect(container.querySelector('[data-element-id="c1"] .katex')).not.toBeNull())          // KaTeX renders the equation
  })

  it("falls back to the plain source if an equation cannot be rendered", async () => {
    const bad: Board = { ...BOARD, elements: [{ ...BOARD.elements[1], latex: "\\frac{" }] }
    const { container } = render(<SmartBoard board={bad} readOnly />)
    await new Promise((r) => setTimeout(r, 50))
    expect(container.querySelector(".katex")).toBeNull()
    expect(container.textContent).toContain("\\frac{")
  })

  it("reveals coach-written elements in sequence (teaching animation)", () => {
    const { container } = mount("select", { readOnly: true, fresh: new Map([["c1", 2]]) })
    const el = container.querySelector<HTMLElement>('[data-element-id="c1"]')!
    expect(el.className).toContain("sb-appear")
    expect(el.style.animationDelay).toBe("1300ms")
    expect(container.querySelector('[data-element-id="s1"]')!.className).not.toContain("sb-appear")
  })

  it("shows an empty-state hint on an empty editable board and a neutral one in review", () => {
    const { rerender } = render(<SmartBoard board={EMPTY_BOARD} onChange={() => {}} />)
    expect(screen.getByText("Your thinking space")).toBeTruthy()
    rerender(<SmartBoard board={EMPTY_BOARD} readOnly />)
    expect(screen.getByText("Nothing on the board")).toBeTruthy()
  })
})

describe("SmartBoard tools", () => {
  it("select tool: pressing an element selects it", () => {
    const { container, onSelect } = mount("select")
    run(() => pointer(container.querySelector('[data-element-id="s1"]')!, "pointerdown", 40, 40))
    expect(onSelect).toHaveBeenCalledWith("s1")
  })

  it("select tool: dragging moves the element once, on release", () => {
    const { container, onChange } = mount("select")
    const el = container.querySelector('[data-element-id="s1"]')!
    run(() => pointer(el, "pointerdown", ...at(100, 100)))
    run(() => pointer(el, "pointermove", ...at(300, 400)))
    expect(onChange).not.toHaveBeenCalled()                                  // no history entry per mouse move
    run(() => pointer(el, "pointerup", ...at(300, 400)))
    expect(onChange).toHaveBeenCalledTimes(1)
    const moved = onChange.mock.calls[0][0].elements.find((e: { id: string }) => e.id === "s1")
    expect(moved.x).toBe(260)
    expect(moved.y).toBe(360)
    expect(moved.author).toBe("student")
  })

  it("text tool: click, type, Enter adds a student-authored text element", () => {
    const { container, onChange, onSelect } = mount("text")
    run(() => pointer(overlay(container)!, "pointerdown", ...at(500, 500)))
    const box = screen.getByLabelText("Text on the board")
    fireEvent.change(box, { target: { value: "  Subtract 4  " } })
    fireEvent.keyDown(box, { key: "Enter" })
    expect(onChange).toHaveBeenCalledTimes(1)
    const added = onChange.mock.calls[0][0].elements.at(-1)
    expect(added).toMatchObject({ kind: "text", author: "student", text: "Subtract 4", x: 500, y: 500 })
    expect(onSelect).toHaveBeenCalledWith(added.id)
  })

  it("text tool: Escape and blank text add nothing", () => {
    const { container, onChange } = mount("text")
    run(() => pointer(overlay(container)!, "pointerdown", ...at(500, 500)))
    fireEvent.keyDown(screen.getByLabelText("Text on the board"), { key: "Escape" })
    run(() => pointer(overlay(container)!, "pointerdown", ...at(500, 500)))
    fireEvent.change(screen.getByLabelText("Text on the board"), { target: { value: "   " } })
    fireEvent.blur(screen.getByLabelText("Text on the board"))
    expect(onChange).not.toHaveBeenCalled()
  })

  it("equation tool asks the workspace for the equation editor at the clicked spot", () => {
    const { container, onEquationRequest } = mount("equation")
    run(() => pointer(overlay(container)!, "pointerdown", ...at(700, 300)))
    expect(onEquationRequest).toHaveBeenCalledWith({ x: 700, y: 300 })
  })

  it("double-clicking an equation opens it for editing", () => {
    const { container, onEquationRequest } = mount("select")
    fireEvent.doubleClick(container.querySelector('[data-element-id="c1"]')!)
    expect(onEquationRequest).toHaveBeenCalledWith({ x: 60, y: 200 }, "c1")
  })

  it("eraser removes the element under the pointer instead of painting", () => {
    const { container, onChange } = mount("eraser")
    run(() => pointer(overlay(container)!, "pointerdown", ...at(100, 100)))
    expect(onChange.mock.calls[0][0].elements.map((e: { id: string }) => e.id)).toEqual(["c1"])
  })

  it("pen draws a stroke that is stored on release", () => {
    const { container, onChange } = mount("pen")
    const o = overlay(container)!
    run(() => pointer(o, "pointerdown", ...at(900, 900)))
    run(() => pointer(o, "pointermove", ...at(950, 950)))
    run(() => pointer(o, "pointermove", ...at(1100, 1000)))
    run(() => pointer(o, "pointerup", ...at(1100, 1000)))
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange.mock.calls[0][0].strokes).toHaveLength(1)
    expect(onChange.mock.calls[0][0].strokes[0]).toMatchObject({ t: "p" })
  })

  it("pen persists selected color and strokeWidth in saved stroke", () => {
    const { container, onChange } = mount("pen", { currentColor: "#ef4444", strokeWidth: 6 })
    const o = overlay(container)!
    run(() => pointer(o, "pointerdown", ...at(500, 500)))
    run(() => pointer(o, "pointermove", ...at(550, 550)))
    run(() => pointer(o, "pointerup", ...at(550, 550)))
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange.mock.calls[0][0].strokes).toHaveLength(1)
    expect(onChange.mock.calls[0][0].strokes[0]).toMatchObject({
      t: "p",
      w: 6,
      color: "#ef4444",
    })
  })

  it("highlighter persists selected color (red, blue, green, and default yellow) in saved stroke", () => {
    // Red highlighter
    const redMount = mount("highlighter", { currentColor: "#ef4444" })
    let o = overlay(redMount.container)!
    run(() => pointer(o, "pointerdown", ...at(100, 100)))
    run(() => pointer(o, "pointermove", ...at(150, 100)))
    run(() => pointer(o, "pointerup", ...at(150, 100)))
    expect(redMount.onChange).toHaveBeenCalledTimes(1)
    expect(redMount.onChange.mock.calls[0][0].strokes[0]).toMatchObject({
      t: "h",
      color: "#ef4444",
    })

    // Green highlighter
    const greenMount = mount("highlighter", { currentColor: "#22c55e" })
    o = overlay(greenMount.container)!
    run(() => pointer(o, "pointerdown", ...at(200, 100)))
    run(() => pointer(o, "pointermove", ...at(250, 100)))
    run(() => pointer(o, "pointerup", ...at(250, 100)))
    expect(greenMount.onChange).toHaveBeenCalledTimes(1)
    expect(greenMount.onChange.mock.calls[0][0].strokes[0]).toMatchObject({
      t: "h",
      color: "#22c55e",
    })

    // Blue highlighter
    const blueMount = mount("highlighter", { currentColor: "#3b82f6" })
    o = overlay(blueMount.container)!
    run(() => pointer(o, "pointerdown", ...at(300, 100)))
    run(() => pointer(o, "pointermove", ...at(350, 100)))
    run(() => pointer(o, "pointerup", ...at(350, 100)))
    expect(blueMount.onChange).toHaveBeenCalledTimes(1)
    expect(blueMount.onChange.mock.calls[0][0].strokes[0]).toMatchObject({
      t: "h",
      color: "#3b82f6",
    })

    // Default highlighter fallback
    const defaultMount = mount("highlighter", { currentColor: "" })
    o = overlay(defaultMount.container)!
    run(() => pointer(o, "pointerdown", ...at(400, 100)))
    run(() => pointer(o, "pointermove", ...at(450, 100)))
    run(() => pointer(o, "pointerup", ...at(450, 100)))
    expect(defaultMount.onChange).toHaveBeenCalledTimes(1)
    expect(defaultMount.onChange.mock.calls[0][0].strokes[0]).toMatchObject({
      t: "h",
      color: "#facc15",
    })
  })

  it("highlighter colors survive serialization and reload (save/reload)", () => {
    const strokes = [
      { t: "h" as const, w: 6, pts: [[10, 10], [100, 10]] as [number, number][], color: "#ef4444" },
      { t: "h" as const, w: 6, pts: [[10, 50], [100, 50]] as [number, number][], color: "#22c55e" },
      { t: "h" as const, w: 6, pts: [[10, 90], [100, 90]] as [number, number][], color: "#3b82f6" },
      { t: "h" as const, w: 6, pts: [[10, 130], [100, 130]] as [number, number][] }, // backward compatibility: no color field
    ]
    const b = { ...EMPTY_BOARD, strokes }
    const wire = toWire(b)
    expect(wire.strokes[0].color).toBe("#ef4444")
    expect(wire.strokes[1].color).toBe("#22c55e")
    expect(wire.strokes[2].color).toBe("#3b82f6")

    const reloaded = fromServer(wire as any)
    expect(reloaded.strokes[0].color).toBe("#ef4444")
    expect(reloaded.strokes[1].color).toBe("#22c55e")
    expect(reloaded.strokes[2].color).toBe("#3b82f6")
    expect(reloaded.strokes[3].color).toBeUndefined()
  })

  it("text tool: clicking existing text opens it for editing at exact location", () => {
    const existingText = {
      id: "t1",
      kind: "text" as const,
      author: "student" as const,
      seq: 0,
      x: 300,
      y: 400,
      w: 200,
      h: 80,
      text: "Existing Text",
      color: "#2563eb",
    }
    const { container, onChange } = mount("text", {
      board: { ...EMPTY_BOARD, elements: [existingText], nextSeq: 1 },
    })
    run(() => pointer(overlay(container)!, "pointerdown", ...at(350, 420)))
    const box = screen.getByLabelText("Text on the board") as HTMLTextAreaElement
    expect(box).toBeTruthy()
    expect(box.value).toBe("Existing Text")

    fireEvent.change(box, { target: { value: "Updated Text Content" } })
    fireEvent.keyDown(box, { key: "Enter" })
    expect(onChange).toHaveBeenCalledTimes(1)
    const updated = onChange.mock.calls[0][0].elements.find((e: any) => e.id === "t1")
    expect(updated.text).toBe("Updated Text Content")
    expect(updated.x).toBe(300)
    expect(updated.y).toBe(400)
  })

  it("arrow tool: dragging from one element to another creates a LINKED arrow", () => {
    const { container, onChange } = mount("arrow")
    const o = overlay(container)!
    run(() => pointer(o, "pointerdown", ...at(100, 100)))                    // on s1
    run(() => pointer(o, "pointerup", ...at(100, 250)))                      // on c1
    const arrow = onChange.mock.calls[0][0].elements.at(-1)
    expect(arrow).toMatchObject({ kind: "arrow", fromId: "s1", toId: "c1", author: "student" })
  })

  it("arrow tool on empty space makes a free arrow; a tiny drag makes nothing", () => {
    const { container, onChange } = mount("arrow")
    const o = overlay(container)!
    run(() => pointer(o, "pointerdown", ...at(1200, 900)))
    run(() => pointer(o, "pointerup", ...at(1200, 900)))
    expect(onChange).not.toHaveBeenCalled()
    run(() => pointer(o, "pointerdown", ...at(1200, 900)))
    run(() => pointer(o, "pointerup", ...at(1500, 900)))
    expect(onChange.mock.calls[0][0].elements.at(-1)).toMatchObject({ kind: "arrow", x: 1200, y: 900, w: 300, h: 0 })
  })

  it("rectangle tool draws a shape from the drag box", () => {
    const { container, onChange } = mount("rect")
    const o = overlay(container)!
    run(() => pointer(o, "pointerdown", ...at(1000, 600)))
    run(() => pointer(o, "pointerup", ...at(1400, 800)))
    expect(onChange.mock.calls[0][0].elements.at(-1)).toMatchObject({ kind: "shape", shape: "rect", x: 1000, y: 600, w: 400, h: 200 })
  })

  it("read-only and busy boards accept no edits at all", () => {
    for (const extra of [{ readOnly: true }, { busy: true }]) {
      const { container, onChange, unmount } = mount("text", extra)
      expect(overlay(container)).toBeNull()
      run(() => pointer(container.querySelector('[data-element-id="s1"]')!, "pointerdown", 40, 40))
      fireEvent.doubleClick(container.querySelector('[data-element-id="s1"]')!)
      expect(screen.queryByLabelText("Text on the board")).toBeNull()
      expect(onChange).not.toHaveBeenCalled()
      unmount()
    }
  })

  it("select tool: shift-click selects multiple elements and notifies onSelectionChange", () => {
    const onSelectionChange = vi.fn()
    const { container } = mount("select", { onSelectionChange })
    const el1 = container.querySelector('[data-element-id="s1"]')!
    const el2 = container.querySelector('[data-element-id="c1"]')!

    run(() => pointer(el1, "pointerdown", ...at(70, 70)))
    expect(onSelectionChange).toHaveBeenCalledWith(["s1"])

    run(() => {
      el2.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true, clientX: 70 * 0.4, clientY: 210 * 0.4, shiftKey: true }))
    })
    expect(onSelectionChange).toHaveBeenCalledWith(["s1", "c1"])
  })

  it("select tool: drag on empty canvas creates marquee box and selects contained elements", () => {
    const onSelectionChange = vi.fn()
    const { container } = mount("select", { onSelectionChange })
    const stage = container.querySelector('[role="group"]')!

    // Drag marquee box enclosing s1 (at x:60, y:60, w:300, h:76; center is x:210, y:98)
    run(() => pointer(stage, "pointerdown", ...at(40, 40)))
    run(() => pointer(stage, "pointermove", ...at(380, 160)))
    run(() => pointer(stage, "pointerup", ...at(380, 160)))

    expect(onSelectionChange).toHaveBeenCalledWith(["s1"])
  })

  it("exposes getScreenCapture imperative handle", async () => {
    const ref = createRef<any>()
    render(<SmartBoard ref={ref} board={BOARD} readOnly />)
    expect(ref.current).toBeDefined()
    expect(typeof ref.current.getScreenCapture).toBe("function")
  })

  it("select tool: dragging SVG line moves line and preserves offset of both endpoints", () => {
    const boardWithLine: Board = {
      ...BOARD,
      elements: [
        ...BOARD.elements,
        { id: "line1", kind: "line", author: "student", seq: 2, x: 100, y: 100, x2: 250, y2: 300, w: 150, h: 200, color: "#2563eb" },
      ],
    }
    const onChange = vi.fn()
    const { container } = render(<SmartBoard board={boardWithLine} tool="select" onChange={onChange} />)
    const lineEl = container.querySelector('line[stroke="transparent"]')!
    expect(lineEl).not.toBeNull()

    run(() => pointer(lineEl as HTMLElement, "pointerdown", ...at(100, 100)))
    run(() => pointer(lineEl as HTMLElement, "pointermove", ...at(200, 150)))
    run(() => pointer(lineEl as HTMLElement, "pointerup", ...at(200, 150)))

    expect(onChange).toHaveBeenCalledTimes(1)
    const moved = onChange.mock.calls[0][0].elements.find((e: { id: string }) => e.id === "line1")
    expect(moved.x).toBe(200)
    expect(moved.y).toBe(150)
    expect(moved.x2).toBe(350)
    expect(moved.y2).toBe(350)
  })

  it("select tool: dragging SVG triangle moves triangle smoothly", () => {
    const boardWithTri: Board = {
      ...BOARD,
      elements: [
        ...BOARD.elements,
        { id: "tri1", kind: "triangle", shape: "triangle", author: "student", seq: 3, x: 200, y: 200, w: 100, h: 100, color: "#10b981" },
      ],
    }
    const onChange = vi.fn()
    const { container } = render(<SmartBoard board={boardWithTri} tool="select" onChange={onChange} />)
    const triEl = container.querySelector("polygon")!
    expect(triEl).not.toBeNull()

    run(() => pointer(triEl as unknown as HTMLElement, "pointerdown", ...at(200, 200)))
    run(() => pointer(triEl as unknown as HTMLElement, "pointermove", ...at(350, 300)))
    run(() => pointer(triEl as unknown as HTMLElement, "pointerup", ...at(350, 300)))

    expect(onChange).toHaveBeenCalledTimes(1)
    const moved = onChange.mock.calls[0][0].elements.find((e: { id: string }) => e.id === "tri1")
    expect(moved.x).toBe(350)
    expect(moved.y).toBe(300)
  })

  it("text editing: editing an existing colored text element preserves its color", () => {
    const boardWithColoredText: Board = {
      ...BOARD,
      elements: [
        { id: "red-text", kind: "text", author: "student", seq: 5, x: 200, y: 200, w: 200, h: 50, text: "Original", color: "#dc2626" },
      ],
    }
    const onChange = vi.fn()
    const { container } = render(<SmartBoard board={boardWithColoredText} tool="select" currentColor="#000000" onChange={onChange} />)
    const textNode = container.querySelector('[data-element-id="red-text"]')!
    fireEvent.doubleClick(textNode)

    const textarea = screen.getByLabelText("Text on the board")
    expect(textarea.style.color).toBe("rgb(220, 38, 38)") // #dc2626
    fireEvent.change(textarea, { target: { value: "Updated" } })
    fireEvent.keyDown(textarea, { key: "Enter" })

    expect(onChange).toHaveBeenCalledTimes(1)
    const updated = onChange.mock.calls[0][0].elements.find((e: { id: string }) => e.id === "red-text")
    expect(updated.text).toBe("Updated")
    expect(updated.color).toBe("#dc2626")
  })
})
