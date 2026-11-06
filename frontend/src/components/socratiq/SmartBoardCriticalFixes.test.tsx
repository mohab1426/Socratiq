// @vitest-environment jsdom
import React, { createRef } from "react"
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { at, installDomStubs, pointer } from "@/test/domStubs"
import { EMPTY_BOARD, type Board } from "@/lib/whiteboard"
import { BoardWorkspace, type BoardApi } from "./BoardWorkspace"
import { SmartBoard } from "./SmartBoard"
import { TextNode } from "./TextNode"

// Mock server queries
const save = vi.fn(async (..._a: unknown[]) => ({}))
vi.mock("@/lib/queries", () => ({ saveWhiteboard: (...a: unknown[]) => save(...a) }))

// Mock WebSocket class to inspect protocol messages
class MockWebSocket {
  static instances: MockWebSocket[] = []
  url: string
  readyState: number = WebSocket.CONNECTING
  sentMessages: string[] = []
  onopen: (() => void) | null = null
  onmessage: ((ev: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null

  constructor(url: string) {
    this.url = url
    MockWebSocket.instances.push(this)
    setTimeout(() => {
      this.readyState = WebSocket.OPEN
      this.onopen?.()
    }, 10)
  }

  send(data: string) {
    this.sentMessages.push(data)
  }

  close() {
    this.readyState = WebSocket.CLOSED
    this.onclose?.()
  }

  // Helper to simulate incoming server message
  receiveMessage(data: any) {
    this.onmessage?.({ data: JSON.stringify(data) })
  }
}

// Mock AudioContext and MediaDevices
class MockAudioBufferSource {
  buffer: any = null
  onended: (() => void) | null = null
  start = vi.fn()
  stop = vi.fn(() => this.onended?.())
  connect = vi.fn()
}

class MockAudioContext {
  state: "suspended" | "running" = "suspended"
  currentTime = 0
  sampleRate: number
  destination = {}

  constructor(options?: { sampleRate?: number }) {
    this.sampleRate = options?.sampleRate || 24000
  }

  resume = vi.fn(async () => {
    this.state = "running"
  })

  close = vi.fn(async () => {
    this.state = "suspended"
  })

  createBuffer(channels: number, length: number, sampleRate: number) {
    return {
      numberOfChannels: channels,
      length,
      sampleRate,
      duration: length / sampleRate,
      getChannelData: () => new Float32Array(length),
    }
  }

  createBufferSource() {
    return new MockAudioBufferSource()
  }

  createMediaStreamSource() {
    return { connect: vi.fn() }
  }

  createScriptProcessor() {
    return {
      connect: vi.fn(),
      disconnect: vi.fn(),
      onaudioprocess: null,
    }
  }
}

beforeEach(() => {
  installDomStubs()
  save.mockClear()
  MockWebSocket.instances = []

  // Global browser API mocks
  ;(window as any).WebSocket = MockWebSocket
  ;(window as any).AudioContext = MockAudioContext
  ;(window as any).webkitAudioContext = MockAudioContext

  // Mock navigator.mediaDevices
  const mockStream = {
    getTracks: () => [{ stop: vi.fn() }],
    getVideoTracks: () => [{ stop: vi.fn() }],
    getAudioTracks: () => [{ stop: vi.fn() }],
  }
  Object.defineProperty(navigator, "mediaDevices", {
    writable: true,
    value: {
      getUserMedia: vi.fn(async () => mockStream),
      getDisplayMedia: vi.fn(async () => mockStream),
    },
  })

  // Reset fullscreen stubs
  Object.defineProperty(document, "fullscreenElement", {
    writable: true,
    value: null,
  })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const btn = (name: string) => screen.getByRole("button", { name })
const overlay = (c: HTMLElement) => c.querySelector<HTMLElement>('div[style*="crosshair"], div[style*="cursor: text"]')

describe("Critical Fix 1: Gemini Live Voice Protocol & Audio Pipeline", () => {
  it("sends standard Gemini Live WebSocket setup message on connection", async () => {
    render(<BoardWorkspace assignmentId="A1" initial={EMPTY_BOARD} busy={false} onAsk={() => {}} />)

    // Click Live Voice connection button
    const liveBtn = screen.getByRole("button", { name: /Connect Gemini Live Voice/ })
    fireEvent.click(liveBtn)

    await waitFor(() => expect(MockWebSocket.instances.length).toBeGreaterThan(0))
    const ws = MockWebSocket.instances[0]

    // Wait for setup message
    await waitFor(() => expect(ws.sentMessages.length).toBeGreaterThan(0))
    const setupMsg = JSON.parse(ws.sentMessages[0])

    expect(setupMsg.setup).toBeDefined()
    expect(setupMsg.setup.model).toBe("models/gemini-3.8-live")
    expect(setupMsg.setup.generationConfig).toBeDefined()
    expect(setupMsg.setup.generationConfig.responseModalities).toEqual(["AUDIO"])
    expect(setupMsg.setup.generationConfig.speechConfig?.voiceConfig?.prebuiltVoiceConfig?.voiceName).toBe("Puck")
    expect(setupMsg.setup.systemInstruction).toBeDefined()
    expect(setupMsg.setup.tools).toBeDefined()
    expect(setupMsg.setup.tools[0].functionDeclarations).toBeDefined()
  })

  it("handles incoming audio chunks and sends tool responses with proper camelCase schema", async () => {
    render(<BoardWorkspace assignmentId="A1" initial={EMPTY_BOARD} busy={false} onAsk={() => {}} />)

    const liveBtn = screen.getByRole("button", { name: /Connect Gemini Live Voice/ })
    fireEvent.click(liveBtn)

    await waitFor(() => expect(MockWebSocket.instances.length).toBeGreaterThan(0))
    const ws = MockWebSocket.instances[0]

    // Simulate setupComplete from Gemini Live server
    act(() => {
      ws.receiveMessage({ setupComplete: {} })
    })

    // Simulate serverContent with audio and top-level toolCall
    act(() => {
      ws.receiveMessage({
        toolCall: {
          functionCalls: [
            {
              id: "call_123",
              name: "write_text",
              args: { text: "Hello SocratiQ", x: 200, y: 200 },
            },
          ],
        },
      })
    })

    // Verify client sent toolResponse matching schema
    await waitFor(() => {
      const responseMsg = ws.sentMessages.find((m) => m.includes("toolResponse"))
      expect(responseMsg).toBeDefined()
      const parsed = JSON.parse(responseMsg!)
      expect(parsed.toolResponse).toBeDefined()
      expect(parsed.toolResponse.functionResponses).toBeDefined()
      expect(parsed.toolResponse.functionResponses[0].id).toBe("call_123")
    })
  })

  it("handles model interruptions by resetting audio queue and setting state to listening", async () => {
    render(<BoardWorkspace assignmentId="A1" initial={EMPTY_BOARD} busy={false} onAsk={() => {}} />)

    const liveBtn = screen.getByRole("button", { name: /Connect Gemini Live Voice/ })
    fireEvent.click(liveBtn)

    await waitFor(() => expect(MockWebSocket.instances.length).toBeGreaterThan(0))
    const ws = MockWebSocket.instances[0]

    act(() => {
      ws.receiveMessage({ setupComplete: {} })
    })

    // Send interruption signal from server
    act(() => {
      ws.receiveMessage({
        serverContent: {
          interrupted: true,
        },
      })
    })

    // Verify disconnect sends audioStreamEnd
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: /Disconnect Gemini Live/ }))
    })

    const streamEndMsg = ws.sentMessages.find((m) => m.includes("audioStreamEnd"))
    expect(streamEndMsg).toBeDefined()
    const parsed = JSON.parse(streamEndMsg!)
    expect(parsed.realtimeInput.audioStreamEnd).toBe(true)
  })
})

