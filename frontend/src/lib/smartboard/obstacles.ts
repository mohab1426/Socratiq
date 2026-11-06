import { absolutePoints, elementBounds, inflate, isPathLike, pointsBounds, polylineIntersectsRect, rectsIntersect, strokePad } from "./geometry"
import { authorOf } from "./meta"
import type { Author, Pt, Rect, SceneEl } from "./types"

/** One thing on the board that new content must not cover. */
export interface Obstacle {
  id: string
  type: string
  author: Author
  /** Conservative bounds (always set). */
  rect: Rect
  /** Present for open paths (lines, arrows, open strokes): collision is tested against the actual segments, not the bounds. */
  path?: { pts: readonly Pt[]; pad: number }
  groupId?: string
}

const CELL = 256
const MAX_CELLS_PER_OBSTACLE = 400

/** A closed stroke / polygon / filled shape encloses area, so its whole bounding box is treated as occupied. */
function isClosedOrFilled(el: SceneEl, pts: readonly Pt[]): boolean {
  if (el.polygon) return true
  if (el.type === "line" && el.backgroundColor && el.backgroundColor !== "transparent" && pts.length > 2) return true
  if (el.type === "freedraw" && pts.length > 3) {
    const b = pointsBounds(pts)!
    const diag = Math.hypot(b.w, b.h)
    const gap = Math.hypot(pts[0][0] - pts[pts.length - 1][0], pts[0][1] - pts[pts.length - 1][1])
    return diag > 0 && gap < diag * 0.2
  }
  return false
}

export function buildObstacle(el: SceneEl, byId: ReadonlyMap<string, SceneEl>): Obstacle | null {
  if (el.isDeleted) return null
  // A label bound to a box lives inside the box's bounds, so the box already covers it. A label bound to an ARROW sits on the path and must be kept.
  if (el.type === "text" && el.containerId) {
    const c = byId.get(el.containerId)
    if (c && !c.isDeleted && !isPathLike(c)) return null
  }
  const groupId = el.groupIds && el.groupIds.length > 0 ? el.groupIds[el.groupIds.length - 1] : undefined
  const base = { id: el.id, type: el.type, author: authorOf(el), groupId }
  if (isPathLike(el)) {
    const pts = absolutePoints(el)
    if (!isClosedOrFilled(el, pts)) return { ...base, rect: elementBounds(el), path: { pts, pad: strokePad(el) } }
  }
  return { ...base, rect: elementBounds(el) }
}

/** Uniform-grid spatial index over the protected content of a board. Built once per AI insertion (never per pointer move). */
export class ObstacleIndex {
  readonly obstacles: Obstacle[]
  private cells = new Map<string, number[]>()
  private big: number[] = []

  constructor(elements: readonly SceneEl[]) {
    const byId = new Map(elements.map((e) => [e.id, e]))
    this.obstacles = []
    for (const el of elements) {
      const o = buildObstacle(el, byId)
      if (!o || !Number.isFinite(o.rect.x + o.rect.y + o.rect.w + o.rect.h)) continue
      const i = this.obstacles.push(o) - 1
      const [cx1, cy1, cx2, cy2] = this.span(o.rect)
      if ((cx2 - cx1 + 1) * (cy2 - cy1 + 1) > MAX_CELLS_PER_OBSTACLE) { this.big.push(i); continue }
      for (let cx = cx1; cx <= cx2; cx++) for (let cy = cy1; cy <= cy2; cy++) {
        const k = cx + "," + cy
        const list = this.cells.get(k)
        if (list) list.push(i); else this.cells.set(k, [i])
      }
    }
  }

  private span(r: Rect): [number, number, number, number] {
    return [Math.floor(r.x / CELL), Math.floor(r.y / CELL), Math.floor((r.x + r.w) / CELL), Math.floor((r.y + r.h) / CELL)]
  }

  /** Obstacles that `r` would collide with when it must keep `margin` clearance. */
  hits(r: Rect, margin = 0): Obstacle[] {
    const probe = inflate(r, margin)
    const [cx1, cy1, cx2, cy2] = this.span(probe)
    const seen = new Set<number>(this.big)
    if ((cx2 - cx1 + 1) * (cy2 - cy1 + 1) > MAX_CELLS_PER_OBSTACLE * 4) for (let i = 0; i < this.obstacles.length; i++) seen.add(i)
    else for (let cx = cx1; cx <= cx2; cx++) for (let cy = cy1; cy <= cy2; cy++) for (const i of this.cells.get(cx + "," + cy) ?? []) seen.add(i)
    const out: Obstacle[] = []
    for (const i of seen) {
      const o = this.obstacles[i]
      if (!rectsIntersect(r, o.rect, margin)) continue
      if (o.path && !polylineIntersectsRect(o.path.pts, r, margin + o.path.pad)) continue
      out.push(o)
    }
    return out
  }

  collides(r: Rect, margin = 0): boolean {
    return this.hits(r, margin).length > 0
  }

  /** Does a polyline (e.g. a new arrow route) run through any obstacle? Endpoints touching `ignore` ids are allowed. */
  pathHits(pts: readonly Pt[], pad = 0, ignore: ReadonlySet<string> = new Set()): Obstacle[] {
    const out: Obstacle[] = []
    for (const o of this.obstacles) {
      if (ignore.has(o.id)) continue
      if (!polylineIntersectsRect(pts, o.rect, pad)) continue
      if (o.path) {
        // Path-vs-path: sample the obstacle's segments against thin boxes around our segments.
        let hit = false
        for (let i = 0; i < pts.length - 1 && !hit; i++) {
          const seg = pointsBounds([pts[i], pts[i + 1]])!
          hit = polylineIntersectsRect(o.path.pts, inflate(seg, pad), o.path.pad) && segmentsCross(pts[i], pts[i + 1], o.path.pts)
        }
        if (!hit) continue
      }
      out.push(o)
    }
    return out
  }

  get bounds(): Rect | null {
    if (this.obstacles.length === 0) return null
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity
    for (const o of this.obstacles) { x1 = Math.min(x1, o.rect.x); y1 = Math.min(y1, o.rect.y); x2 = Math.max(x2, o.rect.x + o.rect.w); y2 = Math.max(y2, o.rect.y + o.rect.h) }
    return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 }
  }
}

const orient = (a: Pt, b: Pt, c: Pt) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
function segCross(p1: Pt, p2: Pt, p3: Pt, p4: Pt): boolean {
  const d1 = orient(p3, p4, p1), d2 = orient(p3, p4, p2), d3 = orient(p1, p2, p3), d4 = orient(p1, p2, p4)
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))
}
function segmentsCross(a: Pt, b: Pt, other: readonly Pt[]): boolean {
  for (let i = 0; i < other.length - 1; i++) if (segCross(a, b, other[i], other[i + 1])) return true
  return false
}
