/**
 * Whiteboard data model. Mirrors the backend (`ai/whiteboard/models.py`, `backend/app/schemas.py::WhiteboardIn`).
 * The API client camelizes responses (fromId, toId, nextSeq) but the server expects snake_case on save: use `toWire`.
 * Logical stage: 2000 x 1200 units; the UI scales it to fit.
 */
export type Color = "yellow" | "green" | "red" | "blue" | string
export type Author = "student" | "coach"
export type ElementKind = "text" | "equation" | "shape" | "arrow" | "line" | "circle" | "triangle" | "image" | "simulation" | "path"
export type TextStyle = "plain" | "title" | "definition" | "note" | "step"

export interface Stroke { t: "p" | "e" | "h"; w: number; pts: [number, number][]; color?: string }   // pen / eraser / highlighter
export interface BoardElement {
  id: string
  kind: ElementKind
  author: Author
  seq: number
  x: number
  y: number
  w: number
  h: number
  text?: string
  latex?: string
  style?: TextStyle
  color?: Color
  highlight?: Color
  fromId?: string
  toId?: string
  shape?: "rect" | "ellipse" | "triangle" | "circle" | string
  around?: string
  // SmartBoard element properties
  rotation?: number
  filled?: boolean
  strokeWidth?: number
  x2?: number
  y2?: number
  points?: [number, number][] | { x: number; y: number }[]
  pathData?: string
  src?: string
  code?: string
  title?: string
  fontSize?: number
  isLoading?: boolean
}
export interface Board {
  steps: string[]; strokes: Stroke[]; elements: BoardElement[]; nextSeq: number
  /** Native (Excalidraw) scene, when the student has one. Opaque here: see lib/smartboard/scene.ts. Absent on legacy boards. */
  scene?: Record<string, unknown> | null
}
export interface BoardReport { applied: { action: string; id: string }[]; rejected: { action: string; reason: string }[] }

export const EMPTY_BOARD: Board = { steps: [], strokes: [], elements: [], nextSeq: 0 }
export const BOARD_W = 2000
export const BOARD_H = 1200

/** The server rejects boards beyond these limits (422); the UI stops accepting input before that happens. */
export const LIMITS = { steps: 60, stepChars: 1000, strokes: 600, strokePoints: 4000, totalPoints: 30000, elements: 200, textChars: 1000, latexChars: 400 }

export const totalPoints = (b: Pick<Board, "strokes">) => b.strokes.reduce((n, s) => n + s.pts.length, 0)
export const canAddStroke = (b: Pick<Board, "strokes">) => b.strokes.length < LIMITS.strokes && totalPoints(b) < LIMITS.totalPoints - 200
export const canAddElement = (b: Pick<Board, "elements">) => b.elements.length < LIMITS.elements

/** Thin a point list (keep endpoints) so long freehand strokes stay under the per-stroke and total caps. */
export function simplify(pts: [number, number][], minDist = 6): [number, number][] {
  if (pts.length <= 2) return pts
  const out: [number, number][] = [pts[0]]
  for (let i = 1; i < pts.length - 1; i++) {
    const [px, py] = out[out.length - 1]
    if (Math.hypot(pts[i][0] - px, pts[i][1] - py) >= minDist) out.push(pts[i])
  }
  out.push(pts[pts.length - 1])
  return out.slice(0, LIMITS.strokePoints)
}

export const isEmptyBoard = (b: Board) =>
  b.steps.every((s) => !s.trim()) && b.strokes.length === 0 && b.elements.length === 0

/** Items the student wrote (what the Coach treats as the student's reasoning). */
export const studentItems = (b: Board) => b.elements.filter((e) => e.author === "student" && (e.kind === "text" || e.kind === "equation"))

