/**
 * Stage 5: board-aware placement. Pure and deterministic: the same board, size, viewport and anchor always give the same answer.
 *
 * Contract (the "absolute preservation" rules):
 * - Placement only ever RETURNS A POSITION for new content. It never moves, resizes or deletes anything on the board.
 * - A candidate that collides with any existing element (student, AI or coach) at the required clearance is rejected, not penalised.
 * - A safe region always exists unless the content itself is unusably large, because the "extend the workspace" candidates sit
 *   outside the bounds of everything already on the board.
 */
import { area, bottom, center, containsRect, inflate, overlapArea, rectGap, right, union } from "./geometry"
import { ObstacleIndex } from "./obstacles"
import { MAX_SCENE_COORD, type Rect, type SceneEl } from "./types"

export interface Anchor {
  rect: Rect
  ids: string[]
  /** 0..1: how sure we are this is the content the request is about (1 = the student selected it). */
  confidence: number
  kind: "selection" | "model" | "semantic" | "recent"
  rtl?: boolean
}

export interface PlacementInput {
  size: { w: number; h: number }
  viewport?: Rect | null
  anchor?: Anchor | null
  margin?: number
  /** Extra check run on the best candidates (e.g. arrow routes). Return a reason string to reject, or null to accept. */
  validate?: (rect: Rect) => string | null
  maxValidations?: number
}

export type Strategy = "empty-board" | "anchor" | "viewport" | "nearby" | "extend"

export type PlacementResult =
  | { ok: true; x: number; y: number; rect: Rect; strategy: Strategy; score: number; visible: boolean; candidatesEvaluated: number; rejected: number; diagnostics: string[] }
  | { ok: false; reason: string; diagnostics: string[] }

export const DEFAULT_MARGIN = 32
export const MAX_GROUP_SIDE = 6000

interface Cand { x: number; y: number; strategy: Strategy; tag: string }

const snap = (n: number) => Math.round(n / 8) * 8

