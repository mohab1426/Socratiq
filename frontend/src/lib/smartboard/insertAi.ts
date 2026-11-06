/**
 * The AI drawing pipeline, stages 1-7, as one pure planning step plus one atomic commit.
 *
 *   spec (validated) -> semantic checks -> deterministic layout -> board analysis + anchor -> placement search
 *   -> native elements -> validation on the REAL elements -> atomic, undoable, idempotent insertion
 *
 * Nothing here mutates the scene. `planAiInsertion` returns the full next element list in which every pre-existing element is the SAME object
 * reference as before (so "student content untouched" is checkable by identity), followed by the new group.
 */
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types"
import { generateNKeysBetween } from "fractional-indexing"
import { resolveAnchor, type AnchorResolution } from "./anchor"
import { checkSemantics, type DiagramSpec } from "./diagramSpec"
import { itemBounds, layoutDiagram, edgeRoute, validateLayout, type Layout, type LBox, type LEdge, type LayoutIssue } from "./diagramLayout"
import { absolutePoints, elementBounds, isLinear, rectsIntersect, union } from "./geometry"
import { opIdOf } from "./meta"
import { ObstacleIndex } from "./obstacles"
import { DEFAULT_MARGIN, findPlacement, type PlacementResult } from "./placement"
import { layoutToNative } from "./toNative"
import { FONT } from "./style"
import { MAX_SCENE_COORD, type Pt, type Rect, type SceneEl } from "./types"

export interface PlanArgs {
  spec: DiagramSpec
  request: string
  elements: readonly ExcalidrawElement[]
  viewport?: Rect | null
  selectedIds?: readonly string[]
  /** Unique per AI operation; also the idempotency key. Reusing it (a retry) inserts nothing. */
  opId: string
  now?: number
  margin?: number
}

export type PlanResult =
  | { ok: true; duplicate: false; all: ExcalidrawElement[]; added: ExcalidrawElement[]; groupId: string; opId: string; rect: Rect; visible: boolean; placement: Extract<PlacementResult, { ok: true }>; anchor: AnchorResolution; layoutStrategy: string; warnings: string[]; diagnostics: string[] }
  | { ok: true; duplicate: true; all: ExcalidrawElement[]; added: []; opId: string; diagnostics: string[] }
  | { ok: false; reason: string; message: string; diagnostics: string[] }

const fail = (reason: string, message: string, diagnostics: string[]): PlanResult => ({ ok: false, reason, message, diagnostics })

/** Internal consistency of the produced layout, plus a conservative geometry check against the board, all in LOCAL layout space translated by (dx, dy). */
function layoutCollision(index: ObstacleIndex, layout: Layout, rect: Rect, margin: number): string | null {
  const boxes = new Map<string, LBox>(layout.items.filter((i): i is LBox => i.t === "box").map((b) => [b.id, b]))
  for (const it of layout.items) {
    if (it.t === "edge") {
      const route = edgeRoute(it as LEdge, boxes).map(([x, y]) => [x + rect.x, y + rect.y] as Pt)
      const hits = index.pathHits(route, 4)
      if (hits.length) return `arrow ${it.from}->${it.to} would cross ${hits[0].type} ${hits[0].id}`
      continue
    }
    const b = itemBounds(it)
    if (!b) continue
    const r = { x: b.x + rect.x, y: b.y + rect.y, w: b.w, h: b.h }
    const hits = index.hits(r, margin > 12 ? 8 : margin)
    if (hits.length) return `${it.t} ${it.id} would cover ${hits[0].type} ${hits[0].id}`
  }
  return null
}

/** Authoritative validation of the actual native elements about to be inserted. Returns human-readable problems. */
export function validateInsertion(index: ObstacleIndex, added: readonly ExcalidrawElement[], margin = 0): string[] {
  const issues: string[] = []
  const ids = new Set(added.map((e) => e.id))
  const byId = new Map(added.map((e) => [e.id, e as SceneEl]))
  for (const e of added) {
    const s = e as SceneEl
    if (e.type === "text") {
      if (s.width <= 0 || s.height <= 0) issues.push(`text ${e.id} has no size`)
      const fs = (e as unknown as { fontSize: number }).fontSize
      if (fs < FONT.min) issues.push(`text ${e.id} is smaller than the readable minimum (${fs}px)`)
    }
    if (e.type === "text" && s.containerId && byId.get(s.containerId) && !isLinear(byId.get(s.containerId)!)) {
      const c = elementBounds(byId.get(s.containerId)!)
      const t = elementBounds(s)
      if (t.w > c.w + 6 || t.h > c.h + 6) issues.push(`label ${e.id} does not fit inside its shape`)
      continue
    }
    const b = elementBounds(s)
    if (Math.abs(b.x) > MAX_SCENE_COORD || Math.abs(b.y) > MAX_SCENE_COORD) issues.push(`element ${e.id} is outside the usable canvas`)
    if (!Number.isFinite(b.x + b.y + b.w + b.h)) issues.push(`element ${e.id} has non-finite geometry`)
    if (isLinear(s)) {
      const hits = index.pathHits(absolutePoints(s), 2)
      if (hits.length) issues.push(`arrow ${e.id} crosses existing ${hits[0].type} ${hits[0].id}`)
      const ar = e as unknown as { startBinding?: { elementId: string } | null; endBinding?: { elementId: string } | null }
      for (const bd of [ar.startBinding, ar.endBinding]) if (bd && !ids.has(bd.elementId)) issues.push(`arrow ${e.id} is bound to existing element ${bd.elementId} (that would modify it)`)
    } else {
      const hits = index.hits(b, margin)
      if (hits.length) issues.push(`${e.type} ${e.id} covers existing ${hits[0].type} ${hits[0].id} (${hits[0].author})`)
    }
  }
  // Inside the group: containers must not overlap each other.
  const containers = added.filter((e) => ["rectangle", "ellipse", "diamond"].includes(e.type) && ((e as SceneEl).customData as { socratiq?: { role?: string } } | undefined)?.socratiq?.role !== "figure")
  for (let i = 0; i < containers.length; i++) for (let j = i + 1; j < containers.length; j++)
    if (rectsIntersect(elementBounds(containers[i] as SceneEl), elementBounds(containers[j] as SceneEl), 0)) issues.push(`shapes ${containers[i].id} and ${containers[j].id} overlap inside the group`)
  return issues
}

