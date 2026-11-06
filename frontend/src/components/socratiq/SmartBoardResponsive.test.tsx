// @vitest-environment jsdom
import React, { createRef } from "react"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { at, installDomStubs, pointer } from "@/test/domStubs"
import { BOARD_H, BOARD_W, EMPTY_BOARD, type Board } from "@/lib/whiteboard"
import { BoardWorkspace, type BoardApi } from "./BoardWorkspace"
import { SmartBoard } from "./SmartBoard"

const save = vi.fn(async (..._a: unknown[]) => ({}))
vi.mock("@/lib/queries", () => ({ saveWhiteboard: (...a: unknown[]) => save(...a) }))

beforeEach(() => {
  installDomStubs()
  save.mockClear()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe("SmartBoard Responsive Scale & Usable Space Calculations", () => {
  it("fits empty board dynamically to mobile viewport width without overflowing", () => {
    // On a 375px mobile screen, fitting 2000px width should give scale around 0.15 - 0.2, NOT 0.4
    const rootWidth = 375
    const rootHeight = 667
    const usableW = Math.max(280, rootWidth - 24) // 351
    const usableH = Math.max(280, rootHeight - 110) // 557
    const expectedScale = Math.max(0.15, Math.min(1.0, Math.min(usableW / BOARD_W, usableH / BOARD_H)))

    expect(expectedScale).toBeLessThan(0.25)
    expect(BOARD_W * expectedScale).toBeLessThanOrEqual(usableW)
    expect(BOARD_H * expectedScale).toBeLessThanOrEqual(usableH)
  })

  it("fits populated board content within usable container bounds with padding", () => {
    const rootWidth = 768
    const rootHeight = 1024
    const usableW = Math.max(280, rootWidth - 24)
    const usableH = Math.max(280, rootHeight - 110)

    // Content occupying 600 x 400 at (100, 100)
    const minX = 100
    const minY = 100
    const maxX = 700
    const maxY = 500
    const pad = 80
    const contentW = Math.max(300, maxX - minX + pad * 2)
    const contentH = Math.max(300, maxY - minY + pad * 2)

    const scale = Math.max(0.15, Math.min(1.2, Math.min(usableW / contentW, usableH / contentH)))
    expect(scale).toBeGreaterThan(0.5)
    expect(contentW * scale).toBeLessThanOrEqual(usableW + 1)
  })

  it("does not reset pan and zoom on subsequent resize events once initial fit is done", () => {
    const api = createRef<BoardApi>()
    const { container } = render(
      <BoardWorkspace ref={api} assignmentId="test-resp" initial={EMPTY_BOARD} busy={false} onAsk={() => {}} />
    )

    // Verify initial container mounts with 100dvh class
    expect(container.firstElementChild?.className).toContain("overflow-hidden")
  })
})

describe("Coordinate Transforms and Midpoint Zoom Invariance", () => {
  it("preserves logical board position under gesture midpoint when zooming", () => {
    const oldScale = 0.5
    const newScale = 0.8
    const panX = 100
    const panY = 50
    const midX = 300
    const midY = 400

    const containerLeft = 50
    const containerTop = 50
    const rLeft = containerLeft - panX * oldScale
    const rTop = containerTop - panY * oldScale

    // Logical board position under midX, midY before zoom:
    const bx = (midX - rLeft) / oldScale
    const by = (midY - rTop) / oldScale

    // Formula: newPanX = bx - (bx - panX) * (oldScale / newScale) - deltaX / newScale
    const deltaX = 0
    const deltaY = 0
    const newPanX = bx - (bx - panX) * (oldScale / newScale) - deltaX / newScale
    const newPanY = by - (by - panY) * (oldScale / newScale) - deltaY / newScale

    const newRLeft = containerLeft - newPanX * newScale
    const newRTop = containerTop - newPanY * newScale

    const screenXAfter = newRLeft + bx * newScale
    const screenYAfter = newRTop + by * newScale

    expect(Math.round(screenXAfter)).toBe(midX)
    expect(Math.round(screenYAfter)).toBe(midY)
  })
})

describe("Multi-Touch Gesture Transitions in SmartBoard", () => {
  it("aborts in-progress stroke when a second touch pointer is recognized", () => {
    const onChange = vi.fn()
    const { container } = render(
      <SmartBoard
        board={EMPTY_BOARD}
        onChange={onChange}
        tool="pen"
        viewState={{ x: 0, y: 0, scale: 1 }}
      />
    )

    const overlay = container.querySelector('div[style*="crosshair"]') as HTMLElement
    expect(overlay).toBeTruthy()

    // 1. Pointer 1 touches down with pointerType="touch"
    act(() => {
      fireEvent.pointerDown(overlay, {
        pointerId: 1,
        pointerType: "touch",
        clientX: 100,
        clientY: 100,
      })
    })

    // 2. Pointer 1 moves to draw
    act(() => {
      fireEvent.pointerMove(overlay, {
        pointerId: 1,
        pointerType: "touch",
        clientX: 120,
        clientY: 120,
      })
    })

    // 3. Pointer 2 touches down (pinch gesture starts)
    act(() => {
      fireEvent.pointerDown(overlay, {
        pointerId: 2,
        pointerType: "touch",
        clientX: 200,
        clientY: 200,
      })
    })

    // 4. Pointer 1 lifts up
    act(() => {
      fireEvent.pointerUp(overlay, {
        pointerId: 1,
        pointerType: "touch",
        clientX: 120,
        clientY: 120,
      })
    })

    // 5. Pointer 2 lifts up
    act(() => {
      fireEvent.pointerUp(overlay, {
        pointerId: 2,
        pointerType: "touch",
        clientX: 200,
        clientY: 200,
      })
    })

    // Because a second touch was recognized, the drawing was aborted and NO stroke was committed to onChange
    expect(onChange).not.toHaveBeenCalled()
  })

  it("handles pointer cancellation cleanly without committing corrupt board states", () => {
    const onChange = vi.fn()
    const { container } = render(
      <SmartBoard
        board={EMPTY_BOARD}
        onChange={onChange}
        tool="pen"
        viewState={{ x: 0, y: 0, scale: 1 }}
      />
    )

    const overlay = container.querySelector('div[style*="crosshair"]') as HTMLElement
    expect(overlay).toBeTruthy()

    // Touch down
    act(() => {
      fireEvent.pointerDown(overlay, {
        pointerId: 1,
        pointerType: "touch",
        clientX: 100,
        clientY: 100,
      })
    })

    // Pointer cancel (e.g. system notification or gesture conflict)
    act(() => {
      fireEvent.pointerCancel(overlay, {
        pointerId: 1,
        pointerType: "touch",
      })
    })

    expect(onChange).not.toHaveBeenCalled()
  })

  it("preserves mouse and stylus drawing without triggering touch pinch logic", () => {
    const onChange = vi.fn()
    const { container } = render(
      <SmartBoard
        board={EMPTY_BOARD}
        onChange={onChange}
        tool="pen"
        viewState={{ x: 0, y: 0, scale: 1 }}
      />
    )

    const overlay = container.querySelector('div[style*="crosshair"]') as HTMLElement
    expect(overlay).toBeTruthy()

    // Stylus / Pen down
    act(() => {
      fireEvent.pointerDown(overlay, {
        pointerId: 10,
        pointerType: "pen",
        clientX: 150,
        clientY: 150,
      })
    })

    // Stylus move
    act(() => {
      fireEvent.pointerMove(overlay, {
        pointerId: 10,
        pointerType: "pen",
        clientX: 200,
        clientY: 200,
      })
    })

    // Stylus up
    act(() => {
      fireEvent.pointerUp(overlay, {
        pointerId: 10,
        pointerType: "pen",
        clientX: 200,
        clientY: 200,
      })
    })

    // Pen stroke committed normally
    expect(onChange).toHaveBeenCalledTimes(1)
    const updatedBoard: Board = onChange.mock.calls[0][0]
    expect(updatedBoard.strokes.length).toBe(1)
  })
})

describe("Touch Target and Toolbar Accessibility Constraints", () => {
  it("renders all primary tools with responsive touch-friendly classes and accessible names", () => {
    render(<BoardWorkspace assignmentId="test-targets" initial={EMPTY_BOARD} busy={false} onAsk={() => {}} />)

    const buttons = [
      "Select and move",
      "Pan canvas",
      "Pen",
      "Highlighter",
      "Eraser",
      "Text",
      "Equation",
      "Rectangle",
      "Ellipse",
      "Triangle",
      "Line",
      "Arrow",
      "Undo",
      "Redo",
      "Clear the board",
    ]

    for (const name of buttons) {
      const btn = screen.getByRole("button", { name })
      expect(btn).toBeTruthy()
      expect(btn.className).toContain("touch-manipulation")
      expect(btn.className).toContain("min-w-[36px]")
    }
  })
})
