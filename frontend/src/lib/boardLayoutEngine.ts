/**
 * SocratiQ SmartBoard — Intelligent Adaptive Layout Engine
 *
 * Provides deterministic, content-aware layout planning, accurate bounding box calculations,
 * collision avoidance against student work and existing elements, unobstructed visible
 * viewport prioritization, multi-element coordinated grouping, and clean connector routing.
 */
import {
  BOARD_W,
  BOARD_H,
  type Board,
  type BoardElement,
  type ElementKind,
  type Stroke,
} from "./whiteboard"
import { capOcclusion, isUsableSize } from "./boardViewport"
import {
  arrowElementGeometry,
  connectorEndpoints,
  finiteNumber,
  isMeaningfulBox,
  lineElementGeometry,
  readSegment,
  resolvePathIntent,
  segmentBox,
  translateSegment,
  type Segment,
} from "./aiGeometry"

export interface RectBox {
  x: number
  y: number
  w: number
  h: number
}

export interface ContainerDimensions {
  width: number
  height: number
}

export interface UiOcclusion {
  top?: number // Toolbar + contextual properties (in screen px)
  bottom?: number // Floating AI chat dock + safe area (in screen px)
  left?: number // Left dock/margin (in screen px)
  right?: number // Right dock/margin (in screen px)
}

export interface ViewportAnalysis {
  rawVisibleRect: RectBox
  unobstructedVisibleRect: RectBox
  usableWidth: number
  usableHeight: number
  scale: number
}

export interface LayoutItem {
  id: string
  kind: ElementKind
  name: string
  args: Record<string, any>
  box: RectBox
  author: "coach" | "student"
  groupId?: string
  /** Index of the originating call in the `functionCalls` array given to planBatchLayout. */
  sourceIndex: number
}

export interface BatchPlanResult {
  items: LayoutItem[]
  /** Calls that could not be drawn at all (e.g. a path with no pathData). `sourceIndex` identifies the call. */
  rejected: { name: string; reason: string; sourceIndex?: number }[]
  viewTarget?: { x: number; y: number }
  groupId?: string
}

export const DEFAULT_GAP = 24
const DEFAULT_LINE_LENGTH = 140
export const BOARD_PADDING = 32

/**
 * Calculates the axis-aligned bounding box (AABB) of an element,
 * accounting for rotation, line/arrow endpoints, and shape variations.
 */
export function getElementBoundingBox(el: BoardElement): RectBox {
  const rotation = el.rotation || 0
  let rawX = el.x
  let rawY = el.y
  let rawW = el.w
  let rawH = el.h

  if (el.kind === "arrow" || el.kind === "line") {
    // Lines end at (x2, y2); free arrows end at (x + w, y + h) (what the renderer draws), so a stale x2/y2
    // left on an arrow that was later dragged can never skew its box.
    const seg = connectorEndpoints(el)
    rawX = Math.min(seg.x1, seg.x2)
    rawY = Math.min(seg.y1, seg.y2)
    rawW = Math.max(16, Math.abs(seg.x2 - seg.x1))
    rawH = Math.max(16, Math.abs(seg.y2 - seg.y1))
  }

  if (rotation === 0) {
    return { x: rawX, y: rawY, w: rawW, h: rawH }
  }

  const rad = (Math.abs(rotation) * Math.PI) / 180
  const cos = Math.abs(Math.cos(rad))
  const sin = Math.abs(Math.sin(rad))

  const rotW = Math.round(rawW * cos + rawH * sin)
  const rotH = Math.round(rawW * sin + rawH * cos)

  const cx = rawX + rawW / 2
  const cy = rawY + rawH / 2

  return {
    x: Math.round(cx - rotW / 2),
    y: Math.round(cy - rotH / 2),
    w: rotW,
    h: rotH,
  }
}

/** Largest side of one ink occupancy box, and the step used to walk along long segments (board units). */
const STROKE_BOX_MAX = 80
const STROKE_SAMPLE_STEP = 40

/**
 * Approximates the area covered by freehand pen / highlighter strokes with small boxes.
 * The path is walked at <= STROKE_SAMPLE_STEP spacing (so a fast, sparse stroke is not one huge
 * diagonal box) and a box is closed whenever it would grow past STROKE_BOX_MAX on either side.
 * Eraser strokes remove ink rather than add it, so they are skipped.
 */
export function getStrokeOccupancyBoxes(strokes: ReadonlyArray<Stroke> | undefined): RectBox[] {
  const boxes: RectBox[] = []
  if (!strokes) return boxes
  for (const s of strokes) {
    if (!s || s.t === "e" || !s.pts || s.pts.length === 0) continue
    const pad = Math.max(1, (s.t === "h" ? s.w * 4 : s.w) / 2)
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    const flush = () => {
      if (minX <= maxX) boxes.push({ x: minX - pad, y: minY - pad, w: maxX - minX + pad * 2, h: maxY - minY + pad * 2 })
      minX = Infinity; minY = Infinity; maxX = -Infinity; maxY = -Infinity
    }
    let lastX = NaN, lastY = NaN
    const add = (px: number, py: number) => {
      const nMinX = Math.min(minX, px), nMaxX = Math.max(maxX, px)
      const nMinY = Math.min(minY, py), nMaxY = Math.max(maxY, py)
      if (minX <= maxX && (nMaxX - nMinX > STROKE_BOX_MAX || nMaxY - nMinY > STROKE_BOX_MAX)) {
        flush()
        // The next box starts from the previous point too, so consecutive boxes share a boundary and
        // no stretch of ink is left unreserved.
        minX = Math.min(lastX, px); maxX = Math.max(lastX, px)
        minY = Math.min(lastY, py); maxY = Math.max(lastY, py)
      } else {
        minX = nMinX; maxX = nMaxX; minY = nMinY; maxY = nMaxY
      }
      lastX = px
      lastY = py
    }
    let [prevX, prevY] = s.pts[0]
    add(prevX, prevY)
    for (let i = 1; i < s.pts.length; i++) {
      const [x, y] = s.pts[i]
      const dist = Math.hypot(x - prevX, y - prevY)
      const steps = Math.max(1, Math.ceil(dist / STROKE_SAMPLE_STEP))
      for (let k = 1; k <= steps; k++) add(prevX + ((x - prevX) * k) / steps, prevY + ((y - prevY) * k) / steps)
      prevX = x
      prevY = y
    }
    flush()
  }
  return boxes
}

/** Every region new content must avoid: element bounds (rotation/line aware) plus freehand ink. */
export function getOccupiedBoxes(board: Pick<Board, "elements" | "strokes">): RectBox[] {
  return [...board.elements.map(getElementBoundingBox), ...getStrokeOccupancyBoxes(board.strokes)]
}

