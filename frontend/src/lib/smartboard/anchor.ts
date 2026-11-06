/**
 * Stage 1/5: which existing content is this request about? Deterministic and explainable (no hidden model call):
 *   1. the student's selection;  2. the target the model named (validated against the real board);
 *   3. lexical relevance between the request and text on the board;  4. a deictic request ("this", "هذا") -> what they touched last.
 */
import { elementBounds, union } from "./geometry"
import { authorOf } from "./meta"
import type { Anchor } from "./placement"
import { tokenize } from "./diagramSpec"
import type { Rect, SceneEl } from "./types"

const STOP = new Set(["the", "a", "an", "of", "to", "and", "or", "in", "on", "for", "is", "are", "me", "my", "please", "draw", "diagram", "explain", "show", "make", "how", "what", "with", "about", "this", "that", "it", "can", "you", "من", "في", "على", "الى", "عن", "ما", "هو", "هي", "اشرح", "ارسم", "لي", "هذا", "هذه", "ده", "دي"])
const DEICTIC = /\b(this|that|these|here|above|below|it)\b|هذا|هذه|ده|دي|هنا|فوق|تحت/i
const NEW_INDEPENDENT = /\b(new|another|separate|fresh|independent)\b|جديد|منفصل|آخر|اخر/i
export const hasRtl = (s: string) => /[\u0590-\u08FF]/.test(s)

export type Intent = "new" | "explain" | "extend"

export interface AnchorResolution { anchor: Anchor | null; intent: Intent; reason: string }

export function textOf(el: SceneEl): string {
  return typeof el.text === "string" ? el.text : ""
}

interface Cluster { ids: string[]; rect: Rect; text: string; latest: number; student: boolean }

/** Cluster text with the shapes/strokes right next to it so "the photosynthesis question" means the whole thing the student drew around it. */
export function clusters(elements: readonly SceneEl[], reach = 90): Cluster[] {
  const live = elements.filter((e) => !e.isDeleted)
  const byId = new Map(live.map((e) => [e.id, e]))
  const items = live.filter((e) => !(e.type === "text" && e.containerId && byId.get(e.containerId)))
  const parent = items.map((_, i) => i)
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])))
  const rects = items.map((e) => elementBounds(e))
  for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
    const a = rects[i], b = rects[j]
    if (a.x - reach < b.x + b.w && a.x + a.w + reach > b.x && a.y - reach < b.y + b.h && a.y + a.h + reach > b.y) parent[find(i)] = find(j)
    else if (items[i].groupIds?.some((g) => items[j].groupIds?.includes(g))) parent[find(i)] = find(j)
  }
  const groups = new Map<number, number[]>()
  items.forEach((_, i) => (groups.get(find(i)) ?? groups.set(find(i), []).get(find(i))!).push(i))
  return [...groups.values()].map((idxs) => {
    const members = idxs.map((i) => items[i])
    const boundText = live.filter((e) => e.type === "text" && e.containerId && members.some((m) => m.id === e.containerId))
    return {
      ids: members.map((m) => m.id),
      rect: union(idxs.map((i) => rects[i]))!,
      text: [...members, ...boundText].map(textOf).filter(Boolean).join(" "),
      latest: Math.max(0, ...members.map((m) => m.updated ?? m.version ?? 0)),
      student: members.some((m) => authorOf(m) === "student"),
    }
  })
}

export function resolveAnchor(args: { request: string; elements: readonly SceneEl[]; selectedIds?: readonly string[]; modelTargetId?: string | null; modelMode?: Intent }): AnchorResolution {
  const live = args.elements.filter((e) => !e.isDeleted)
  const byId = new Map(live.map((e) => [e.id, e]))
  const rtlOf = (els: SceneEl[]) => els.some((e) => hasRtl(textOf(e)))
  const intentFor = (hasTarget: boolean): Intent => (NEW_INDEPENDENT.test(args.request) ? "new" : args.modelMode ?? (hasTarget ? "explain" : "new"))

  const sel = (args.selectedIds ?? []).map((id) => byId.get(id)).filter((e): e is SceneEl => !!e)
  if (sel.length > 0) {
    const ownerOf = (e: SceneEl) => (e.containerId && byId.get(e.containerId) ? byId.get(e.containerId)! : e)
    const els = sel.map(ownerOf)
    return { anchor: { rect: union(els.map(elementBounds))!, ids: els.map((e) => e.id), confidence: 1, kind: "selection", rtl: rtlOf(els) }, intent: intentFor(true), reason: `selection of ${els.length} element(s)` }
  }

  const cl = clusters(live)
  const modelTarget = args.modelTargetId ? byId.get(args.modelTargetId) : undefined
  if (modelTarget) {
    const owner = modelTarget.containerId && byId.get(modelTarget.containerId) ? byId.get(modelTarget.containerId)! : modelTarget
    const c = cl.find((k) => k.ids.includes(owner.id))
    if (c) return { anchor: { rect: c.rect, ids: c.ids, confidence: 0.8, kind: "model", rtl: hasRtl(c.text) }, intent: intentFor(true), reason: `model named element ${modelTarget.id}` }
  }

  const want = tokenize(args.request).filter((t) => !STOP.has(t))
  if (want.length > 0 && cl.length > 0) {
    const wantSet = new Set(want)
    let best: { c: Cluster; s: number } | null = null
    for (const c of cl) {
      const toks = new Set(tokenize(c.text))
      if (toks.size === 0) continue
      let hit = 0
      wantSet.forEach((t) => { if (toks.has(t)) hit++ })
      const s = hit / Math.sqrt(wantSet.size * toks.size)
      if (hit > 0 && (!best || s > best.s || (s === best.s && c.latest > best.c.latest))) best = { c, s }
    }
    if (best && best.s >= 0.12) return { anchor: { rect: best.c.rect, ids: best.c.ids, confidence: Math.min(0.9, 0.3 + best.s), kind: "semantic", rtl: hasRtl(best.c.text) }, intent: intentFor(true), reason: `request vocabulary matches existing content (score ${best.s.toFixed(2)})` }
  }

  if (DEICTIC.test(args.request) && cl.length > 0) {
    const student = cl.filter((c) => c.student)
    const pool = student.length ? student : cl
    const c = pool.reduce((a, b) => (b.latest > a.latest ? b : a))
    return { anchor: { rect: c.rect, ids: c.ids, confidence: 0.35, kind: "recent", rtl: hasRtl(c.text) }, intent: intentFor(true), reason: "deictic request: used the most recently edited content" }
  }
  return { anchor: null, intent: "new", reason: "no related content: treated as an independent diagram" }
}