export function findPlacement(index: ObstacleIndex, input: PlacementInput): PlacementResult {
  const diagnostics: string[] = []
  const { w, h } = input.size
  const margin = input.margin ?? DEFAULT_MARGIN
  if (!(w > 0 && h > 0) || !Number.isFinite(w + h)) return { ok: false, reason: "invalid_size", diagnostics: [`group size ${w}x${h} is not usable`] }
  if (w > MAX_GROUP_SIDE || h > MAX_GROUP_SIDE) return { ok: false, reason: "group_too_large", diagnostics: [`group ${Math.round(w)}x${Math.round(h)} exceeds ${MAX_GROUP_SIDE}`] }
  const vp = input.viewport && input.viewport.w > 0 && input.viewport.h > 0 ? input.viewport : null
  const anchor = input.anchor ?? null
  const content = index.bounds
  const box = (x: number, y: number): Rect => ({ x, y, w, h })
  const cands: Cand[] = []
  const add = (x: number, y: number, strategy: Strategy, tag: string) => {
    const sx = snap(x), sy = snap(y)
    if (Math.abs(sx) > MAX_SCENE_COORD || Math.abs(sy) > MAX_SCENE_COORD) return
    cands.push({ x: sx, y: sy, strategy, tag })
  }

  // Empty board: the centre of what the student is looking at.
  if (!content) {
    const c = vp ? center(vp) : [0, 0] as const
    add(c[0] - w / 2, c[1] - h / 2, "empty-board", "center")
    if (vp) add(vp.x + 48, vp.y + 48, "empty-board", "top-left")
  }

  // 1. Next to the related content.
  if (anchor) {
    const a = anchor.rect
    const rtl = !!anchor.rtl
    for (const gap of [margin + 8, margin + 40, margin + 88]) {
      const sides: [string, number, number][] = [
        ["below", a.x, bottom(a) + gap], ["below-c", a.x + a.w / 2 - w / 2, bottom(a) + gap], ["below-e", right(a) - w, bottom(a) + gap],
        ["right", right(a) + gap, a.y], ["right-c", right(a) + gap, a.y + a.h / 2 - h / 2], ["right-b", right(a) + gap, bottom(a) - h],
        ["left", a.x - gap - w, a.y], ["left-c", a.x - gap - w, a.y + a.h / 2 - h / 2], ["left-b", a.x - gap - w, bottom(a) - h],
        ["above", a.x, a.y - gap - h], ["above-c", a.x + a.w / 2 - w / 2, a.y - gap - h], ["above-e", right(a) - w, a.y - gap - h],
      ]
      for (const [tag, x, y] of sides) add(x, y, "anchor", `${tag}@${gap}${rtl ? "r" : ""}`)
    }
  }

  // 2. Free space inside the visible viewport.
  if (vp) {
    const step = Math.max(40, Math.min(160, Math.floor(Math.min(vp.w, vp.h) / 6)))
    let n = 0
    for (let y = vp.y + 16; y + h <= bottom(vp) - 8 + 0.1 && n < 700; y += step) for (let x = vp.x + 16; x + w <= right(vp) - 8 + 0.1 && n < 700; x += step) { add(x, y, "viewport", "grid"); n++ }
    if (w > vp.w || h > vp.h) add(vp.x + 24, vp.y + 24, "viewport", "oversize-origin")
  }

  // 3. Nearest free space, searched outward in rings around the anchor (or the viewport centre / content centre).
  const origin = anchor ? center(anchor.rect) : vp ? center(vp) : content ? center(content) : ([0, 0] as const)
  const ringStep = Math.max(56, Math.round(Math.min(w, h) / 3))
  for (let k = 1; k <= 28; k++) for (let s = 0; s < 16; s++) {
    const ang = (2 * Math.PI * s) / 16
    add(origin[0] + Math.cos(ang) * k * ringStep - w / 2, origin[1] + Math.sin(ang) * k * ringStep - h / 2, "nearby", `ring${k}`)
  }

  // 4. Extend the workspace: beyond everything that exists, which is collision-free by construction.
  if (content) {
    const g = margin * 3
    add(right(content) + g, content.y, "extend", "east")
    add(right(content) + g, anchor ? anchor.rect.y : content.y, "extend", "east-anchor")
    add(content.x, bottom(content) + g, "extend", "south")
    add(anchor ? anchor.rect.x : content.x, bottom(content) + g, "extend", "south-anchor")
    add(content.x - g - w, content.y, "extend", "west")
    add(content.x, content.y - g - h, "extend", "north")
  }

  // Group unions are a SOFT cost: dropping a diagram into the gap inside someone's group is legal but unattractive.
  const groupBoxes = new Map<string, Rect[]>()
  for (const o of index.obstacles) if (o.groupId) (groupBoxes.get(o.groupId) ?? groupBoxes.set(o.groupId, []).get(o.groupId)!).push(o.rect)
  const groupUnions = [...groupBoxes.values()].map((r) => union(r)!).filter((r) => r.w > 0)

  const centroid = content ? center(content) : null
  const vpDiag = vp ? Math.hypot(vp.w, vp.h) : 1
  const rtl = !!anchor?.rtl
  const score = (c: Cand): number => {
    const r = box(c.x, c.y)
    let cost = 0
    if (anchor) {
      const a = anchor.rect
      cost += Math.min(2, rectGap(r, a) / 500) * (1 + 3 * anchor.confidence)
      const dx = center(r)[0] - center(a)[0], dy = center(r)[1] - center(a)[1]
      const below = dy > 0 && Math.abs(dy) >= Math.abs(dx), rightOf = dx > 0 && Math.abs(dx) > Math.abs(dy)
      cost += below ? 0 : rightOf ? (rtl ? 0.45 : 0.1) : dx < 0 && Math.abs(dx) > Math.abs(dy) ? (rtl ? 0.1 : 0.45) : 0.4
      if (Math.abs(r.x - a.x) < 4 || Math.abs(center(r)[0] - center(a)[0]) < 4) cost -= 0.25
    } else if (vp) cost += Math.hypot(center(r)[0] - center(vp)[0], center(r)[1] - center(vp)[1]) / vpDiag
    else if (centroid) cost += Math.min(2, Math.hypot(center(r)[0] - centroid[0], center(r)[1] - centroid[1]) / 2000)
    if (vp) cost += 2.5 * (1 - Math.min(1, overlapArea(r, vp) / area(r)))
    if (index.collides(r, margin * 2)) cost += 0.6
    if (index.collides(r, margin * 4)) cost += 0.3
    if (groupUnions.some((g) => overlapArea(r, g) > 0)) cost += 1.5
    if (c.strategy === "extend") cost += 0.8
    return cost
  }

  const seen = new Set<string>()
  const safe: { c: Cand; s: number }[] = []
  let rejected = 0, evaluated = 0
  for (const c of cands) {
    const key = c.x + "," + c.y
    if (seen.has(key)) continue
    seen.add(key)
    evaluated++
    if (index.collides(box(c.x, c.y), margin)) { rejected++; continue }       // protected content: reject, never penalise
    safe.push({ c, s: score(c) })
  }
  safe.sort((p, q) => p.s - q.s || p.c.y - q.c.y || p.c.x - q.c.x)
  diagnostics.push(`${evaluated} candidates, ${rejected} rejected for collisions, ${safe.length} safe`)

  const maxValidations = input.maxValidations ?? 12
  let tried = 0
  for (const { c, s } of safe) {
    const r = box(c.x, c.y)
    if (input.validate) {
      if (tried >= maxValidations) { diagnostics.push(`gave up after ${maxValidations} failed validations`); break }
      const why = input.validate(r)
      tried++
      if (why) { diagnostics.push(`candidate ${c.strategy}/${c.tag} at (${c.x},${c.y}) rejected: ${why}`); continue }
    }
    const visible = !!vp && containsRect(vp, r)
    return { ok: true, x: c.x, y: c.y, rect: r, strategy: c.strategy, score: s, visible, candidatesEvaluated: evaluated, rejected, diagnostics }
  }
  return { ok: false, reason: safe.length === 0 ? "no_safe_region" : "validation_failed", diagnostics }
}

/** Visible region of the canvas in scene coordinates, from Excalidraw's appState (scroll, zoom, canvas size). */
export function viewportRect(app: { scrollX: number; scrollY: number; zoom: { value: number }; width: number; height: number }): Rect {
  const z = app.zoom.value || 1
  return { x: -app.scrollX, y: -app.scrollY, w: app.width / z, h: app.height / z }
}

export const clearanceOf = (rect: Rect, index: ObstacleIndex): number => {
  for (const m of [4, 8, 16, 32, 64, 128]) if (index.collides(rect, m)) return m
  return 256
}
export const withMargin = inflate
export type { SceneEl }
