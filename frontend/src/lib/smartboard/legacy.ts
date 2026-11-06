/**
 * Deterministic, non-destructive conversion of a legacy SocratiQ board (2000x1200 stage: steps, strokes, elements) into native elements.
 * The legacy data is never modified or deleted; this only produces the scene that is saved next to it. Ids are stable (`legacy-<id>`), so
 * running it twice yields the same ids and the caller can skip anything already present.
 */
import { convertToExcalidrawElements, restoreElements } from "@excalidraw/excalidraw"
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types"
import type { Board, BoardElement, Stroke } from "../whiteboard"
import { withMeta } from "./meta"
import { deterministic } from "./toNative"
import type { Pt } from "./types"

export interface MigrationReport { converted: number; strokes: number; erasedStrokeParts: number; unsupported: { simulation: number; pathData: number; missingTarget: number }; warnings: string[] }
export interface MigrationResult { elements: ExcalidrawElement[]; files: Record<string, { mimeType: string; id: string; dataURL: string; created: number }>; report: MigrationReport }

const NAMED: Record<string, string> = { yellow: "#eab308", green: "#16a34a", red: "#dc2626", blue: "#2563eb", black: "#1e1e1e", white: "#ffffff", slate: "#475569", purple: "#7c3aed", pink: "#db2777" }
const colorOf = (c: string | undefined, fallback = "#1e1e1e") => (!c ? fallback : NAMED[c] ?? (/^#|^rgb|^hsl/i.test(c) ? c : fallback))
const hash = (s: string) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) } return h >>> 0 }
export const legacyElementId = (id: string) => `legacy-${id}`

const pairs = (pts: BoardElement["points"]): Pt[] => (pts ?? []).map((p) => (Array.isArray(p) ? [p[0], p[1]] : [(p as { x: number }).x, (p as { y: number }).y]) as Pt).filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]))

/** Apply eraser strokes geometrically: ink points under an eraser stroke are removed, splitting strokes into the surviving runs. */
export function applyErasers(strokes: readonly Stroke[]): { ink: { stroke: Stroke; pts: [number, number][] }[]; erasedParts: number } {
  type P = [number, number]
  const dist = (p: P, a: P, b: P) => {
    const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy
    const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2))
    return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy))
  }
  const segDist = (a: P, b: P, e: readonly P[]) => {
    // Distance between two segments is 0 if they cross, else the min endpoint-to-segment distance.
    let best = Infinity
    for (let i = 0; i < e.length - 1; i++) {
      const c = e[i], d = e[i + 1]
      const o = (p: P, q: P, r: P) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])
      if (o(a, b, c) * o(a, b, d) < 0 && o(c, d, a) * o(c, d, b) < 0) return 0
      best = Math.min(best, dist(a, c, d), dist(b, c, d), dist(c, a, b), dist(d, a, b))
    }
    if (e.length === 1) best = dist(e[0], a, b)
    return best
  }
  /** Add points along long segments so a stroke drawn fast (few samples) can still be cut where the eraser crossed it. */
  const densify = (pts: P[], step: number): P[] => {
    const out: P[] = []
    pts.forEach((p, i) => {
      out.push(p)
      if (i === pts.length - 1) return
      const q = pts[i + 1], n = Math.floor(Math.hypot(q[0] - p[0], q[1] - p[1]) / step)
      for (let k = 1; k <= n; k++) out.push([p[0] + ((q[0] - p[0]) * k) / (n + 1), p[1] + ((q[1] - p[1]) * k) / (n + 1)])
    })
    return out
  }
  let ink: { stroke: Stroke; pts: P[] }[] = []
  let erasedParts = 0
  for (const s of strokes) {
    if (s.t !== "e") { ink.push({ stroke: s, pts: s.pts.map((p) => [p[0], p[1]] as P) }); continue }
    const r = Math.max(6, s.w / 2)
    const ep = s.pts.map((p) => [p[0], p[1]] as P)
    const crosses = (pts: P[]) => pts.length === 1 ? ep.some((_, i) => i < ep.length - 1 ? dist(pts[0], ep[i], ep[i + 1]) <= r : Math.hypot(pts[0][0] - ep[i][0], pts[0][1] - ep[i][1]) <= r)
      : pts.some((p, i) => i < pts.length - 1 && segDist(p, pts[i + 1], ep) <= r)
    const hit = (p: P) => ep.length === 1 ? Math.hypot(p[0] - ep[0][0], p[1] - ep[0][1]) <= r : ep.some((_, i) => i < ep.length - 1 && dist(p, ep[i], ep[i + 1]) <= r)
    const next: typeof ink = []
    for (const k of ink) {
      if (!crosses(k.pts)) { next.push(k); continue }
      let run: P[] = []
      for (const p of densify(k.pts, Math.max(3, r / 2))) {
        if (hit(p)) { if (run.length) { next.push({ stroke: k.stroke, pts: run }); run = [] } } else run.push(p)
      }
      if (run.length) next.push({ stroke: k.stroke, pts: run })
      erasedParts++
    }
    ink = next
  }
  return { ink: ink.filter((k) => k.pts.length >= 1), erasedParts }
}