/**
 * True when the whole box lies inside the part of the board the user can actually see (not under the
 * toolbars or chat dock). Callers use this to tell the user when content had to be placed off-screen.
 */
export function isPlacementVisible(
  box: RectBox,
  viewState: { x: number; y: number; scale: number } | undefined,
  container?: ContainerDimensions,
  occlusion?: UiOcclusion | null,
): boolean {
  if (!viewState) return true
  const u = computeUnobstructedVisibleViewport(viewState, container, occlusion ?? undefined).unobstructedVisibleRect
  if (u.w <= 0 || u.h <= 0) return false
  return box.x >= u.x && box.y >= u.y && box.x + box.w <= u.x + u.w && box.y + box.h <= u.y + u.h
}

/**
 * Checks whether two rectangular bounding boxes intersect, with an optional safety margin.
 */
export function doBoxesIntersect(a: RectBox, b: RectBox, buffer = 20): boolean {
  return !(
    a.x + a.w + buffer <= b.x ||
    b.x + b.w + buffer <= a.x ||
    a.y + a.h + buffer <= b.y ||
    b.y + b.h + buffer <= a.y
  )
}

/**
 * Checks whether candidate box collides with any existing box in the collection.
 */
export function hasBoxCollision(candidate: RectBox, existing: RectBox[], buffer = 20): boolean {
  return existing.some((box) => doBoxesIntersect(candidate, box, buffer))
}

const DEFAULT_CONTAINER: ContainerDimensions = { width: 1000, height: 700 }
const DEFAULT_OCCLUSION: UiOcclusion = { top: 64, bottom: 84, left: 16, right: 16 }

/**
 * The part of the board [0, boardMax] that is seen through the screen interval [screenStart, screenEnd]
 * (CSS px measured from the drawing surface's top-left), given the pan (board coordinate at screen 0) and
 * zoom. The screen interval is converted to board units FIRST and clipped to the board AFTER; clipping the
 * pan before adding the window extent (an earlier version did) makes a view that hangs over the board's
 * left/top edge look wider than it is. An interval that misses the board yields an empty span.
 */
function boardSpan(pan: number, scale: number, screenStart: number, screenEnd: number, boardMax: number): [number, number] {
  const lo = pan + screenStart / scale
  const hi = pan + screenEnd / scale
  const a = Math.max(0, lo)
  const b = Math.min(boardMax, hi)
  if (b > a) return [a, b]
  const edge = Math.min(boardMax, Math.max(0, lo))
  return [edge, edge]
}

/**
 * Derives the raw visible board rectangle and the unobstructed visible rectangle (excluding toolbars, the
 * properties dock and the floating chat), both in BOARD coordinates.
 *
 * Contract (shared with boardViewport.ts):
 *   - view.x / view.y is the board coordinate at the top-left of the drawing surface; view.scale is screen
 *     px per board unit; the container is the drawing surface in CSS px.
 *   - Occlusion is in SCREEN px measured inward from each container edge, so it is applied to the screen
 *     window before conversion to board space. UI that sits over empty space outside the board therefore
 *     removes nothing from the board region.
 *   - Rectangles are the true intersection with the board and may be EMPTY (w or h = 0) when nothing of the
 *     board is visible / unobstructed; nothing is inflated to a minimum size.
 *   - rawVisibleRect is rounded to the nearest unit; unobstructedVisibleRect is rounded INWARD so a box that
 *     fits inside it really is fully visible.
 */
export function computeUnobstructedVisibleViewport(
  viewState?: { x: number; y: number; scale: number },
  container: ContainerDimensions = DEFAULT_CONTAINER,
  occlusion: UiOcclusion | null = DEFAULT_OCCLUSION,
): ViewportAnalysis {
  const scale = viewState && Number.isFinite(viewState.scale) && viewState.scale > 0 ? viewState.scale : 0.5
  const usable = isUsableSize(container?.width, container?.height)
  const winW = usable ? container.width : DEFAULT_CONTAINER.width
  const winH = usable ? container.height : DEFAULT_CONTAINER.height
  const panX = viewState && Number.isFinite(viewState.x) ? viewState.x : 0
  const panY = viewState && Number.isFinite(viewState.y) ? viewState.y : 0

  const [rx0, rx1] = boardSpan(panX, scale, 0, winW, BOARD_W)
  const [ry0, ry1] = boardSpan(panY, scale, 0, winH, BOARD_H)
  const rawVisibleRect: RectBox = {
    x: Math.round(rx0),
    y: Math.round(ry0),
    w: Math.round(rx1) - Math.round(rx0),
    h: Math.round(ry1) - Math.round(ry0),
  }

  const occ = capOcclusion(occlusion ?? DEFAULT_OCCLUSION, { width: winW, height: winH })
  const [ux0, ux1] = boardSpan(panX, scale, occ.left, winW - occ.right, BOARD_W)
  const [uy0, uy1] = boardSpan(panY, scale, occ.top, winH - occ.bottom, BOARD_H)
  const left = Math.ceil(ux0)
  const top = Math.ceil(uy0)
  const unobstructedVisibleRect: RectBox = {
    x: left,
    y: top,
    w: Math.max(0, Math.floor(ux1) - left),
    h: Math.max(0, Math.floor(uy1) - top),
  }

  return {
    rawVisibleRect,
    unobstructedVisibleRect,
    usableWidth: unobstructedVisibleRect.w,
    usableHeight: unobstructedVisibleRect.h,
    scale,
  }
}

/**
 * Strips verbose LaTeX macro wrappers to estimate true visual symbol length.
 */
function cleanLatexVisualTokens(latex: string): number {
  if (!latex) return 0
  // Strip formatting wrappers like \mathbf{...}, \mathrm{...}, \text{...}, \left, \right
  let cleaned = latex
    .replace(/\\(left|right|big|Big|bigg|Bigg)/g, "")
    .replace(/\\(text|mathrm|mathbf|mathit|textbf|textit)\{([^}]*)\}/g, "$2")
    .replace(/\\(begin|end)\{[^}]*\}/g, "")
    .replace(/\\[a-zA-Z]+/g, "X") // Treat each command (e.g. \alpha, \frac, \sum) as 1-2 symbol widths
    .replace(/[\s^_{}()]/g, "") // remove spacing syntax
  return Math.max(1, cleaned.length)
}

/**
 * Estimates element dimensions with typography, math symbol awareness,
 * and adaptive responsive constraints.
 */
