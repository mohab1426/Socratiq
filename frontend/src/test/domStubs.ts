import { vi } from "vitest"

/** jsdom has no canvas, ResizeObserver, pointer capture or Element.scrollTo. These stubs let component tests mount the board. */
export function installDomStubs() {
  const ctx = new Proxy({}, { get: (_t, p) => (p === "canvas" ? undefined : vi.fn()), set: () => true })
  HTMLCanvasElement.prototype.getContext = (() => ctx) as unknown as typeof HTMLCanvasElement.prototype.getContext
  class RO { observe() {} unobserve() {} disconnect() {} }
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = RO
  if (typeof (globalThis as any).PointerEvent === "undefined") {
    class PointerEvent extends MouseEvent {
      pointerId: number
      pointerType: string
      constructor(type: string, params: any = {}) {
        super(type, params)
        this.pointerId = params.pointerId ?? 0
        this.pointerType = params.pointerType ?? ""
      }
    }
    ;(globalThis as any).PointerEvent = PointerEvent
    if (typeof window !== "undefined") {
      ;(window as any).PointerEvent = PointerEvent
    }
  }
  Element.prototype.setPointerCapture = () => {}
  Element.prototype.releasePointerCapture = () => {}
  Element.prototype.scrollTo = (() => {}) as unknown as typeof Element.prototype.scrollTo
}

/** Dispatch a pointer event with coordinates (jsdom's PointerEvent support is partial; React reads clientX/clientY from the native event). */
export function pointer(el: Element, type: "pointerdown" | "pointermove" | "pointerup", x = 0, y = 0) {
  el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y }))
}

/** Stage coordinates -> client coordinates for the default test scale (0.4, no layout in jsdom). */
export const at = (x: number, y: number): [number, number] => [x * 0.4, y * 0.4]