// ---------------------------------------------------------------------------------------------------------------- sizes (same constants as the server)
const COL_W = 940
export function estimateSize(kind: "text" | "equation", text = "", latex = ""): [number, number] {
  if (kind === "equation") {
    const tall = ["\\frac", "\\sum", "\\int", "\\begin", "\\\\", "\\sqrt", "\\lim"].some((t) => latex.includes(t))
    return [Math.min(COL_W, Math.max(220, latex.length * 24)), tall ? 160 : 100]
  }
  const w = Math.min(COL_W, Math.max(160, text.split("\n")[0].length * 22 + 32))
  const usable = Math.max(1, w - 32)
  const lines = text.split("\n").reduce((n, line) => n + Math.max(1, Math.ceil((line.length * 22) / usable)), 0)
  return [w, lines * 56 + 20]
}

const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(Math.round(n), lo), hi)

export function newId(): string {
  return "u" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}

export function nextSeq(b: Board): number {
  return Math.max(b.nextSeq, ...b.elements.map((e) => e.seq + 1), 0)
}

/** Add one element (immutably), assigning id/seq/author and a size estimate. Returns the board unchanged if the board is full. */
export function addElement(b: Board, el: Omit<BoardElement, "id" | "seq" | "author" | "w" | "h"> & Partial<Pick<BoardElement, "w" | "h">>): { board: Board; id: string | null } {
  if (!canAddElement(b)) return { board: b, id: null }
  const [ew, eh] = el.kind === "text" || el.kind === "equation" ? estimateSize(el.kind, el.text, el.latex) : [el.w ?? 0, el.h ?? 0]
  const seq = nextSeq(b)
  const id = newId()
  const full: BoardElement = { ...el, id, seq, author: "student", w: el.w ?? ew, h: el.h ?? eh }
  return { board: { ...b, elements: [...b.elements, full], nextSeq: seq + 1 }, id }
}

/** Remove several elements, and everything that only exists in relation to them (arrows attached to them, shapes drawn around them). */
export function removeElements(b: Board, ids: Iterable<string>): Board {
  const gone = new Set(ids)
  return { ...b, elements: b.elements.filter((e) => !gone.has(e.id) && !(e.fromId && gone.has(e.fromId)) && !(e.toId && gone.has(e.toId)) && !(e.around && gone.has(e.around))) }
}

export function removeElement(b: Board, id: string): Board {
  return removeElements(b, [id])
}

export function updateElement(b: Board, id: string, patch: Partial<BoardElement>): Board {
  return {
    ...b,
    elements: b.elements.map((e) => {
      if (e.id !== id) return e
      const next = { ...e, ...patch, author: "student" as const }       // the student touched it: it is theirs now (the server enforces this too)
      if ((patch.text !== undefined || patch.latex !== undefined) && (e.kind === "text" || e.kind === "equation")) {
        const [w, h] = estimateSize(e.kind, next.text, next.latex)
        next.w = w
        next.h = h
      }
      return next
    }),
  }
}

/**
 * How far an element's drawn extent reaches from its (x, y) anchor, per side. Rectangles-like elements
 * extend right/down (0..w, 0..h), but a LINE ending left/up of its start, and a free ARROW with negative
 * w/h, reach to the left/up of (x, y). Clamping x/y as if everything extended right/down let such
 * connectors be dragged partly off the board.
 */
function reach(e: BoardElement): { l: number; r: number; t: number; b: number } {
  if (e.kind === "line") {
    const dx = (e.x2 ?? e.x + e.w) - e.x
    const dy = (e.y2 ?? e.y + e.h) - e.y
    return { l: Math.min(0, dx), r: Math.max(0, dx), t: Math.min(0, dy), b: Math.max(0, dy) }
  }
  if (e.kind === "arrow" && !(e.fromId && e.toId)) return { l: Math.min(0, e.w), r: Math.max(0, e.w), t: Math.min(0, e.h), b: Math.max(0, e.h) }
  return { l: 0, r: e.w, t: 0, b: e.h }
}