export function estimateContentDimensions(
  item: {
    kind: string
    text?: string
    latex?: string
    title?: string
    expression?: string
    width?: number
    height?: number
    radius?: number
    fontSize?: number
    role?: "heading" | "step" | "body" | "annotation" | "label"
  },
  visibleConstraint?: RectBox
): { w: number; h: number; fontSize: number } {
  const maxAllowedW = visibleConstraint ? Math.max(160, visibleConstraint.w - 24) : 680
  const maxAllowedH = visibleConstraint ? Math.max(120, visibleConstraint.h - 24) : 600

  // 1. TEXT
  if (item.kind === "text") {
    const text = (item.text || "").trim()
    let fontSize = item.fontSize
    if (!fontSize) {
      if (
        item.role === "heading" ||
        text.startsWith("#") ||
        (text.length <= 40 && (text.endsWith(":") || text.startsWith("Step")) && !text.includes("\n"))
      ) {
        fontSize = 32
      } else if (item.role === "annotation" || item.role === "label") {
        fontSize = 18
      } else {
        fontSize = 24
      }
    }
    const lines = text.split("\n")
    const longestLine = Math.max(...lines.map((l) => l.length), 1)

    // Character width estimate for standard clean UI fonts
    const charWidth = fontSize * 0.55
    const naturalWidth = Math.round(longestLine * charWidth + 28)
    const targetMaxW = Math.min(maxAllowedW, 560)
    const w = Math.min(targetMaxW, Math.max(100, naturalWidth))

    const usableWidth = Math.max(80, w - 24)
    const wrappedLineCount = lines.reduce((acc, line) => {
      const lineLen = line.length * charWidth
      return acc + Math.max(1, Math.ceil(lineLen / usableWidth))
    }, 0)

    const lineHeight = fontSize * 1.35 + 6
    const h = Math.min(maxAllowedH, Math.max(44, Math.round(wrappedLineCount * lineHeight + 18)))
    return { w, h, fontSize }
  }

  // 2. EQUATIONS
  if (item.kind === "equation") {
    const latex = (item.latex || "").trim()
    const lines = Math.max(1, latex.split(/\\\\|\n/).length)
    const isTall = ["\\frac", "\\sum", "\\int", "\\begin", "\\\\", "\\sqrt", "\\lim", "\\matrix", "\\prod", "\\binom"].some(
      (t) => latex.includes(t)
    )

    const visualSymbols = cleanLatexVisualTokens(latex)

    // Differentiate short expressions (e.g. x = 5) from multi-term formulas
    let estimatedW: number
    if (visualSymbols <= 6 && lines === 1) {
      estimatedW = Math.max(80, Math.round(visualSymbols * 20 + 36))
    } else if (visualSymbols <= 14 && lines === 1) {
      estimatedW = Math.max(110, Math.round(visualSymbols * 18 + 40))
    } else {
      estimatedW = Math.max(140, Math.round(visualSymbols * 16 + 50))
    }
    const w = Math.min(maxAllowedW, estimatedW)

    let estimatedH: number
    if (lines === 1) {
      estimatedH = isTall ? 72 : 48
    } else {
      estimatedH = isTall ? lines * 64 + 16 : lines * 46 + 16
    }
    const h = Math.min(maxAllowedH, Math.max(44, estimatedH))
    return { w, h, fontSize: 24 }
  }

  // 3. PLOTS & FUNCTION GRAPHS
  if (item.kind === "plot" || item.kind === "add_plot") {
    // Proportional math chart (aspect ratio ~1.35) adapted to viewport
    const targetW = Math.min(460, Math.max(260, maxAllowedW))
    const targetH = Math.min(maxAllowedH, Math.round(targetW / 1.35))
    return { w: targetW, h: targetH, fontSize: 24 }
  }

  // 4. SIMULATIONS
  if (item.kind === "simulation") {
    const targetW = Math.min(480, Math.max(280, maxAllowedW))
    const targetH = Math.min(maxAllowedH, Math.round(Math.min(360, targetW / 1.33)))
    return { w: targetW, h: targetH, fontSize: 24 }
  }

  // 5. IMAGES
  if (item.kind === "image") {
    const targetW = Math.min(380, Math.max(240, maxAllowedW))
    const targetH = Math.min(maxAllowedH, Math.round(targetW * 0.75))
    return { w: targetW, h: targetH, fontSize: 24 }
  }

  // 6. SHAPES (Circle, Rectangle, Triangle, Path)
  if (item.kind === "circle") {
    const r = item.radius || 35
    const size = Math.min(maxAllowedW, Math.max(40, r * 2))
    return { w: size, h: size, fontSize: 24 }
  }

  if (item.kind === "triangle") {
    const w = Math.min(maxAllowedW, Math.max(50, item.width || 100))
    const h = Math.min(maxAllowedH, Math.max(50, item.height || 100))
    return { w, h, fontSize: 24 }
  }

  if (item.kind === "shape" || item.kind === "rect") {
    const w = Math.min(maxAllowedW, Math.max(50, item.width || 130))
    const h = Math.min(maxAllowedH, Math.max(40, item.height || 80))
    return { w, h, fontSize: 24 }
  }

  if (item.kind === "arrow" || item.kind === "line") {
    return {
      w: Math.max(40, item.width || 140),
      h: Math.max(20, item.height || 30),
      fontSize: 24,
    }
  }

  return {
    w: Math.min(maxAllowedW, Math.max(80, item.width || 180)),
    h: Math.min(maxAllowedH, Math.max(50, item.height || 90)),
    fontSize: 24,
  }
}

/**
 * Calculates a multi-factor fitness score for placing an element box.
 * Evaluates unobstructed viewport visibility, collision freedom, UI clearance,
 * anchor proximity, alignment with existing boxes, and natural reading flow.
 */
