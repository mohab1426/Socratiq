// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { installDomStubs } from "@/test/domStubs"
import { EMPTY_BOARD } from "@/lib/whiteboard"

const mocks = vi.hoisted(() => ({
  saveWhiteboard: vi.fn(async (..._a: any[]) => ({})),
  sendChatProxy: vi.fn(),
  generateImageContent: vi.fn(async () => null as string | null),
  generateSimulationCode: vi.fn(async () => null as string | null),
  generateVectorDrawing: vi.fn(async () => null as any[] | null),
}))
vi.mock("@/lib/queries", () => ({ saveWhiteboard: mocks.saveWhiteboard }))
vi.mock("@/lib/geminiSmartBoardService", async (orig) => ({
  ...(await orig<any>()),
  sendChatProxy: mocks.sendChatProxy,
  generateImageContent: mocks.generateImageContent,
  generateSimulationCode: mocks.generateSimulationCode,
  generateVectorDrawing: mocks.generateVectorDrawing,
}))
import { BoardWorkspace } from "./BoardWorkspace"

beforeEach(() => {
  installDomStubs(); vi.clearAllMocks()
  Element.prototype.scrollIntoView = vi.fn() // jsdom has no scrollIntoView; the chat auto-scrolls
  // getScreenCapture() waits for an <img> built from an SVG data URL to load, which jsdom never does.
  class FakeImage { onload: (() => void) | null = null; onerror: (() => void) | null = null; width = 1; height = 1
    set src(_v: string) { queueMicrotask(() => this.onload?.()) } }
  vi.stubGlobal("Image", FakeImage)
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const mount = () => render(<BoardWorkspace assignmentId="A" initial={EMPTY_BOARD} busy={false} onAsk={() => {}} />)
const pressed = (name: string) => screen.getByRole("button", { name }).getAttribute("aria-pressed") === "true"
const askAI = async (calls: any[]) => {
  mocks.sendChatProxy.mockResolvedValueOnce({ text: "", functionCalls: calls })
  const input = screen.getByPlaceholderText(/Ask Gemini/i)
  fireEvent.change(input, { target: { value: "do it" } })
  fireEvent.click(screen.getByRole("button", { name: "Send to SmartBoard" }))
}
const lastSavedCoach = () => {
  const call = mocks.saveWhiteboard.mock.calls.at(-1)
  return call ? (call[1] as any).elements.filter((e: any) => e.author === "coach") : []
}

describe("keyboard shortcuts match the toolbar tooltips", () => {
  it.each([["r", "Rectangle"], ["o", "Ellipse"], ["l", "Line"], ["a", "Arrow"], ["p", "Pen"], ["e", "Eraser"], ["t", "Text"], ["h", "Pan canvas"]])("%s selects %s", (key, label) => {
    mount()
    fireEvent.keyDown(window, { key })
    expect(pressed(label)).toBe(true)
  })
  it("modified keys (Ctrl+P, Ctrl+E, Alt+R) never switch tools", () => {
    mount()
    expect(pressed("Select and move")).toBe(true)
    for (const init of [{ key: "p", ctrlKey: true }, { key: "e", ctrlKey: true }, { key: "r", altKey: true }, { key: "t", metaKey: true }]) fireEvent.keyDown(window, init)
    expect(pressed("Select and move")).toBe(true)
  })
  it("ignores shortcuts while typing in the chat box", () => {
    mount()
    fireEvent.keyDown(screen.getByPlaceholderText(/Ask Gemini/i), { key: "r" })
    expect(pressed("Select and move")).toBe(true)
  })
})

describe("AI generation failures are reported, not swallowed", () => {
  it.each([
    ["generate_image", { prompt: "cat", x: 300, y: 300 }, "image"],
    ["generate_simulation", { title: "S", prompt: "x", x: 300, y: 300 }, "simulation"],
    ["generate_vector_drawing", { prompt: "x", x: 300, y: 300 }, "diagram"],
  ])("%s failure shows an error and leaves no loading placeholder", async (name, args, what) => {
    mount()
    await askAI([{ name, args }])
    expect(await screen.findByText(new RegExp(`Couldn't generate the ${what}`))).toBeTruthy()
    // Let the 1.2s autosave window pass. Image/simulation add then remove a placeholder; the diagram
    // path adds none and so may never save. Either way nothing coach-authored may be left behind.
    await new Promise((r) => setTimeout(r, 1600))
    expect(lastSavedCoach()).toHaveLength(0)
  })

  it("a chat API error is shown in the chat", async () => {
    mount()
    mocks.sendChatProxy.mockResolvedValueOnce({ error: "model overloaded" })
    const input = screen.getByPlaceholderText(/Ask Gemini/i)
    fireEvent.change(input, { target: { value: "hi" } }); fireEvent.click(screen.getByRole("button", { name: "Send to SmartBoard" }))
    expect(await screen.findByText(/model overloaded/)).toBeTruthy()
  })

  it("a successful image generation still produces an image element", async () => {
    mocks.generateImageContent.mockResolvedValueOnce("data:image/png;base64,AAAA")
    mount()
    await askAI([{ name: "generate_image", args: { prompt: "cat", x: 300, y: 300 } }])
    await waitFor(() => expect(mocks.saveWhiteboard).toHaveBeenCalled(), { timeout: 4000 })
    await waitFor(() => expect(lastSavedCoach().some((e: any) => e.kind === "image")).toBe(true), { timeout: 4000 })
    expect(screen.queryByText(/Couldn't generate/)).toBeNull()
  })
})
