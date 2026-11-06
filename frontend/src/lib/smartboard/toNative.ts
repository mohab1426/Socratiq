/**
 * Stage 4: layout primitives -> native Excalidraw elements.
 * Boxes, text and bound arrows go through Excalidraw's own `convertToExcalidrawElements` (so bindings, bound labels and text metrics are
 * the engine's). Freehand strokes and polylines, which that converter does not support, are built as plain element records and
 * normalised by the public `restoreElements`. Every element is a normal board element: selectable, editable, groupable.
 */
import { convertToExcalidrawElements, restoreElements } from "@excalidraw/excalidraw"
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types"
import { edgeRoute, type Layout, type LBox, type LEdge } from "./diagramLayout"
import { withMeta } from "./meta"
import { FONT } from "./style"
import type { Pt } from "./types"

export interface NativeOptions { offset: { x: number; y: number }; opId: string; groupId: string; now: number }
export interface NativeResult { elements: ExcalidrawElement[]; ids: string[] }

const hash = (s: string) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) } return h >>> 0 }
const eid = (opId: string, item: string) => `ai-${opId}-${item}`

/** Round a coarse polyline into a smooth path (Catmull-Rom) so freehand parts read as natural strokes, not jagged segments. */
export function smoothPoints(pts: readonly Pt[], per = 4): Pt[] {
  if (pts.length < 3) return pts.map((p) => [p[0], p[1]] as Pt)
  const out: Pt[] = []
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(pts.length - 1, i + 2)]
    for (let k = 0; k < per; k++) {
      const t = k / per, t2 = t * t, t3 = t2 * t
      out.push([
        0.5 * (2 * p1[0] + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3),
        0.5 * (2 * p1[1] + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3),
      ])
    }
  }
  out.push([pts[pts.length - 1][0], pts[pts.length - 1][1]])
  return out
}

const polyMid = (pts: readonly Pt[]): Pt => {
  const seg = pts.slice(1).map((p, i) => Math.hypot(p[0] - pts[i][0], p[1] - pts[i][1]))
  let half = seg.reduce((a, b) => a + b, 0) / 2
  for (let i = 0; i < seg.length; i++) {
    if (half <= seg[i] || i === seg.length - 1) { const t = seg[i] ? half / seg[i] : 0; return [pts[i][0] + (pts[i + 1][0] - pts[i][0]) * t, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * t] }
    half -= seg[i]
  }
  return pts[0]
}