export function scoreCandidatePlacement(
  candidate: RectBox,
  existingBoxes: RectBox[],
  viewportAnalysis?: ViewportAnalysis,
  anchorPos?: { x: number; y: number },
  buffer = 20
): number {
  const { x, y, w, h } = candidate

  // 1. HARD CONSTRAINTS: Must be inside board limits and completely collision-free
  if (x < BOARD_PADDING || x + w > BOARD_W - BOARD_PADDING) return -Infinity
  if (y < BOARD_PADDING || y + h > BOARD_H - BOARD_PADDING) return -Infinity
  if (hasBoxCollision(candidate, existingBoxes, buffer)) return -Infinity

  let score = 0

  // 2. VISIBILITY IN UNOBSTRUCTED VIEWPORT
  if (viewportAnalysis) {
    const u = viewportAnalysis.unobstructedVisibleRect
    const raw = viewportAnalysis.rawVisibleRect

    const interW = Math.max(0, Math.min(x + w, u.x + u.w) - Math.max(x, u.x))
    const interH = Math.max(0, Math.min(y + h, u.y + u.h) - Math.max(y, u.y))
    const interArea = interW * interH
    const candArea = w * h
    const visRatio = candArea > 0 ? interArea / candArea : 0

    if (visRatio >= 0.99) {
      score += 1500 // Fully inside unobstructed view!
    } else if (visRatio > 0.5) {
      score += 1000 * visRatio - 300 * (1 - visRatio)
    } else if (visRatio > 0) {
      score += 400 * visRatio - 600 * (1 - visRatio)
    } else {
      // Outside unobstructed viewport: check if at least inside raw visible boundary
      const rawInterW = Math.max(0, Math.min(x + w, raw.x + raw.w) - Math.max(x, raw.x))
      const rawInterH = Math.max(0, Math.min(y + h, raw.y + raw.h) - Math.max(y, raw.y))
      if (rawInterW * rawInterH > 0) {
        score -= 400 // Inside view but occluded by toolbar/chat
      } else {
        score -= 900 // Completely off-screen
      }
    }
  }

  // 3. PROXIMITY TO ANCHOR / SELECTED OBJECT
  if (anchorPos) {
    const dist = Math.hypot(x - anchorPos.x, y - anchorPos.y)
    score += Math.max(0, 450 * (1 - dist / 900))
  }

  // 4. ALIGNMENT WITH EXISTING ELEMENTS (creates clean, orderly blackboard layouts)
  for (const eb of existingBoxes) {
    if (Math.abs(x - eb.x) <= 6 || Math.abs(x + w - (eb.x + eb.w)) <= 6) {
      score += 120
      break
    }
    if (Math.abs(y - eb.y) <= 6 || Math.abs(y + h - (eb.y + eb.h)) <= 6) {
      score += 80
      break
    }
  }

  // 5. NATURAL READING FLOW (prefer top-to-bottom, left-to-right)
  const normY = 1 - y / BOARD_H
  const normX = 1 - x / BOARD_W
  score += normY * 70 + normX * 30

  return score
}

/**
 * Finds an optimal collision-free position for placing a new element,
 * prioritizing the unobstructed visible viewport using multi-factor scoring.
 */
export function findCollisionFreePosition(
  board: Board,
  w: number,
  h: number,
  preferredPos?: { x: number; y: number },
  additionalOccupied: RectBox[] = [],
  viewState?: { x: number; y: number; scale: number },
  buffer = 20,
  container?: ContainerDimensions,
  occlusion?: UiOcclusion | null
): { x: number; y: number } {
  const existingBoxes = [
    ...getOccupiedBoxes(board),
    ...additionalOccupied,
  ]

  const vpAnalysis = viewState
    ? computeUnobstructedVisibleViewport(viewState, container, occlusion ?? undefined)
    : undefined

  const maxX = BOARD_W - w - BOARD_PADDING
  const maxY = BOARD_H - h - BOARD_PADDING

  const state: { best: { x: number; y: number; score: number } | null } = { best: null }

  const evaluateCandidate = (cx: number, cy: number, anchor?: { x: number; y: number }) => {
    const clampedX = Math.round(Math.max(BOARD_PADDING, Math.min(maxX, cx)))
    const clampedY = Math.round(Math.max(BOARD_PADDING, Math.min(maxY, cy)))
    const cand: RectBox = { x: clampedX, y: clampedY, w, h }
    const score = scoreCandidatePlacement(cand, existingBoxes, vpAnalysis, anchor || preferredPos, buffer)
    if (score > -Infinity && (!state.best || score > state.best.score)) {
      state.best = { x: clampedX, y: clampedY, score }
    }
  }

  // 1. If preferred position given, test it directly and adjacent neighbors
  if (preferredPos) {
    evaluateCandidate(preferredPos.x, preferredPos.y)
    // Adjacent below
    evaluateCandidate(preferredPos.x, preferredPos.y + h + buffer)
    // Adjacent right
    evaluateCandidate(preferredPos.x + w + buffer, preferredPos.y)
    // If preferred position or its immediate neighbor scored a solid in-viewport placement, return immediately
    if (state.best && state.best.score >= 1200) {
      return { x: state.best.x, y: state.best.y }
    }
  }

  // 2. High-priority search: Scan the unobstructed visible viewport
  if (vpAnalysis) {
    const u = vpAnalysis.unobstructedVisibleRect
    const startX = Math.max(BOARD_PADDING, u.x)
    const startY = Math.max(BOARD_PADDING, u.y)
    const endX = Math.min(maxX, u.x + u.w - w)
    const endY = Math.min(maxY, u.y + u.h - h)

    const stepX = Math.max(30, Math.min(80, Math.round(w / 4)))
    const stepY = Math.max(30, Math.min(60, Math.round(h / 4)))

    if (endX >= startX && endY >= startY) {
      for (let cy = startY; cy <= endY; cy += stepY) {
        for (let cx = startX; cx <= endX; cx += stepX) {
          evaluateCandidate(cx, cy)
          if (state.best && state.best.score >= 1500) {
            // Found ideal 100% visible, aligned spot
            return { x: state.best.x, y: state.best.y }
          }
        }
      }
    }
  }

  // If a good visible candidate was found, choose it!
  if (state.best && state.best.score > 0) {
    return { x: state.best.x, y: state.best.y }
  }

  // 3. Fallback: Search nearby free canvas space using multi-column grid
  const colStep = Math.max(280, Math.round(w + buffer))
  const columns: number[] = []
  for (let c = BOARD_PADDING; c <= maxX; c += colStep) {
    columns.push(c)
  }
  if (!columns.includes(BOARD_PADDING)) columns.unshift(BOARD_PADDING)
  const stepY = 40

  for (const colX of columns) {
    for (let cy = BOARD_PADDING; cy <= maxY; cy += stepY) {
      evaluateCandidate(colX, cy)
      if (state.best && state.best.score >= 500) {
        return { x: state.best.x, y: state.best.y }
      }
    }
  }

  // 4. Ultimate fallback: Below lowest existing element or center
  if (existingBoxes.length > 0) {
    const lowestY = Math.max(...existingBoxes.map((b) => b.y + b.h))
    const safeY = lowestY + buffer
    if (safeY <= maxY) {
      evaluateCandidate(BOARD_PADDING, safeY)
    }
  }

  if (state.best) {
    return { x: state.best.x, y: state.best.y }
  }

  return {
    x: Math.round(Math.max(BOARD_PADDING, Math.min(maxX, BOARD_PADDING))),
    y: Math.round(Math.max(BOARD_PADDING, Math.min(maxY, BOARD_PADDING))),
  }
}

