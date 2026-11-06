/**
 * The Coach writes to the board SERVER-side in the legacy 2000x1200 format. On the infinite canvas those coordinates can land on top of
 * whatever the student has since drawn, so Coach elements are converted to native elements and relocated as ONE group through the same
 * placement engine and the same safety validation as AI drawings. Nothing existing is moved, resized or covered.
 */
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types"
import type { Board, BoardElement } from "../whiteboard"
import { elementBounds, union } from "./geometry"
import { assignIndices, validateInsertion } from "./insertAi"
import { legacyBoardToNative } from "./legacy"
import { ObstacleIndex } from "./obstacles"
import { findPlacement } from "./placement"
import type { Rect, SceneEl } from "./types"

export type CoachPlan =
  | { ok: true; all: ExcalidrawElement[]; added: ExcalidrawElement[]; groupId: string; rect: Rect; files: Record<string, { mimeType: string; id: string; dataURL: string; created: number }>; diagnostics: string[] }
  | { ok: false; reason: string; diagnostics: string[] }

export function planCoachInsertion(args: { existing: readonly ExcalidrawElement[]; coach: readonly BoardElement[]; viewport?: Rect | null; opId: string; now?: number }): CoachPlan {
  const now = args.now ?? Date.now()
  if (args.coach.length === 0) return { ok: true, all: [...args.existing], added: [], groupId: "", rect: { x: 0, y: 0, w: 0, h: 0 }, files: {}, diagnostics: ["nothing to add"] }
  const sub: Board = { steps: [], strokes: [], elements: [...args.coach], nextSeq: 0 }
  const m = legacyBoardToNative(sub, now)
  if (m.elements.length === 0) return { ok: false, reason: "empty", diagnostics: ["the Coach's elements could not be represented"] }
  const b = union(m.elements.map((e) => elementBounds(e as SceneEl)))!
  const live = args.existing.filter((e) => !e.isDeleted) as SceneEl[]
  const index = new ObstacleIndex(live)
  const p = findPlacement(index, { size: { w: b.w, h: b.h }, viewport: args.viewport, anchor: null })
  if (!p.ok) return { ok: false, reason: p.reason, diagnostics: p.diagnostics }
  const dx = p.x - b.x, dy = p.y - b.y
  const groupId = `coach-group-${args.opId}`
  const moved = m.elements.map((e) => ({ ...e, x: e.x + dx, y: e.y + dy, groupIds: [groupId] }) as ExcalidrawElement)
  const problems = validateInsertion(index, moved, 0)
  if (problems.length) return { ok: false, reason: "validation_failed", diagnostics: [...p.diagnostics, ...problems] }
  const added = assignIndices(args.existing, moved)
  return { ok: true, all: [...args.existing, ...added], added, groupId, rect: { x: p.x, y: p.y, w: b.w, h: b.h }, files: m.files, diagnostics: p.diagnostics }
}