export function layoutToNative(layout: Layout, o: NativeOptions): NativeResult {
  const ox = o.offset.x, oy = o.offset.y
  const meta = (role: string) => withMeta(undefined, { author: "ai", opId: o.opId, role })
  const common = { groupIds: [o.groupId], roughness: 1, opacity: 100 }
  const boxes = new Map<string, LBox>(layout.items.filter((i): i is LBox => i.t === "box").map((b) => [b.id, b]))
  const skeletons: Record<string, unknown>[] = []
  const routes = new Map<string, { edge: LEdge; abs: Pt[] }>()

  for (const it of layout.items) {
    if (it.t === "box") {
      skeletons.push({
        type: it.shape, id: eid(o.opId, it.id), x: ox + it.x, y: oy + it.y, width: it.w, height: it.h,
        strokeColor: it.stroke, backgroundColor: it.fill, fillStyle: "solid", strokeWidth: it.strokeWidth,
        roundness: it.shape === "rectangle" ? { type: 3 } : undefined, customData: meta(it.role), ...common,
        ...(it.label ? { label: { text: it.label, fontSize: it.fontSize, strokeColor: "#1e293b", textAlign: "center", verticalAlign: "middle" } } : {}),
      })
    } else if (it.t === "text") {
      skeletons.push({ type: "text", id: eid(o.opId, it.id), x: ox + it.x, y: oy + it.y, text: it.text, fontSize: it.fontSize, strokeColor: it.color, textAlign: it.align, customData: meta(it.role), ...common })
    } else if (it.t === "edge") {
      const abs = edgeRoute(it, boxes).map(([x, y]) => [ox + x, oy + y] as Pt)
      routes.set(eid(o.opId, it.id), { edge: it, abs })
      skeletons.push({
        type: "arrow", id: eid(o.opId, it.id), x: abs[0][0], y: abs[0][1], width: abs[abs.length - 1][0] - abs[0][0], height: abs[abs.length - 1][1] - abs[0][1],
        start: { id: eid(o.opId, it.from) }, end: { id: eid(o.opId, it.to) }, strokeColor: it.stroke, strokeWidth: 2, strokeStyle: it.dashed ? "dashed" : "solid",
        endArrowhead: it.directed ? "arrow" : null, startArrowhead: null, customData: meta("edge"), ...common,
        ...(it.label ? { label: { text: it.label, fontSize: FONT.label, strokeColor: "#1e293b" } } : {}),
      })
    } else if (it.t === "shape" && it.kind === "arrow") {
      const last = it.points[it.points.length - 1]
      skeletons.push({ type: "arrow", id: eid(o.opId, it.id), x: ox + it.x, y: oy + it.y, width: last[0], height: last[1], strokeColor: it.stroke, strokeWidth: it.strokeWidth, endArrowhead: "arrow", startArrowhead: null, customData: meta(it.role), ...common })
    }
  }

  const converted = convertToExcalidrawElements(skeletons as never, { regenerateIds: false }) as ExcalidrawElement[]

  // Long and feedback edges: route through the layout's waypoints (the bindings stay, so the arrow still follows its boxes).
  const patched = converted.map((el) => {
    const r = routes.get(el.id)
    if (!r || el.type !== "arrow" || r.edge.waypoints.length === 0) return el
    const start: Pt = [el.x + el.points[0][0], el.y + el.points[0][1]]
    const end: Pt = [el.x + el.points[el.points.length - 1][0], el.y + el.points[el.points.length - 1][1]]
    const abs: Pt[] = [start, ...r.abs.slice(1, -1), end]
    const rel = abs.map(([x, y]) => [x - start[0], y - start[1]] as Pt)
    const xs = rel.map((p) => p[0]), ys = rel.map((p) => p[1])
    return { ...el, points: rel, width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys), _route: abs } as unknown as ExcalidrawElement
  })

  const byId = new Map(patched.map((e) => [e.id, e]))
  const final: ExcalidrawElement[] = patched.map((el) => {
    let e: ExcalidrawElement = el
    const container = el.type === "text" && el.containerId ? byId.get(el.containerId) : undefined
    if (container) {
      // The converter does not copy group/authorship onto bound labels; do it so the group moves, selects and deletes as one.
      let x = el.x, y = el.y
      const route = (container as unknown as { _route?: Pt[] })._route
      if (route) { const m = polyMid(route); x = m[0] - el.width / 2; y = m[1] - el.height / 2 }
      e = { ...el, x, y, groupIds: [o.groupId], customData: container.customData } as ExcalidrawElement
    }
    const { _route, ...clean } = e as unknown as Record<string, unknown>
    void _route
    return clean as unknown as ExcalidrawElement
  })

  // Freehand strokes, polylines and polygons (not covered by the skeleton converter).
  const hand: Record<string, unknown>[] = []
  for (const it of layout.items) {
    if (it.t !== "shape" || it.kind === "arrow") continue
    const id = eid(o.opId, it.id)
    const pts = it.kind === "freehand" ? smoothPoints(it.points) : it.points.map((p) => [p[0], p[1]] as Pt)
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1])
    const w = Math.max(...xs) - Math.min(...xs), h = Math.max(...ys) - Math.min(...ys)
    const base = {
      id, x: ox + it.x, y: oy + it.y, width: w, height: h, angle: 0, strokeColor: it.stroke, backgroundColor: it.kind === "polygon" ? it.fill : "transparent", fillStyle: "solid",
      strokeWidth: it.strokeWidth, strokeStyle: "solid", roughness: 1, opacity: 100, groupIds: [o.groupId], frameId: null, index: null, roundness: it.kind === "freehand" ? null : { type: 2 },
      seed: hash(id), version: 1, versionNonce: hash(id + "n"), isDeleted: false, boundElements: null, updated: o.now, link: null, locked: false, customData: meta(it.role),
    }
    if (it.kind === "freehand") hand.push({ ...base, type: "freedraw", points: pts, pressures: [], simulatePressure: true, lastCommittedPoint: null })
    else hand.push({ ...base, type: "line", points: pts, lastCommittedPoint: null, startBinding: null, endBinding: null, startArrowhead: null, endArrowhead: null, ...(it.kind === "polygon" ? { polygon: true } : {}) })
  }
  const restored = hand.length ? (restoreElements(hand as never, null, { refreshDimensions: false, repairBindings: false }) as ExcalidrawElement[]) : []

  // Final stamp: every element belongs to the operation's group and carries authorship; timestamps are the operation's.
  const stamped = [...final, ...restored].map((e) => ({ ...e, groupIds: [o.groupId], customData: e.customData ?? meta("part"), updated: o.now, locked: false, isDeleted: false })) as ExcalidrawElement[]
  const all = deterministic(stamped)
  return { elements: all, ids: all.map((e) => e.id) }
}

/**
 * The converter gives bound labels random ids and every element a random roughjs seed. Make both derive from the element's own stable id, so the
 * same operation always produces the same elements (stable hand-drawn look across re-renders, reproducible retries and tests).
 */
export function deterministic(els: ExcalidrawElement[]): ExcalidrawElement[] {
  const rename = new Map<string, string>()
  const labelCount = new Map<string, number>()
  for (const e of els) {
    if (e.type === "text" && e.containerId) {
      const n = labelCount.get(e.containerId) ?? 0
      labelCount.set(e.containerId, n + 1)
      rename.set(e.id, `${e.containerId}-lbl${n || ""}`)
    }
  }
  const nid = (id: string) => rename.get(id) ?? id
  return els.map((e) => {
    const id = nid(e.id)
    const boundElements = e.boundElements ? e.boundElements.map((b) => ({ ...b, id: nid(b.id) })) : e.boundElements
    return { ...e, id, boundElements, seed: hash(id), versionNonce: hash(id + "n") } as ExcalidrawElement
  })
}
