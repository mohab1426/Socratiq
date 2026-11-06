import { BOARD_W, BOARD_H } from "@/lib/whiteboard"

/**
 * Viewport helpers for the SmartBoard workspace.
 *
 * Coordinate model (unchanged, shared with boardLayoutEngine.computeUnobstructedVisibleViewport):
 *   - The logical board is always BOARD_W x BOARD_H (2000 x 1200).
 *   - view.x / view.y is the BOARD coordinate that sits at the top-left corner of the drawing surface.
 *   - view.scale is screen px per board unit.
 *   - Board point (bx, by) therefore renders at ((bx - view.x) * scale, (by - view.y) * scale)
 *     relative to the top-left of the drawing surface.
 */

export interface View {
  x: number
  y: number
  scale: number
}

export interface Occlusion {
  top: number
  bottom: number
  left: number
  right: number
}

export interface FitBox {
  x: number
  y: number
  w: number
  h: number
}

export const MIN_SCALE = 0.1
export const MAX_FIT_SCALE_EMPTY = 1.0
export const MAX_FIT_SCALE_CONTENT = 1.2
/** Breathing room kept around the fitted board so its edge never touches the container edge. */
export const FIT_MARGIN = 12
const CONTENT_PAD = 80
const MIN_CONTENT_SPAN = 300

/** A container is only measurable once it has real, non-zero layout dimensions. */
export function isUsableSize(width: number | undefined | null, height: number | undefined | null): boolean {
  return Number.isFinite(width) && Number.isFinite(height) && (width as number) > 1 && (height as number) > 1
}

export const NO_OCCLUSION: Occlusion = { top: 0, bottom: 0, left: 0, right: 0 }

/**
 * Never let floating UI eat the whole container (e.g. a very short landscape phone with the chat open).
 * Shared by the fit/reveal view maths AND the placement engine's visible-region maths so both agree on
 * what "unobstructed" means. Negative / non-finite values count as 0.
 */
export function capOcclusion(
  occlusion: Partial<Occlusion> | null | undefined,
  container: { width: number; height: number },
): Occlusion {
  const v = (n: number | undefined) => (typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0)
  return {
    top: Math.min(v(occlusion?.top), container.height * 0.4),
    bottom: Math.min(v(occlusion?.bottom), container.height * 0.4),
    left: Math.min(v(occlusion?.left), container.width * 0.3),
    right: Math.min(v(occlusion?.right), container.width * 0.3),
  }
}

/**
 * Compute the view that fits `box` (board coordinates) into the part of the container that is not
 * covered by floating UI, and centres it in that unobstructed region.
 *
 * Returns null when the container has no real size, so callers never fit against a hidden or
 * not-yet-laid-out element.
 */
export function computeFitView(
  container: { width: number; height: number },
  box: FitBox,
  occlusion: Occlusion = NO_OCCLUSION,
  opts: { maxScale?: number; margin?: number } = {},
): View | null {
  if (!isUsableSize(container.width, container.height)) return null

  const margin = opts.margin ?? FIT_MARGIN
  const maxScale = opts.maxScale ?? MAX_FIT_SCALE_EMPTY

  const { top: occTop, bottom: occBottom, left: occLeft, right: occRight } = capOcclusion(occlusion, container)

  const usableW = Math.max(1, container.width - occLeft - occRight - margin * 2)
  const usableH = Math.max(1, container.height - occTop - occBottom - margin * 2)

  const scale = Math.max(MIN_SCALE, Math.min(maxScale, usableW / box.w, usableH / box.h))

  // Screen-space centre of the unobstructed region, measured from the container's top-left.
  const screenCx = occLeft + (container.width - occLeft - occRight) / 2
  const screenCy = occTop + (container.height - occTop - occBottom) / 2

  const boxCx = box.x + box.w / 2
  const boxCy = box.y + box.h / 2

  return {
    x: boxCx - screenCx / scale,
    y: boxCy - screenCy / scale,
    scale,
  }
}

/** The whole logical board, used when there is no content to frame. */
export const FULL_BOARD_BOX: FitBox = { x: 0, y: 0, w: BOARD_W, h: BOARD_H }

/** Bounding box of existing content, padded; the same framing handleFitView has always used. */
export function contentFitBox(elements: ReadonlyArray<{ x: number; y: number; w: number; h: number }>): FitBox {
  if (elements.length === 0) return FULL_BOARD_BOX
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const el of elements) {
    minX = Math.min(minX, el.x)
    minY = Math.min(minY, el.y)
    maxX = Math.max(maxX, el.x + el.w)
    maxY = Math.max(maxY, el.y + el.h)
  }
  const spanW = Math.max(MIN_CONTENT_SPAN, maxX - minX + CONTENT_PAD * 2)
  const spanH = Math.max(MIN_CONTENT_SPAN, maxY - minY + CONTENT_PAD * 2)
  const cx = (minX + maxX) / 2
  const cy = (minY + maxY) / 2
  return { x: cx - spanW / 2, y: cy - spanH / 2, w: spanW, h: spanH }
}

