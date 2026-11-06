/**
 * Test environment for code that imports `@excalidraw/excalidraw` under jsdom.
 *
 * jsdom has no canvas. Excalidraw touches `getContext("2d")` at import time and uses `measureText` to size text, so we install a
 * deterministic 2D-context stub BEFORE the library is imported (import this module first in a test file).
 * Text width is a fixed 0.6 em per character, which is close to Excalidraw's own fonts and makes sizes reproducible.
 *
 * This validates element construction and geometry. It does NOT validate real pointer interaction or rendering: that needs a browser.
 */
export const CHAR_EM = 0.6

function makeContext(canvas: unknown): Record<string, unknown> {
  let font = "20px Virgil"
  const px = () => Number(/(\d+(?:\.\d+)?)px/.exec(font)?.[1] ?? 20)
  const noop = () => undefined
  const target: Record<string, unknown> = {
    canvas, filter: "none", fillStyle: "#000", strokeStyle: "#000", lineWidth: 1, globalAlpha: 1, textAlign: "left", textBaseline: "alphabetic",
    get font() { return font }, set font(v: string) { font = v },
    measureText: (text: string) => {
      const size = px()
      const lines = String(text).split("\n")
      const w = Math.max(0, ...lines.map((l) => l.length)) * size * CHAR_EM
      return { width: w, actualBoundingBoxAscent: size * 0.8, actualBoundingBoxDescent: size * 0.2, actualBoundingBoxLeft: 0, actualBoundingBoxRight: w, fontBoundingBoxAscent: size * 0.9, fontBoundingBoxDescent: size * 0.25 }
    },
    createLinearGradient: () => ({ addColorStop: noop }), createPattern: () => null, getImageData: () => ({ data: new Uint8ClampedArray(4) }),
  }
  return new Proxy(target, { get: (t, p) => (p in t ? t[p as string] : noop), set: (t, p, v) => { t[p as string] = v; return true }, has: () => true })
}

if (typeof HTMLCanvasElement !== "undefined") {
  const contexts = new WeakMap<object, Record<string, unknown>>()
  HTMLCanvasElement.prototype.getContext = (function (this: HTMLCanvasElement) {
    let c = contexts.get(this)
    if (!c) { c = makeContext(this); contexts.set(this, c) }
    return c
  }) as unknown as typeof HTMLCanvasElement.prototype.getContext
}
if (typeof (globalThis as { ResizeObserver?: unknown }).ResizeObserver === "undefined") {
  ;(globalThis as { ResizeObserver: unknown }).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
}
if (typeof (globalThis as { matchMedia?: unknown }).matchMedia === "undefined" && typeof window !== "undefined") {
  ;(window as unknown as { matchMedia: unknown }).matchMedia = (q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })
}
if (typeof (globalThis as { FontFace?: unknown }).FontFace === "undefined") {
  ;(globalThis as { FontFace: unknown }).FontFace = class { family: string; source: unknown; descriptors?: unknown; constructor(family: string, source: unknown, descriptors?: unknown) { this.family = family; this.source = source; this.descriptors = descriptors } load() { return Promise.resolve(this) } }
}
if (typeof document !== "undefined" && !(document as { fonts?: unknown }).fonts) {
  Object.defineProperty(document, "fonts", { configurable: true, value: { add() {}, delete() {}, has: () => true, check: () => true, ready: Promise.resolve(), load: () => Promise.resolve([]), forEach() {}, [Symbol.iterator]: function* () {} } })
}
if (typeof (globalThis as { Path2D?: unknown }).Path2D === "undefined") {
  ;(globalThis as { Path2D: unknown }).Path2D = class { addPath() {} moveTo() {} lineTo() {} bezierCurveTo() {} quadraticCurveTo() {} arc() {} rect() {} closePath() {} }
}