/** Where (x, y) may go so the element's whole extent stays on the board (tiny elements keep a 40-unit grab area). */
export function clampElementPosition(e: BoardElement, x: number, y: number): { x: number; y: number } {
  const r = reach(e)
  return {
    x: clamp(x, 0 - r.l, BOARD_W - Math.max(40, r.r)), // `0 -` (not unary minus) so a zero reach stays +0, never -0
    y: clamp(y, 0 - r.t, BOARD_H - Math.max(40, r.b)),
  }
}

/** Largest shared (dx, dy) <= the requested one that keeps EVERY listed element on the board, so a group moves as a rigid whole. */
export function clampGroupDelta(els: BoardElement[], dx: number, dy: number): { dx: number; dy: number } {
  if (els.length === 0) return { dx: 0, dy: 0 }
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
  for (const e of els) {
    const r = reach(e)
    minX = Math.min(minX, e.x + r.l); maxX = Math.max(maxX, e.x + Math.max(40, r.r))
    minY = Math.min(minY, e.y + r.t); maxY = Math.max(maxY, e.y + Math.max(40, r.b))
  }
  const lo = (min: number) => 0 - min
  const hi = (max: number, size: number) => size - max
  const pick = (d: number, l: number, h: number) => (l > h ? 0 : clamp(d, l, h)) // group wider than the board: do not move
  return { dx: pick(dx, lo(minX), hi(maxX, BOARD_W)), dy: pick(dy, lo(minY), hi(maxY, BOARD_H)) }
}

const shifted = (e: BoardElement, dx: number, dy: number): BoardElement => {
  const out = { ...e, x: e.x + dx, y: e.y + dy }
  if (e.kind === "line" && e.x2 !== undefined && e.y2 !== undefined) {
    out.x2 = e.x2 + dx
    out.y2 = e.y2 + dy
  }
  return out
}

/** Moving an element does not change authorship: only content edits do. */
export function moveElement(b: Board, id: string, x: number, y: number): Board {
  return {
    ...b,
    elements: b.elements.map((e) => {
      if (e.id !== id) return e
      const c = clampElementPosition(e, x, y)
      return shifted(e, c.x - e.x, c.y - e.y)
    }),
  }
}

/** Move several elements by one shared delta (clamped as a group so their relative layout is preserved). */
export function moveElements(b: Board, ids: ReadonlySet<string>, dx: number, dy: number): { board: Board; dx: number; dy: number } {
  const group = b.elements.filter((e) => ids.has(e.id))
  const d = clampGroupDelta(group, dx, dy)
  return { board: { ...b, elements: b.elements.map((e) => (ids.has(e.id) ? shifted(e, d.dx, d.dy) : e)) }, ...d }
}

/** Typed steps of the old (v1) board become student text elements, laid out top to bottom. */
export function fromLegacy(b: Board): Board {
  const steps = b.steps.filter((s) => s.trim())
  if (steps.length === 0) return { ...b, steps: [] }
  let board: Board = { ...b, steps: [] }
  let y = 60
  for (const s of steps) {
    const [w, h] = estimateSize("text", s)
    const seq = nextSeq(board)
    board = { ...board, nextSeq: seq + 1, elements: [...board.elements, { id: `legacy-${seq}`, kind: "text", author: "student", seq, x: 60, y, w, h, text: s, style: "step" }] }
    y += h + 28
  }
  return board
}

/** Centre-to-edge geometry for arrows between two elements (the server stores the same links; the client draws from the live boxes). */
export function edgePoint(box: { x: number; y: number; w: number; h: number }, toward: [number, number]): [number, number] {
  const cx = box.x + box.w / 2
  const cy = box.y + box.h / 2
  const dx = toward[0] - cx
  const dy = toward[1] - cy
  if (dx === 0 && dy === 0) return [cx, cy]
  const sx = box.w / 2 / Math.abs(dx || 1e-9)
  const sy = box.h / 2 / Math.abs(dy || 1e-9)
  const k = Math.min(sx, sy)
  return [cx + dx * k, cy + dy * k]
}