/**
 * Calculates optimal start/end coordinates for an arrow connecting two rectangular boxes.
 * Computes exact perimeter intersection points so arrows never pierce through shape centers.
 */
export function computeArrowEndpoints(
  fromBox: RectBox,
  toBox: RectBox
): { x1: number; y1: number; x2: number; y2: number } {
  const fromCenter = { x: fromBox.x + fromBox.w / 2, y: fromBox.y + fromBox.h / 2 }
  const toCenter = { x: toBox.x + toBox.w / 2, y: toBox.y + toBox.h / 2 }

  const dx = toCenter.x - fromCenter.x
  const dy = toCenter.y - fromCenter.y

  let x1 = fromCenter.x
  let y1 = fromCenter.y
  let x2 = toCenter.x
  let y2 = toCenter.y

  // Intersect with fromBox boundary
  if (Math.abs(dx) * fromBox.h > Math.abs(dy) * fromBox.w) {
    // Exits left or right
    x1 = dx > 0 ? fromBox.x + fromBox.w : fromBox.x
    y1 = fromCenter.y + (dy * (x1 - fromCenter.x)) / (dx || 1)
  } else {
    // Exits top or bottom
    y1 = dy > 0 ? fromBox.y + fromBox.h : fromBox.y
    x1 = fromCenter.x + (dx * (y1 - fromCenter.y)) / (dy || 1)
  }

  // Intersect with toBox boundary
  if (Math.abs(dx) * toBox.h > Math.abs(dy) * toBox.w) {
    // Enters left or right
    x2 = dx > 0 ? toBox.x : toBox.x + toBox.w
    y2 = toCenter.y + (dy * (x2 - toCenter.x)) / (dx || 1)
  } else {
    // Enters top or bottom
    y2 = dy > 0 ? toBox.y : toBox.y + toBox.h
    x2 = toCenter.x + (dx * (y2 - toCenter.y)) / (dy || 1)
  }

  return {
    x1: Math.round(x1),
    y1: Math.round(y1),
    x2: Math.round(x2),
    y2: Math.round(y2),
  }
}

/**
 * Coordinated Adaptive Batch Layout Planner.
 *
 * Places a batch of AI drawing operations as coordinated groups in the unobstructed visible viewport.
 *
 * Geometry policy (deterministic; the planner never reads or mutates existing elements' positions):
 *   - "Anchored" geometry is what the AI placed meaningfully: content with explicit x/y, lines/arrows with
 *     four valid endpoints, paths whose drawn region is inside the board and not parked at the origin.
 *   - If every content item is anchored, content + anchored lines/arrows/paths form ONE rigid body. It is
 *     kept exactly where the AI put it when that spot is free and visible; otherwise the WHOLE body is
 *     translated by a single (dx, dy), so relative positions, line directions/lengths and path shapes are
 *     preserved. A body of connectors only (annotations) is never relocated to dodge existing content.
 *   - Content without anchors is stacked into a reading-order group; unanchored paths/lines are placed in
 *     free space keeping their own vector / shape (a line with unusable coordinates gets a default
 *     horizontal segment).
 *   - Connectors with from/to ids are attached to the final boxes of the elements they name; coordinate-less
 *     connectors join the last two content items of the batch.
 * Every returned item carries `sourceIndex`, the index of its call in `functionCalls`, so callers must
 * pair calls with items by that index, never by array order (items are returned content, paths, connectors).
 */