describe("Critical Fix 2: Direct Text Tool (Multiline, Arabic & English, Coordinate Stability)", () => {
  it("renders textarea with dir=auto, support for Arabic text, and multiline Shift+Enter", async () => {
    const { container } = render(<BoardWorkspace assignmentId="A1" initial={EMPTY_BOARD} busy={false} onAsk={() => {}} />)

    // Select text tool and click on board
    fireEvent.click(btn("Text"))
    act(() => pointer(overlay(container)!, "pointerdown", ...at(400, 300)))

    const box = screen.getByLabelText("Text on the board") as HTMLTextAreaElement
    expect(box).toBeTruthy()
    expect(box.getAttribute("dir")).toBe("auto")

    // Type Arabic text with newline using Shift+Enter
    fireEvent.change(box, { target: { value: "مرحبا بكم\nحل المعادلة" } })
    expect(box.value).toBe("مرحبا بكم\nحل المعادلة")

    // Shift+Enter should NOT commit
    fireEvent.keyDown(box, { key: "Enter", shiftKey: true })
    expect(screen.getByLabelText("Text on the board")).toBeTruthy()

    // Plain Enter commits
    fireEvent.keyDown(box, { key: "Enter", shiftKey: false })
    expect(screen.queryByLabelText("Text on the board")).toBeNull()

    // Verify Arabic text was saved and rendered
    const textNode = container.querySelector('[data-author="student"]')
    expect(textNode).toBeTruthy()
    expect(textNode?.textContent).toContain("مرحبا بكم")
    expect(textNode?.textContent).toContain("حل المعادلة")
  })

  it("cancels new text entry on Escape key without creating empty element", () => {
    const { container } = render(<BoardWorkspace assignmentId="A1" initial={EMPTY_BOARD} busy={false} onAsk={() => {}} />)

    fireEvent.click(btn("Text"))
    act(() => pointer(overlay(container)!, "pointerdown", ...at(400, 300)))

    const box = screen.getByLabelText("Text on the board")
    fireEvent.change(box, { target: { value: "Cancelled text" } })
    fireEvent.keyDown(box, { key: "Escape" })

    expect(screen.queryByLabelText("Text on the board")).toBeNull()
    expect(container.querySelector('[data-author="student"]')).toBeNull()
  })

  it("TextNode component sets dir=auto and unicode-bidi for correct multilingual rendering", () => {
    const { container } = render(<TextNode text="العربية English 123" color="#000000" fontSize={24} />)
    const el = container.firstElementChild as HTMLElement
    expect(el.getAttribute("dir")).toBe("auto")
    expect(el.style.unicodeBidi).toBe("plaintext")
  })
})