export function arrowEndpoints(a: BoardElement, byId: Map<string, BoardElement>): [[number, number], [number, number]] | null {
  if (a.fromId && a.toId) {
    const f = byId.get(a.fromId)
    const t = byId.get(a.toId)
    if (!f || !t) return null
    const fc: [number, number] = [f.x + f.w / 2, f.y + f.h / 2]
    const tc: [number, number] = [t.x + t.w / 2, t.y + t.h / 2]
    return [edgePoint(f, tc), edgePoint(t, fc)]
  }
  return [[a.x, a.y], [a.x + a.w, a.y + a.h]]
}

export function shapeBox(s: BoardElement, byId: Map<string, BoardElement>): { x: number; y: number; w: number; h: number } {
  const target = s.around ? byId.get(s.around) : undefined
  if (!target) return { x: s.x, y: s.y, w: s.w, h: s.h }
  const pad = 18
  return { x: Math.max(0, target.x - pad), y: Math.max(0, target.y - pad), w: target.w + 2 * pad, h: target.h + 2 * pad }
}

/** The topmost text/equation element under a point (for the eraser, selection and link targets). */
export function hitElement(b: Board, px: number, py: number): BoardElement | null {
  const els = [...b.elements].reverse()
  return els.find((e) => (e.kind === "text" || e.kind === "equation") && px >= e.x && px <= e.x + e.w && py >= e.y && py <= e.y + e.h) ?? null
}

const distToSegment = (px: number, py: number, x1: number, y1: number, x2: number, y2: number): number => {
  const dx = x2 - x1
  const dy = y2 - y1
  const len2 = dx * dx + dy * dy
  // NB: not `clamp` - that helper rounds to an integer, which would snap t to 0 or 1 and measure to an endpoint.
  const t = len2 === 0 ? 0 : Math.min(1, Math.max(0, ((px - x1) * dx + (py - y1) * dy) / len2))
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy))
}

/**
 * The topmost element of ANY kind under a point (what the eraser removes). Lines and arrows are hit within
 * `tolerance` of their segment (plus half the stroke width), rotated elements are tested in their own frame,
 * everything else by its box. `hitElement` stays text/equation-only because link targets and click-to-edit
 * rely on that.
 */
export function hitAnyElement(b: Board, px: number, py: number, tolerance = 8): BoardElement | null {
  const byId = new Map(b.elements.map((e) => [e.id, e]))
  for (let i = b.elements.length - 1; i >= 0; i--) {
    const e = b.elements[i]
    if (e.kind === "line" || e.kind === "arrow") {
      const pts = e.kind === "arrow" ? arrowEndpoints(e, byId) : [[e.x, e.y], [e.x2 ?? e.x + e.w, e.y2 ?? e.y + e.h]] as [[number, number], [number, number]]
      if (!pts) continue
      const tol = tolerance + (e.strokeWidth ?? 3) / 2
      if (distToSegment(px, py, pts[0][0], pts[0][1], pts[1][0], pts[1][1]) <= tol) return e
      continue
    }
    let tx = px
    let ty = py
    if (e.rotation) {
      const cx = e.x + e.w / 2
      const cy = e.y + e.h / 2
      const a = (-e.rotation * Math.PI) / 180
      tx = cx + (px - cx) * Math.cos(a) - (py - cy) * Math.sin(a)
      ty = cy + (px - cx) * Math.sin(a) + (py - cy) * Math.cos(a)
    }
    const box = e.around ? shapeBox(e, byId) : { x: e.x, y: e.y, w: e.w, h: e.h }
    if (tx >= box.x && tx <= box.x + box.w && ty >= box.y && ty <= box.y + box.h) return e
  }
  return null
}