export function planBatchLayout(
  functionCalls: any[],
  currentBoard: Board,
  viewState?: { x: number; y: number; scale: number },
  selectedId: string | null = null,
  container?: ContainerDimensions,
  occlusion?: UiOcclusion | null
): BatchPlanResult {
  const plannedItems: LayoutItem[] = []
  const rejected: { name: string; reason: string; sourceIndex?: number }[] = []
  const plannedBoxes: RectBox[] = []
  const groupId = "grp_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
  const occ = occlusion ?? undefined

  const vpAnalysis = viewState
    ? computeUnobstructedVisibleViewport(viewState, container, occ)
    : undefined

  // Check if student has a selected element to anchor near
  const selectedEl = selectedId ? currentBoard.elements.find((e) => e.id === selectedId) : null
  let anchorPos: { x: number; y: number } | undefined = undefined
  if (selectedEl) {
    const sBox = getElementBoundingBox(selectedEl)
    anchorPos = {
      x: Math.min(BOARD_W - 350, sBox.x + sBox.w + DEFAULT_GAP),
      y: sBox.y,
    }
  }

  const place = (w: number, h: number, preferred?: { x: number; y: number }) =>
    findCollisionFreePosition(currentBoard, w, h, preferred, plannedBoxes, viewState, DEFAULT_GAP, container, occ)
  const newId = () => "ai_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
  const clean = (args: Record<string, any>) => {
    // Coerce numeric tool args once: NaN / Infinity / junk strings must never reach layout maths.
    const out: Record<string, any> = { ...args }
    for (const k of ["x", "y", "width", "height", "radius", "fontSize"]) {
      if (k in out) {
        const n = finiteNumber(out[k])
        if (n === undefined) delete out[k]
        else out[k] = n
      }
    }
    return out
  }

  interface CallInfo { sourceIndex: number; fc: any; name: string; args: Record<string, any>; id: string; alias?: string }
  const calls: CallInfo[] = functionCalls.map((fc, sourceIndex) => {
    const rawName = fc.name || fc.function_name || ""
    const name =
      rawName === "add_text" ? "write_text"
      : rawName === "add_line" ? "draw_line"
      : rawName === "add_arrow" ? "draw_arrow"
      : rawName
    const args = fc.args || fc.parameters || {}
    const id = fc.element_id || fc.functionCall?.element_id || newId()
    return { sourceIndex, fc, name, args, id, alias: typeof args.id === "string" ? args.id : undefined }
  })

  const isConnector = (n: string) => n === "draw_arrow" || n === "draw_line"
  const connectorCalls = calls.filter((c) => isConnector(c.name))
  const pathCalls = calls.filter((c) => c.name === "draw_path")
  const contentCalls = calls.filter((c) => !isConnector(c.name) && c.name !== "draw_path")

  // ---- Step 1: content dimensions (viewport aware)
  interface ContentPrep extends CallInfo {
    kind: ElementKind
    dims: { w: number; h: number; fontSize: number }
    explicit: boolean
  }
  const preppedContents: ContentPrep[] = contentCalls.map((c) => {
    const args = clean(c.args)
    let kind: ElementKind = "shape"
    if (c.name === "write_text") kind = "text"
    else if (c.name === "add_equation") kind = "equation"
    else if (c.name === "draw_rectangle") kind = "shape"
    else if (c.name === "draw_circle") kind = "circle"
    else if (c.name === "draw_triangle") kind = "triangle"
    else if (c.name === "generate_simulation" || c.name === "add_plot") kind = "simulation"
    else if (c.name === "generate_image") kind = "image"

    const dims = estimateContentDimensions(
      {
        kind,
        text: args.text,
        latex: args.latex,
        title: args.title,
        expression: args.expression,
        width: args.width,
        height: args.height,
        radius: args.radius,
        fontSize: args.fontSize,
        role: args.role,
      },
      vpAnalysis?.unobstructedVisibleRect
    )
    const explicit = args.x !== undefined && args.y !== undefined && !(args.x === 0 && args.y === 0)
    return { ...c, args, kind, dims, explicit }
  })

  // ---- Step 2: resolve line / arrow / path intents
  const known = new Set<string>(currentBoard.elements.map((e) => e.id))
  for (const c of calls) { known.add(c.id); if (c.alias) known.add(c.alias) }

  interface PathPrep { call: CallInfo; intent: NonNullable<ReturnType<typeof resolvePathIntent>> }
  const pathPreps: PathPrep[] = []
  for (const c of pathCalls) {
    const intent = resolvePathIntent(c.args)
    if (!intent) rejected.push({ name: c.name, reason: "draw_path needs a non-empty pathData string.", sourceIndex: c.sourceIndex })
    else pathPreps.push({ call: c, intent })
  }

  interface ConnPrep {
    call: CallInfo
    isArrow: boolean
    fromId?: string
    toId?: string
    attached: boolean
    segment: Segment | null
    anchored: boolean
  }
  const connPreps: ConnPrep[] = connectorCalls.map((c) => {
    const fromId = c.args.from_element_id || c.args.fromId || c.args.from
    const toId = c.args.to_element_id || c.args.toId || c.args.to
    const segment = readSegment(c.args)
    const anchored = !!segment && isMeaningfulBox(segmentBox(segment))
    const attached = !!((fromId && known.has(fromId)) || (toId && known.has(toId)))
    return { call: c, isArrow: c.name === "draw_arrow", fromId, toId, attached, segment, anchored }
  })

  const toItemBox = (b: RectBox): RectBox => ({ x: b.x, y: b.y, w: b.w, h: b.h })
  const unionOf = (boxes: RectBox[]): RectBox => {
    const x0 = Math.min(...boxes.map((b) => b.x))
    const y0 = Math.min(...boxes.map((b) => b.y))
    const x1 = Math.max(...boxes.map((b) => b.x + b.w))
    const y1 = Math.max(...boxes.map((b) => b.y + b.h))
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
  }
  const connBox = (s: Segment): RectBox => {
    const b = segmentBox(s)
    return { x: b.x, y: b.y, w: Math.max(16, b.w), h: Math.max(16, b.h) }
  }

  const freeGeometryCount = pathPreps.length + connPreps.length
  const isCoordinatedGroup =
    preppedContents.length >= 2 || (preppedContents.length >= 1 && freeGeometryCount >= 1)
  const allContentExplicit = preppedContents.length > 0 && preppedContents.every((p) => p.explicit)
  const contentRigid = isCoordinatedGroup && allContentExplicit

  const contentItems: LayoutItem[] = []
  const pathItems: LayoutItem[] = []
  const connectorItems: LayoutItem[] = []

  const pushContent = (p: ContentPrep, box: RectBox) => {
    plannedBoxes.push(box)
    const item: LayoutItem = {
      id: p.id,
      kind: p.kind,
      name: p.name,
      args: { ...p.args, x: box.x, y: box.y, w: p.dims.w, h: p.dims.h, groupId },
      box,
      author: "coach",
      groupId,
      sourceIndex: p.sourceIndex,
    }
    contentItems.push(item)
    plannedItems.push(item)
  }
  const pushPath = (pp: PathPrep, box: RectBox) => {
    plannedBoxes.push(box)
    const item: LayoutItem = {
      id: pp.call.id,
      kind: "path",
      name: pp.call.name,
      args: { ...pp.call.args, x: box.x, y: box.y, w: box.w, h: box.h, pathData: pp.intent.pathData, groupId },
      box,
      author: "coach",
      groupId,
      sourceIndex: pp.call.sourceIndex,
    }
    pathItems.push(item)
    plannedItems.push(item)
  }
  const pushConnector = (cp: ConnPrep, seg: Segment) => {
    const box = connBox(seg)
    plannedBoxes.push(box)
    const item: LayoutItem = {
      id: cp.call.id,
      kind: cp.isArrow ? "arrow" : "line",
      name: cp.call.name,
      args: {
        ...cp.call.args,
        x1: seg.x1,
        y1: seg.y1,
        x2: seg.x2,
        y2: seg.y2,
        fromId: cp.fromId,
        toId: cp.toId,
        groupId,
        color: cp.call.args.color || (cp.isArrow ? "#2563eb" : "#000000"),
      },
      box,
      author: "coach",
      groupId,
      sourceIndex: cp.call.sourceIndex,
    }
    connectorItems.push(item)
    plannedItems.push(item)
  }

  // ---- Step 3: content that has no usable anchors (flow layout / single item)
  if (!contentRigid && preppedContents.length > 0) {
    if (isCoordinatedGroup) {
      // Automatic visual hierarchy: vertical flow, then place the whole stack as one unit.
      let curY = 0
      let maxW = 0
      const rel = preppedContents.map((p) => {
        const r = { relX: 0, relY: curY }
        maxW = Math.max(maxW, p.dims.w)
        curY += p.dims.h + DEFAULT_GAP
        return r
      })
      const totalH = Math.max(0, curY - DEFAULT_GAP)
      const origin = place(maxW, totalH, anchorPos)
      preppedContents.forEach((p, i) =>
        pushContent(p, { x: origin.x + rel[i].relX, y: origin.y + rel[i].relY, w: p.dims.w, h: p.dims.h }),
      )
    } else {
      let lastPlacedBox: RectBox | null = null
      for (const p of preppedContents) {
        let prefX = p.args.x
        let prefY = p.args.y
        if (prefX === undefined || prefY === undefined || (prefX === 0 && prefY === 0)) {
          if (lastPlacedBox) {
            prefX = lastPlacedBox.x
            prefY = lastPlacedBox.y + lastPlacedBox.h + DEFAULT_GAP
          } else if (anchorPos) {
            prefX = anchorPos.x
            prefY = anchorPos.y
          }
        }
        const preferred = prefX !== undefined && prefY !== undefined ? { x: prefX, y: prefY } : undefined
        const pos = place(p.dims.w, p.dims.h, preferred)
        const box = { x: pos.x, y: pos.y, w: p.dims.w, h: p.dims.h }
        pushContent(p, box)
        lastPlacedBox = box
      }
    }
  }

  // ---- Step 4: the rigid body of anchored geometry (+ explicitly placed content)
  const freeConns = connPreps.filter((c) => !c.attached)
  const anchoredPaths = pathPreps.filter((p) => p.intent.anchored)
  const anchoredConns = freeConns.filter((c) => c.anchored)
  const rigidContents = contentRigid ? preppedContents : []
  const rigidBoxes: RectBox[] = [
    ...rigidContents.map((p) => ({ x: p.args.x as number, y: p.args.y as number, w: p.dims.w, h: p.dims.h })),
    ...anchoredPaths.map((p) => toItemBox(p.intent.box)),
    ...anchoredConns.map((c) => connBox(c.segment as Segment)),
  ]
  if (rigidBoxes.length > 0) {
    const union = unionOf(rigidBoxes)
    const hasContentLike = rigidContents.length > 0 || anchoredPaths.length > 0
    let dx = 0
    let dy = 0
    if (hasContentLike) {
      const preferred = anchorPos || { x: union.x, y: union.y }
      const origin = place(union.w, union.h, preferred)
      dx = origin.x - union.x
      dy = origin.y - union.y
    }
    for (const p of rigidContents) {
      pushContent(p, { x: (p.args.x as number) + dx, y: (p.args.y as number) + dy, w: p.dims.w, h: p.dims.h })
    }
    for (const pp of anchoredPaths) {
      const b = pp.intent.box
      pushPath(pp, { x: b.x + dx, y: b.y + dy, w: b.w, h: b.h })
    }
    for (const cp of anchoredConns) {
      pushConnector(cp, translateSegment(cp.segment as Segment, dx, dy))
    }
  }

  // ---- Step 5: geometry without usable anchors is placed in free space, keeping its own shape
  let lastFlowBox: RectBox | null = contentItems.length > 0 ? contentItems[contentItems.length - 1].box : null
  for (const pp of pathPreps.filter((p) => !p.intent.anchored)) {
    const b = pp.intent.box
    const pos = place(b.w, b.h, anchorPos || (lastFlowBox ? { x: lastFlowBox.x, y: lastFlowBox.y + lastFlowBox.h + DEFAULT_GAP } : undefined))
    pushPath(pp, { x: pos.x, y: pos.y, w: b.w, h: b.h })
    lastFlowBox = pathItems[pathItems.length - 1].box
  }

  const contentBoxesForAutoConnect = () => contentItems.map((i) => i.box)
  for (const cp of freeConns.filter((c) => !c.anchored)) {
    if (cp.segment) {
      // Valid vector, but parked at the origin: keep its direction and length, only translate it.
      const b = connBox(cp.segment)
      const realBox = segmentBox(cp.segment)
      const pos = place(b.w, b.h, anchorPos)
      pushConnector(cp, translateSegment(cp.segment, pos.x - realBox.x, pos.y - realBox.y))
    } else if (contentBoxesForAutoConnect().length >= 2) {
      const boxes = contentBoxesForAutoConnect()
      const e = computeArrowEndpoints(boxes[boxes.length - 2], boxes[boxes.length - 1])
      pushConnector(cp, { x1: e.x1, y1: e.y1, x2: e.x2, y2: e.y2 })
    } else {
      // No usable coordinates and nothing to connect: a default horizontal segment in free space.
      const pos = place(DEFAULT_LINE_LENGTH, 16, anchorPos)
      pushConnector(cp, { x1: pos.x, y1: pos.y, x2: pos.x + DEFAULT_LINE_LENGTH, y2: pos.y })
    }
  }

  // ---- Step 6: connectors attached by id to the final positions of the elements they name
  for (const cp of connPreps.filter((c) => c.attached)) {
    const lookup = (id?: string) => {
      if (!id) return null
      const planned = plannedItems.find((i) => i.id === id || i.args.id === id)
      if (planned) return planned.box
      const existing = currentBoard.elements.find((e) => e.id === id)
      return existing ? getElementBoundingBox(existing) : null
    }
    const fromBox = lookup(cp.fromId)
    const toBox = lookup(cp.toId)
    let seg: Segment | null = cp.segment
    if (fromBox && toBox) {
      const e = computeArrowEndpoints(fromBox, toBox)
      seg = { x1: e.x1, y1: e.y1, x2: e.x2, y2: e.y2 }
    } else if (fromBox) {
      seg = { x1: fromBox.x + fromBox.w, y1: Math.round(fromBox.y + fromBox.h / 2), x2: fromBox.x + fromBox.w + DEFAULT_LINE_LENGTH, y2: Math.round(fromBox.y + fromBox.h / 2) }
      if (cp.segment) seg = { ...seg, x2: cp.segment.x2, y2: cp.segment.y2 }
    } else if (toBox) {
      const y = Math.round(toBox.y + toBox.h / 2)
      seg = { x1: toBox.x - DEFAULT_LINE_LENGTH, y1: y, x2: toBox.x, y2: y }
      if (cp.segment) seg = { x1: cp.segment.x1, y1: cp.segment.y1, x2: toBox.x, y2: y }
    }
    pushConnector(cp, seg ?? { x1: 100, y1: 100, x2: 100 + DEFAULT_LINE_LENGTH, y2: 100 })
  }

  const viewTarget = plannedItems.length > 0 ? {
    x: Math.round(plannedItems[0].box.x + plannedItems[0].box.w / 2),
    y: Math.round(plannedItems[0].box.y + plannedItems[0].box.h / 2),
  } : undefined

  // Stable, documented order: content (call order), then paths, then connectors.
  const ordered = [...contentItems, ...pathItems, ...connectorItems].sort((a, b) => {
    const rank = (i: LayoutItem) => (i.kind === "arrow" || i.kind === "line" ? 2 : i.kind === "path" ? 1 : 0)
    return rank(a) - rank(b) || a.sourceIndex - b.sourceIndex
  })

  return {
    items: ordered,
    rejected,
    viewTarget,
    groupId,
  }
}