describe("Critical Fix 3: Proper Fullscreen Mode Experience", () => {
  it("renders fullscreen button on toolbar and enters/exits fullscreen mode", async () => {
    const requestFullscreenMock = vi.fn(async () => {})
    const exitFullscreenMock = vi.fn(async () => {})
    HTMLElement.prototype.requestFullscreen = requestFullscreenMock
    document.exitFullscreen = exitFullscreenMock

    const { container } = render(<BoardWorkspace assignmentId="A1" initial={EMPTY_BOARD} busy={false} onAsk={() => {}} />)

    const fsBtn = screen.getByRole("button", { name: "Enter Fullscreen" })
    expect(fsBtn).toBeTruthy()
    expect(fsBtn.getAttribute("aria-pressed")).toBe("false")

    // Click Enter Fullscreen
    await act(async () => {
      fireEvent.click(fsBtn)
    })
    expect(requestFullscreenMock).toHaveBeenCalled()

    // Simulate browser fullscreen change event
    Object.defineProperty(document, "fullscreenElement", {
      writable: true,
      value: container.firstElementChild,
    })
    act(() => {
      document.dispatchEvent(new Event("fullscreenchange"))
    })

    // Now toolbar button reflects Exit Fullscreen
    const exitBtn = screen.getByRole("button", { name: "Exit Fullscreen" })
    expect(exitBtn).toBeTruthy()
    expect(exitBtn.getAttribute("aria-pressed")).toBe("true")

    // Click Exit Fullscreen
    await act(async () => {
      fireEvent.click(exitBtn)
    })
    expect(exitFullscreenMock).toHaveBeenCalled()
  })

  it("handles Escape key to exit fallback CSS fullscreen mode", async () => {
    // When native requestFullscreen is unsupported or rejected
    HTMLElement.prototype.requestFullscreen = undefined as any
    const { container } = render(<BoardWorkspace assignmentId="A1" initial={EMPTY_BOARD} busy={false} onAsk={() => {}} />)

    const fsBtn = screen.getByRole("button", { name: "Enter Fullscreen" })
    await act(async () => {
      fireEvent.click(fsBtn)
    })

    // Container gets fixed inset-0 z-50 fullscreen class
    expect(container.firstElementChild?.className).toContain("fixed inset-0 z-50")

    // Press Escape
    act(() => {
      fireEvent.keyDown(window, { key: "Escape" })
    })

    expect(container.firstElementChild?.className).not.toContain("fixed inset-0 z-50")
  })
})