/** Selector for floating UI that sits on top of the canvas (toolbars, zoom controls, chat dock). */
export const OCCLUDER_ATTR = "data-board-occluder"

/**
 * Measure how far floating UI intrudes into the drawing area from each edge, using real layout
 * rectangles rather than guessed constants. Occluders in the upper half count against the top edge,
 * occluders in the lower half against the bottom edge, and likewise left/right for very narrow
 * side docks (none exist today, but the model stays symmetric).
 *
 * Returns null if nothing could be measured (e.g. jsdom, where every rect is zero), so callers can
 * fall back to a conservative default.
 */
export function measureOcclusion(area: HTMLElement | null): Occlusion | null {
  if (!area) return null
  const areaRect = area.getBoundingClientRect()
  if (!isUsableSize(areaRect.width, areaRect.height)) return null

  const occ: Occlusion = { top: 0, bottom: 0, left: 0, right: 0 }
  let measured = false
  const midY = areaRect.top + areaRect.height / 2

  area.querySelectorAll<HTMLElement>(`[${OCCLUDER_ATTR}]`).forEach((el) => {
    const r = el.getBoundingClientRect()
    if (r.width < 1 || r.height < 1) return
    // Ignore anything entirely outside the area.
    if (r.bottom <= areaRect.top || r.top >= areaRect.bottom || r.right <= areaRect.left || r.left >= areaRect.right) return
    measured = true
    if (r.top + r.height / 2 < midY) {
      occ.top = Math.max(occ.top, r.bottom - areaRect.top)
    } else {
      occ.bottom = Math.max(occ.bottom, areaRect.bottom - r.top)
    }
  })

  return measured ? occ : null
}

// ---- Zoom, pan and clamping (pure, shared by the wheel, drag and pinch handlers) -------------------

export const MAX_SCALE = 5
/** How much of the board must stay on screen so it can never be panned completely out of reach. */
export const MIN_VISIBLE_BOARD_PX = 120

export function clampScale(scale: number, min = MIN_SCALE, max = MAX_SCALE): number {
  if (!Number.isFinite(scale)) return min
  return Math.max(min, Math.min(max, scale))
}

/** Board coordinate under a screen point (px relative to the drawing surface's top-left). */
export function screenToBoard(view: View, sx: number, sy: number): { x: number; y: number } {
  return { x: view.x + sx / view.scale, y: view.y + sy / view.scale }
}

/** Screen point (px relative to the drawing surface's top-left) of a board coordinate. */
export function boardToScreen(view: View, bx: number, by: number): { x: number; y: number } {
  return { x: (bx - view.x) * view.scale, y: (by - view.y) * view.scale }
}

/**
 * Zoom to `nextScale` while keeping the board point under the screen point (`sx`,`sy`) fixed.
 * The scale is clamped first, so the focal point stays fixed even at the zoom limits.
 */
export function zoomAtPoint(view: View, sx: number, sy: number, nextScale: number): View {
  const scale = clampScale(nextScale)
  return { x: view.x + sx / view.scale - sx / scale, y: view.y + sy / view.scale - sy / scale, scale }
}

/**
 * Multiplicative zoom factor for one wheel event. Proportional to the wheel delta so a trackpad pinch
 * (many tiny events) and a mouse wheel notch (one big event) both feel natural; a fixed step per
 * event made pinch zoom race. `deltaMode` 1 = lines, 2 = pages.
 */
export function wheelZoomFactor(deltaY: number, deltaMode = 0): number {
  const px = deltaMode === 1 ? deltaY * 16 : deltaMode === 2 ? deltaY * 100 : deltaY
  return Math.max(0.5, Math.min(2, Math.exp(-px * 0.0025)))
}

/**
 * Keep at least `minVisiblePx` of the board inside the container on every axis. Returns the same
 * object when already valid, and the input unchanged when the container has no real size yet.
 */
export function clampViewToBoard(
  view: View,
  container: { width: number; height: number },
  minVisiblePx = MIN_VISIBLE_BOARD_PX,
): View {
  if (!isUsableSize(container.width, container.height)) return view
  const s = clampScale(view.scale)
  const mx = Math.min(minVisiblePx, container.width / 2)
  const my = Math.min(minVisiblePx, container.height / 2)
  const x = Math.max(-(container.width - mx) / s, Math.min(BOARD_W - mx / s, view.x))
  const y = Math.max(-(container.height - my) / s, Math.min(BOARD_H - my / s, view.y))
  if (x === view.x && y === view.y && s === view.scale) return view
  return { x, y, scale: s }
}

/**
 * View that brings `boxes` (board coordinates) into the unobstructed part of the container. Used by
 * "Show new content". It never zooms IN past the current scale (so reaching new content doesn't change
 * how large things look) and only zooms OUT when the boxes do not fit at the current scale.
 */
export function computeRevealView(
  container: { width: number; height: number },
  boxes: ReadonlyArray<{ x: number; y: number; w: number; h: number }>,
  occlusion: Occlusion,
  current: View,
): View | null {
  if (boxes.length === 0) return null
  return computeFitView(container, contentFitBox(boxes), occlusion, { maxScale: Math.max(MIN_SCALE, current.scale) })
}