export interface BoardStateAnalysis {
  studentElements: BoardElement[]
  coachElements: BoardElement[]
  totalElements: number
  totalStrokes: number
  occupiedBoxes: RectBox[]
  occupiedAreaFraction: number
  summary: string
}

/**
 * Reads and analyzes current board state, categorizing student vs coach work
 * and calculating canvas occupancy.
 */
export function readBoardState(board: Board): BoardStateAnalysis {
  const studentElements = board.elements.filter((e) => e.author === "student")
  const coachElements = board.elements.filter((e) => e.author === "coach")
  const occupiedBoxes = board.elements.map(getElementBoundingBox)
  const totalOccupiedArea = occupiedBoxes.reduce((acc, b) => acc + b.w * b.h, 0)
  const canvasArea = BOARD_W * BOARD_H
  const occupiedAreaFraction = Math.min(1, Math.round((totalOccupiedArea / canvasArea) * 100) / 100)

  let summary = `Board has ${board.elements.length} elements (${studentElements.length} student, ${coachElements.length} coach) and ${board.strokes.length} strokes.`
  if (studentElements.length > 0) {
    const studentItems = studentElements
      .map((e) => e.text || e.latex || e.kind)
      .slice(0, 3)
      .join(", ")
    summary += ` Student work: [${studentItems}].`
  }
  summary += ` Board occupancy: ${Math.round(occupiedAreaFraction * 100)}%.`

  return {
    studentElements,
    coachElements,
    totalElements: board.elements.length,
    totalStrokes: board.strokes.length,
    occupiedBoxes,
    occupiedAreaFraction,
    summary,
  }
}