export function legacyBoardToNative(board: Board, now = Date.now()): MigrationResult {
  const report: MigrationReport = { converted: 0, strokes: 0, erasedStrokeParts: 0, unsupported: { simulation: 0, pathData: 0, missingTarget: 0 }, warnings: [] }
  const els = [...board.elements].sort((a, b) => a.seq - b.seq)
  const ids = new Set(els.map((e) => e.id))
  const files: MigrationResult["files"] = {}
  const meta = (e: BoardElement, role: string) => withMeta(e.kind === "equation" && e.latex ? { latex: e.latex } : undefined, { author: e.author === "coach" ? "coach" : "student", legacyId: e.id, role })
  const sk: Record<string, unknown>[] = []
  const hand: Record<string, unknown>[] = []

  const handBase = (id: string, x: number, y: number, pts: Pt[], extra: Record<string, unknown>) => {
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1])
    return { id, x, y, width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys), angle: 0, fillStyle: "solid", strokeStyle: "solid", roughness: 1, opacity: 100, groupIds: [], frameId: null, index: null, roundness: null,
      seed: hash(id), version: 1, versionNonce: hash(id + "n"), isDeleted: false, boundElements: null, updated: now, link: null, locked: false, points: pts, ...extra }
  }

  for (const e of els) {
    const id = legacyElementId(e.id)
    const stroke = colorOf(e.color)
    const angle = ((e.rotation ?? 0) * Math.PI) / 180
    if (e.kind === "text" || e.kind === "equation") {
      sk.push({ type: "text", id, x: e.x, y: e.y, text: (e.kind === "equation" ? e.latex : e.text) ?? "", fontSize: e.fontSize ?? (e.style === "title" ? 36 : 24), strokeColor: stroke, angle, customData: meta(e, e.kind) })
    } else if (e.kind === "shape" || e.kind === "circle") {
      const around = e.around ? els.find((t) => t.id === e.around) : undefined
      const box = around ? { x: Math.max(0, around.x - 18), y: Math.max(0, around.y - 18), w: around.w + 36, h: around.h + 36 } : { x: e.x, y: e.y, w: e.w, h: e.h }
      if (e.around && !around) report.unsupported.missingTarget++
      const kind = e.kind === "circle" || e.shape === "ellipse" || e.shape === "circle" ? "ellipse" : "rectangle"
      sk.push({ type: kind, id, x: box.x, y: box.y, width: Math.max(4, box.w), height: Math.max(4, box.h), strokeColor: stroke, backgroundColor: e.filled ? stroke : "transparent", fillStyle: "solid", strokeWidth: e.strokeWidth ?? 2, angle, customData: meta(e, "shape") })
    } else if (e.kind === "triangle" || e.shape === "triangle") {
      const pts: Pt[] = [[e.w / 2, 0], [e.w, e.h], [0, e.h], [e.w / 2, 0]]
      hand.push(handBase(id, e.x, e.y, pts, { type: "line", polygon: true, strokeColor: stroke, backgroundColor: e.filled ? stroke : "transparent", strokeWidth: e.strokeWidth ?? 2, lastCommittedPoint: null, startBinding: null, endBinding: null, startArrowhead: null, endArrowhead: null, angle, customData: meta(e, "shape") }))
    } else if (e.kind === "arrow") {
      const from = e.fromId && ids.has(e.fromId) ? legacyElementId(e.fromId) : undefined, to = e.toId && ids.has(e.toId) ? legacyElementId(e.toId) : undefined
      if (e.fromId && e.toId && (!from || !to)) report.unsupported.missingTarget++
      // Geometry must come from the real boxes: with a zeroed arrow the converter MOVES a bound text element to meet the arrow's origin.
      const a = from ? els.find((t) => legacyElementId(t.id) === from) : undefined, b = to ? els.find((t) => legacyElementId(t.id) === to) : undefined
      const geo = a && b ? { x: a.x + a.w, y: a.y + a.h / 2, width: b.x - (a.x + a.w), height: b.y + b.h / 2 - (a.y + a.h / 2) } : { x: e.x, y: e.y, width: e.w, height: e.h }
      sk.push({ type: "arrow", id, ...geo, strokeColor: stroke, strokeWidth: e.strokeWidth ?? 3, endArrowhead: "arrow", ...(from && to ? { start: { id: from }, end: { id: to } } : {}), customData: meta(e, "arrow") })
    } else if (e.kind === "line") {
      sk.push({ type: "line", id, x: e.x, y: e.y, width: (e.x2 ?? e.x + e.w) - e.x, height: (e.y2 ?? e.y + e.h) - e.y, strokeColor: stroke, strokeWidth: e.strokeWidth ?? 3, customData: meta(e, "line") })
    } else if (e.kind === "path") {
      const pts = pairs(e.points)
      if (pts.length >= 2) hand.push(handBase(id, e.x + pts[0][0], e.y + pts[0][1], pts.map((p) => [p[0] - pts[0][0], p[1] - pts[0][1]] as Pt), { type: "line", strokeColor: stroke, backgroundColor: "transparent", strokeWidth: e.strokeWidth ?? 3, lastCommittedPoint: null, startBinding: null, endBinding: null, startArrowhead: null, endArrowhead: null, customData: meta(e, "path") }))
      else { report.unsupported.pathData++; report.warnings.push(`path ${e.id} had only SVG path data and was skipped`) }
    } else if (e.kind === "image" && e.src) {
      const fileId = "f" + hash(e.src).toString(16)
      const mime = /^data:([^;,]+)/.exec(e.src)?.[1] ?? "image/png"
      files[fileId] = { mimeType: mime, id: fileId, dataURL: e.src, created: now }
      hand.push({ ...handBase(id, e.x, e.y, [[0, 0], [e.w, e.h]], { type: "image", fileId, status: "saved", scale: [1, 1], crop: null, strokeColor: "transparent", backgroundColor: "transparent", angle, customData: meta(e, "image") }), width: e.w, height: e.h, points: undefined })
    } else if (e.kind === "simulation") {
      report.unsupported.simulation++
      report.warnings.push(`interactive simulation "${e.title ?? e.id}" cannot be shown on the new board; a placeholder was added and the original data is kept on the server`)
      sk.push({ type: "rectangle", id, x: e.x, y: e.y, width: Math.max(220, e.w), height: Math.max(90, Math.min(e.h, 160)), strokeColor: "#64748b", backgroundColor: "#f1f5f9", strokeStyle: "dashed", strokeWidth: 2, label: { text: `Interactive simulation\n${e.title ?? ""}`.trim(), fontSize: 18 }, customData: meta(e, "simulation-placeholder") })
    }
    report.converted++
  }

  const { ink, erasedParts } = applyErasers(board.strokes)
  report.erasedStrokeParts = erasedParts
  ink.forEach((k, i) => {
    const hl = k.stroke.t === "h"
    const pts = k.pts.length === 1 ? [k.pts[0], [k.pts[0][0] + 0.1, k.pts[0][1]] as Pt] : k.pts
    const id = `legacy-stroke-${i}`
    const rel = pts.map((p) => [p[0] - pts[0][0], p[1] - pts[0][1]] as Pt)
    hand.push(handBase(id, pts[0][0], pts[0][1], rel, { type: "freedraw", pressures: [], simulatePressure: true, lastCommittedPoint: null, strokeColor: colorOf(k.stroke.color, hl ? "#eab308" : "#1e1e1e"), backgroundColor: "transparent", strokeWidth: hl ? Math.max(8, k.stroke.w * 2) : Math.max(1, Math.round(k.stroke.w / 2)), opacity: hl ? 35 : 100, customData: withMeta(undefined, { author: "student", role: "stroke" }) }))
    report.strokes++
  })

  const pinned = new Map(sk.filter((k) => k.type !== "arrow" && k.type !== "line").map((k) => [k.id as string, [k.x as number, k.y as number] as const]))
  // Guard: legacy content never moves. Whatever the converter did while binding, restore the original coordinates of every non-arrow element.
  const converted = (sk.length ? (convertToExcalidrawElements(sk as never, { regenerateIds: false }) as ExcalidrawElement[]) : []).map((c) => {
    const at = pinned.get(c.id)
    return at && (c.x !== at[0] || c.y !== at[1]) ? ({ ...c, x: at[0], y: at[1] } as ExcalidrawElement) : c
  })
  const restored = hand.length ? (restoreElements(hand as never, null, { refreshDimensions: false, repairBindings: false }) as ExcalidrawElement[]) : []
  const all = [...converted, ...restored]
  // Typed legacy steps become a text column below the content (they were a separate list, never positioned).
  const steps = board.steps.filter((s) => s.trim())
  if (steps.length) {
    const bottom = all.reduce((m, e) => Math.max(m, e.y + (e.height || 0)), 0)
    const st = convertToExcalidrawElements(steps.map((t, i) => ({ type: "text", id: `legacy-step-${i}`, x: 40, y: bottom + 80 + i * 56, text: t, fontSize: 24, customData: withMeta(undefined, { author: "student", role: "step" }) })) as never, { regenerateIds: false }) as ExcalidrawElement[]
    all.push(...st)
  }
  return { elements: deterministic(all.map((e) => ({ ...e, updated: now }) as ExcalidrawElement)), files, report }
}

/** Coach-written legacy elements that exist on the server but are not yet in the scene (the Coach writes server-side, in the legacy format). */
export function unmirroredCoachElements(board: Board, sceneElements: readonly { customData?: Record<string, unknown> }[]): BoardElement[] {
  const have = new Set<string>()
  for (const e of sceneElements) { const id = (e.customData?.socratiq as { legacyId?: string } | undefined)?.legacyId; if (id) have.add(id) }
  return board.elements.filter((e) => e.author === "coach" && !have.has(e.id))
}