/** Fractional indices after the current last element, so new elements land on top without touching existing indices. */
export function assignIndices(existing: readonly ExcalidrawElement[], added: readonly ExcalidrawElement[]): ExcalidrawElement[] {
  let last: string | null = null
  for (let i = existing.length - 1; i >= 0; i--) if (existing[i].index) { last = existing[i].index as string; break }
  const keys = generateNKeysBetween(last as never, null, added.length)
  return added.map((e, i) => ({ ...e, index: keys[i] as never }))
}

function pickLayout(spec: DiagramSpec, diagnostics: string[]): { layout: Layout; spec: DiagramSpec } | { error: string } {
  const attempts: { spec: DiagramSpec; o?: "TB" | "LR"; note: string }[] = [{ spec, note: "preferred" }]
  if (["flowchart", "hierarchy", "steps"].includes(spec.type)) attempts.push({ spec, o: (spec.orientation ?? "TB") === "TB" ? "LR" : "TB", note: "other orientation" })
  if (spec.type === "concept_map" || spec.type === "hierarchy") attempts.push({ spec: { ...spec, type: "flowchart" }, o: "LR", note: "layered fallback" })
  let lastIssues: LayoutIssue[] = []
  for (const a of attempts) {
    const layout = layoutDiagram(a.spec, a.o)
    const issues = validateLayout(layout).filter((i) => i.severity === "error")
    if (issues.length === 0) { if (a.note !== "preferred") diagnostics.push(`layout fell back to ${a.note}`); return { layout, spec: a.spec } }
    diagnostics.push(`layout "${layout.strategy}" rejected: ${issues.slice(0, 3).map((i) => i.message).join("; ")}`)
    lastIssues = issues
  }
  return { error: lastIssues.map((i) => i.message).slice(0, 3).join("; ") }
}

export function planAiInsertion(args: PlanArgs): PlanResult {
  const diagnostics: string[] = []
  const existing = args.elements
  // Retries must never duplicate an AI group.
  if (existing.some((e) => opIdOf(e) === args.opId)) return { ok: true, duplicate: true, all: [...existing], added: [], opId: args.opId, diagnostics: ["operation already applied"] }

  const sem = checkSemantics(args.spec, args.request)
  if (sem.errors.length) return fail("semantic_invalid", `The diagram was not coherent: ${sem.errors.join("; ")}`, [...sem.errors])
  diagnostics.push(...sem.warnings.map((w) => `warning: ${w}`))

  const picked = pickLayout(args.spec, diagnostics)
  if ("error" in picked) return fail("layout_invalid", `Could not produce a clean layout: ${picked.error}`, diagnostics)
  const { layout } = picked

  const live = existing.filter((e) => !e.isDeleted)
  const anchor = resolveAnchor({ request: args.request, elements: live as SceneEl[], selectedIds: args.selectedIds, modelTargetId: args.spec.relation?.targetId, modelMode: args.spec.relation?.mode })
  diagnostics.push(`anchor: ${anchor.reason}`)
  const index = new ObstacleIndex(live as SceneEl[])
  const margin = args.margin ?? DEFAULT_MARGIN
  const now = args.now ?? Date.now()
  const groupId = `ai-group-${args.opId}`

  let size = { w: layout.width, h: layout.height }
  for (let pass = 0; pass < 3; pass++) {
    const placement = findPlacement(index, { size, viewport: args.viewport, anchor: anchor.intent === "new" ? null : anchor.anchor, margin, validate: (r) => layoutCollision(index, layout, r, margin) })
    diagnostics.push(...placement.diagnostics.map((d) => `placement: ${d}`))
    if (!placement.ok) return fail(placement.reason, "There was no safe place on the board for this drawing without covering existing content.", diagnostics)

    const native = layoutToNative(layout, { offset: { x: placement.x, y: placement.y }, opId: args.opId, groupId, now })
    const problems = validateInsertion(index, native.elements, 0)
    if (problems.length === 0) {
      const added = assignIndices(existing, native.elements)
      const rect = union(added.map((e) => elementBounds(e as SceneEl)))!
      const vis = !!args.viewport && rect.x >= args.viewport.x && rect.y >= args.viewport.y && rect.x + rect.w <= args.viewport.x + args.viewport.w && rect.y + rect.h <= args.viewport.y + args.viewport.h
      return { ok: true, duplicate: false, all: [...existing, ...added], added, groupId, opId: args.opId, rect, visible: vis, placement: { ...placement, visible: vis }, anchor, layoutStrategy: layout.strategy, warnings: sem.warnings, diagnostics }
    }
    diagnostics.push(`validation pass ${pass + 1} failed: ${problems.slice(0, 3).join("; ")}`)
    // Real text metrics were larger than the estimate: re-plan with the real extent plus slack, a bounded number of times.
    const real = union(native.elements.map((e) => elementBounds(e as SceneEl)))!
    size = { w: Math.max(size.w, real.w) + 24 * (pass + 1), h: Math.max(size.h, real.h) + 24 * (pass + 1) }
  }
  return fail("validation_failed", "The drawing could not be placed safely after several attempts, so nothing was added.", diagnostics)
}