/**
 * Verifies post-render bounding boxes and reflows coach elements if text wrapping
 * or latex rendering created unexpected overlaps. Never moves student work.
 * Preserves connector endpoints so arrows stay attached and do not pierce shapes.
 *
 * `options.onlyIds` limits which elements may be resized or shifted (everything else is still treated as
 * an obstacle). The AI pipeline passes the ids it just added so that older content never moves merely
 * because a new batch landed next to it.
 */
export function verifyAndReflowLayout(
  board: Board,
  renderedBounds: Record<string, RectBox> | Map<string, RectBox>,
  buffer = 20,
  options: { onlyIds?: ReadonlySet<string> } = {},
): { needsReflow: boolean; updatedElements: BoardElement[] } {
  const boundsMap = renderedBounds instanceof Map ? renderedBounds : new Map(Object.entries(renderedBounds))
  const mayChange = (el: BoardElement) => !options.onlyIds || options.onlyIds.has(el.id)
  let needsReflow = false
  const updatedElements: BoardElement[] = board.elements.map((el) => ({ ...el }))
  const shiftDeltas = new Map<string, { dx: number; dy: number; oldBox: RectBox }>()

  for (let i = 0; i < updatedElements.length; i++) {
    const el = updatedElements[i]
    // Sync sizes from the DOM (text grows past its estimate) so collisions use the real footprint, but
    // not for rotated elements (the DOM reports their AXIS-ALIGNED box, so copying it into w/h would
    // make the element grow a little more on every reflow) or connectors (sized from endpoints).
    if (!mayChange(el) || el.rotation || el.kind === "arrow" || el.kind === "line") continue
    const actual = boundsMap.get(el.id)
    if (actual && (Math.abs(actual.w - el.w) > 10 || Math.abs(actual.h - el.h) > 10)) {
      el.w = actual.w
      el.h = actual.h
    }
  }

  // Check pairwise collisions among elements. If a coach element overlaps any previous element,
  // shift the coach element down to resolve overlap.
  for (let i = 0; i < updatedElements.length; i++) {
    const current = updatedElements[i]
    if (current.author === "student") continue // Student elements are strictly protected!
    if (!mayChange(current)) continue
    if (current.kind === "arrow" || current.kind === "line") continue // Connectors adjusted after nodes settle

    const initialBox = getElementBoundingBox(current)
    let currentBox = initialBox

    for (let j = 0; j < updatedElements.length; j++) {
      if (i === j) continue
      const other = updatedElements[j]
      if (other.kind === "arrow" || other.kind === "line") continue
      const otherBox = getElementBoundingBox(other)

      if (doBoxesIntersect(currentBox, otherBox, buffer)) {
        if (other.author === "student" || j < i) {
          const shiftY = otherBox.y + otherBox.h + buffer - current.y
          // Never push content past the bottom edge of the board; an overlap is better than lost content.
          if (shiftY > 0 && currentBox.y + currentBox.h + shiftY <= BOARD_H - BOARD_PADDING) {
            current.y += shiftY
            needsReflow = true
            currentBox = getElementBoundingBox(current)
            shiftDeltas.set(current.id, {
              dx: 0,
              dy: (shiftDeltas.get(current.id)?.dy || 0) + shiftY,
              oldBox: initialBox,
            })
          }
        }
      }
    }
  }

  // Reconnect only the connectors that actually touch a shifted element.
  if (shiftDeltas.size > 0) {
    const writeConnector = (el: BoardElement, seg: Segment) => {
      if (el.kind === "arrow") Object.assign(el, arrowElementGeometry(seg))
      else Object.assign(el, lineElementGeometry(seg))
    }
    for (const el of updatedElements) {
      if ((el.kind !== "arrow" && el.kind !== "line") || !mayChange(el)) continue
      const fromEl = el.fromId ? updatedElements.find((e) => e.id === el.fromId) : undefined
      const toEl = el.toId ? updatedElements.find((e) => e.id === el.toId) : undefined

      if (fromEl && toEl) {
        // Explicitly connected by IDs: recompute exact perimeter endpoints, but only if one end moved.
        if (!shiftDeltas.has(fromEl.id) && !shiftDeltas.has(toEl.id)) continue
        const e = computeArrowEndpoints(getElementBoundingBox(fromEl), getElementBoundingBox(toEl))
        writeConnector(el, { x1: e.x1, y1: e.y1, x2: e.x2, y2: e.y2 })
        needsReflow = true
        continue
      }

      // Not connected by IDs: move an endpoint only if it was touching a shifted element's old box.
      const seg = connectorEndpoints(el)
      let { x1, y1, x2, y2 } = seg
      let touched = false
      for (const [, delta] of shiftDeltas.entries()) {
        const b = delta.oldBox
        const near = (x: number, y: number) =>
          x >= b.x - buffer && x <= b.x + b.w + buffer && y >= b.y - buffer && y <= b.y + b.h + buffer
        if (near(seg.x1, seg.y1)) { y1 += delta.dy; touched = true }
        if (near(seg.x2, seg.y2)) { y2 += delta.dy; touched = true }
      }
      if (touched) {
        writeConnector(el, { x1, y1, x2, y2 })
        needsReflow = true
      }
    }
  }

  return { needsReflow, updatedElements }
}