// ---------------------------------------------------------------------------------------------------------------- wire format
type Wire = Record<string, unknown>
export function toWire(b: Board): { steps: string[]; strokes: Stroke[]; elements: Wire[]; next_seq: number } {
  const elements = b.elements.map((e) => {
    const out: Wire = {
      id: e.id,
      kind: e.kind,
      author: e.author,
      seq: clamp(e.seq, 0, 1_000_000),
      x: Math.round(clamp(e.x, 0, BOARD_W)),
      y: Math.round(clamp(e.y, 0, BOARD_H)),
      w: Math.round(clamp(e.w, -BOARD_W, BOARD_W)),
      h: Math.round(clamp(e.h, -BOARD_H, BOARD_H)),
    }
    if (e.text !== undefined) out.text = e.text.slice(0, LIMITS.textChars)
    if (e.latex !== undefined) out.latex = e.latex.slice(0, LIMITS.latexChars)
    if (e.style) out.style = e.style
    if (e.color) out.color = e.color
    if (e.highlight) out.highlight = e.highlight
    if (e.fromId) out.from_id = e.fromId
    if (e.toId) out.to_id = e.toId
    if (e.shape) out.shape = e.shape
    if (e.around) out.around = e.around
    if (e.rotation !== undefined) out.rotation = e.rotation
    if (e.filled !== undefined) out.filled = e.filled
    if (e.strokeWidth !== undefined) out.stroke_width = e.strokeWidth
    if (e.x2 !== undefined) out.x2 = e.x2
    if (e.y2 !== undefined) out.y2 = e.y2
    if (e.points !== undefined) out.points = e.points
    if (e.pathData !== undefined) out.path_data = e.pathData
    if (e.src !== undefined) out.src = e.src
    if (e.code !== undefined) out.code = e.code
    if (e.title !== undefined) out.title = e.title
    if (e.fontSize !== undefined) out.font_size = e.fontSize
    if (e.isLoading !== undefined) out.is_loading = e.isLoading
    return out
  })
  return { steps: b.steps, strokes: b.strokes, elements, next_seq: nextSeq(b) }
}

/** Normalise whatever the server returned (older boards have no elements/nextSeq). */
export function fromServer(raw: Partial<Board> | null | undefined): Board {
  const b: Board = { steps: raw?.steps ?? [], strokes: raw?.strokes ?? [], elements: raw?.elements ?? [], nextSeq: raw?.nextSeq ?? 0 }
  if (raw?.scene) b.scene = raw.scene
  return b
}

// ---------------------------------------------------------------------------------------------------------------- undo / redo (client session only)
export interface History { past: Board[]; present: Board; future: Board[]; /** Key of the gesture that produced `present`, so its follow-up updates can be merged into one undo step. */ key?: string }
const MAX_HISTORY = 60
export const startHistory = (b: Board): History => ({ past: [], present: b, future: [] })
/**
 * Record a new board state. Updates that share a `coalesceKey` (every pointer-move of ONE resize / rotate
 * gesture) replace the previous state instead of stacking: a single drag used to push one history entry per
 * pointer-move, so undo moved one pixel at a time and a long drag evicted the whole earlier history (the
 * cap is MAX_HISTORY). A different or missing key always starts a new undo step.
 */
export const commit = (h: History, b: Board, coalesceKey?: string): History => {
  if (b === h.present) return h
  if (coalesceKey && h.key === coalesceKey && h.past.length > 0) return { past: h.past, present: b, future: [], key: coalesceKey }
  return { past: [...h.past, h.present].slice(-MAX_HISTORY), present: b, future: [], key: coalesceKey }
}
export const undo = (h: History): History => (h.past.length ? { past: h.past.slice(0, -1), present: h.past[h.past.length - 1], future: [h.present, ...h.future] } : h)
export const redo = (h: History): History => (h.future.length ? { past: [...h.past, h.present], present: h.future[0], future: h.future.slice(1) } : h)
