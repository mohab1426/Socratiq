import type { Pt, Rect, SceneEl } from "./types"

export const rect = (x: number, y: number, w: number, h: number): Rect => ({ x, y, w, h })
export const right = (r: Rect) => r.x + r.w
export const bottom = (r: Rect) => r.y + r.h
export const center = (r: Rect): Pt => [r.x + r.w / 2, r.y + r.h / 2]
export const inflate = (r: Rect, m: number): Rect => ({ x: r.x - m, y: r.y - m, w: r.w + 2 * m, h: r.h + 2 * m })
export const area = (r: Rect) => Math.max(0, r.w) * Math.max(0, r.h)

export function union(rs: readonly Rect[]): Rect | null {
  if (rs.length === 0) return null
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity
  for (const r of rs) { x1 = Math.min(x1, r.x); y1 = Math.min(y1, r.y); x2 = Math.max(x2, right(r)); y2 = Math.max(y2, bottom(r)) }
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 }
}

/** True when the rectangles overlap by more than `margin` of clearance (edges that merely touch do not overlap at margin 0). */
export function rectsIntersect(a: Rect, b: Rect, margin = 0): boolean {
  return a.x - margin < right(b) && right(a) + margin > b.x && a.y - margin < bottom(b) && bottom(a) + margin > b.y
}

export function overlapArea(a: Rect, b: Rect): number {
  const w = Math.min(right(a), right(b)) - Math.max(a.x, b.x)
  const h = Math.min(bottom(a), bottom(b)) - Math.max(a.y, b.y)
  return w > 0 && h > 0 ? w * h : 0
}

export const containsRect = (outer: Rect, inner: Rect) => inner.x >= outer.x && inner.y >= outer.y && right(inner) <= right(outer) && bottom(inner) <= bottom(outer)

/** Shortest distance between two rectangles (0 when they touch or overlap). */
export function rectGap(a: Rect, b: Rect): number {
  const dx = Math.max(0, Math.max(a.x - right(b), b.x - right(a)))
  const dy = Math.max(0, Math.max(a.y - bottom(b), b.y - bottom(a)))
  return Math.hypot(dx, dy)
}

/** Liang-Barsky: does the segment p-q touch the rectangle (inflated by `pad`)? */
export function segmentIntersectsRect(p: Pt, q: Pt, r: Rect, pad = 0): boolean {
  const x1 = r.x - pad, y1 = r.y - pad, x2 = right(r) + pad, y2 = bottom(r) + pad
  const dx = q[0] - p[0], dy = q[1] - p[1]
  let t0 = 0, t1 = 1
  const clip = (pp: number, qq: number): boolean => {
    if (pp === 0) return qq >= 0
    const t = qq / pp
    if (pp < 0) { if (t > t1) return false; if (t > t0) t0 = t } else { if (t < t0) return false; if (t < t1) t1 = t }
    return true
  }
  return clip(-dx, p[0] - x1) && clip(dx, x2 - p[0]) && clip(-dy, p[1] - y1) && clip(dy, y2 - p[1])
}

export function polylineIntersectsRect(pts: readonly Pt[], r: Rect, pad = 0): boolean {
  if (pts.length === 0) return false
  if (pts.length === 1) return pts[0][0] >= r.x - pad && pts[0][0] <= right(r) + pad && pts[0][1] >= r.y - pad && pts[0][1] <= bottom(r) + pad
  for (let i = 0; i < pts.length - 1; i++) if (segmentIntersectsRect(pts[i], pts[i + 1], r, pad)) return true
  return false
}

export function pointsBounds(pts: readonly Pt[]): Rect | null {
  if (pts.length === 0) return null
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity
  for (const [x, y] of pts) { x1 = Math.min(x1, x); y1 = Math.min(y1, y); x2 = Math.max(x2, x); y2 = Math.max(y2, y) }
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 }
}

const rotate = (p: Pt, c: Pt, a: number): Pt => {
  if (!a) return p
  const cos = Math.cos(a), sin = Math.sin(a)
  const dx = p[0] - c[0], dy = p[1] - c[1]
  return [c[0] + dx * cos - dy * sin, c[1] + dx * sin + dy * cos]
}

export const isLinear = (el: Pick<SceneEl, "type">) => el.type === "line" || el.type === "arrow"
export const isPathLike = (el: Pick<SceneEl, "type">) => el.type === "line" || el.type === "arrow" || el.type === "freedraw"

/** Absolute (scene) coordinates of a path element's points, honouring rotation about the points' own centre. */
export function absolutePoints(el: SceneEl): Pt[] {
  const local = el.points && el.points.length > 0 ? el.points : [[0, 0], [el.width, el.height]] as Pt[]
  const abs = local.map(([px, py]) => [el.x + px, el.y + py] as Pt)
  if (!el.angle) return abs
  const b = pointsBounds(abs)!
  const c: Pt = [b.x + b.w / 2, b.y + b.h / 2]
  return abs.map((p) => rotate(p, c, el.angle!))
}

/** Axis-aligned bounds of a box element after rotation. */
export function rotatedBoxBounds(el: Pick<SceneEl, "x" | "y" | "width" | "height" | "angle">): Rect {
  const w = Math.abs(el.width), h = Math.abs(el.height)
  const x = el.width < 0 ? el.x + el.width : el.x
  const y = el.height < 0 ? el.y + el.height : el.y
  if (!el.angle) return { x, y, w, h }
  const c: Pt = [x + w / 2, y + h / 2]
  const corners = ([[x, y], [x + w, y], [x + w, y + h], [x, y + h]] as Pt[]).map((p) => rotate(p, c, el.angle!))
  return pointsBounds(corners)!
}

/** Stroke allowance so a thick stroke or an arrowhead near the edge still counts as occupied. */
export const strokePad = (el: Pick<SceneEl, "type" | "strokeWidth">) => (el.strokeWidth ?? 2) / 2 + (el.type === "arrow" ? 10 : 2)

/**
 * Conservative axis-aligned bounds of ANY element. This is the geometry the placement engine reasons with:
 * - path-like elements use their points (not x/y/width/height, which for lines can be 0 or stale);
 * - text and images use their measured box plus a small readability allowance;
 * - everything respects rotation.
 */
export function elementBounds(el: SceneEl): Rect {
  if (isPathLike(el)) {
    const b = pointsBounds(absolutePoints(el)) ?? rotatedBoxBounds(el)
    return inflate(b, strokePad(el))
  }
  const b = rotatedBoxBounds(el)
  return el.type === "text" ? inflate(b, 4) : inflate(b, (el.strokeWidth ?? 1) / 2)
}
