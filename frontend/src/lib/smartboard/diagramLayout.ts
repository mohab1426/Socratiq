/**
 * Stage 3: deterministic layout. Turns a validated `DiagramSpec` into positioned, sized primitives in a local frame (origin top-left).
 * No randomness and no model-provided coordinates: the same spec always yields the same layout.
 */
import type { DiagramSpec, NodeKind, PaletteName, SpecNode } from "./diagramSpec"
import { inflate, pointsBounds, polylineIntersectsRect, rectsIntersect, union } from "./geometry"
import { CHAR_W, COLORS, FONT, INK, LINE_H } from "./style"
import type { Pt, Rect } from "./types"

export interface LBox { t: "box"; id: string; shape: "rectangle" | "ellipse" | "diamond"; x: number; y: number; w: number; h: number; label: string; fontSize: number; stroke: string; fill: string; strokeWidth: number; role: string }
export interface LText { t: "text"; id: string; x: number; y: number; w: number; h: number; text: string; fontSize: number; align: "left" | "center"; color: string; role: string }
export interface LEdge { t: "edge"; id: string; from: string; to: string; label?: string; dashed: boolean; directed: boolean; stroke: string; waypoints: Pt[] }
export interface LShape { t: "shape"; id: string; kind: "line" | "polygon" | "freehand" | "arrow"; x: number; y: number; points: Pt[]; stroke: string; fill: string; strokeWidth: number; role: string; startDot?: boolean }
export type LItem = LBox | LText | LEdge | LShape
export interface Layout { width: number; height: number; items: LItem[]; strategy: string }

export type LayoutIssue = { code: string; message: string; severity: "error" | "warning" }

// ------------------------------------------------------------------------------------------------------------------ text measurement
export function wrapText(text: string, maxChars: number): string[] {
  const out: string[] = []
  for (const para of text.split("\n")) {
    let line = ""
    for (let word of para.split(/\s+/).filter(Boolean)) {
      while (word.length > maxChars) { if (line) { out.push(line); line = "" } out.push(word.slice(0, maxChars)); word = word.slice(maxChars) }
      if (!line) line = word
      else if ((line + " " + word).length <= maxChars) line += " " + word
      else { out.push(line); line = word }
    }
    out.push(line)
  }
  return out.length ? out : [""]
}

export function measure(text: string, fontSize: number, maxChars = 22): { text: string; w: number; h: number; lines: number } {
  const lines = wrapText(text, maxChars)
  const w = Math.max(...lines.map((l) => l.length)) * fontSize * CHAR_W
  return { text: lines.join("\n"), w, h: lines.length * fontSize * LINE_H, lines: lines.length }
}

type Shape = "rectangle" | "ellipse" | "diamond"
const shapeFor = (k: NodeKind | undefined): Shape => (k === "terminal" ? "ellipse" : k === "decision" ? "diamond" : "rectangle")
const colorFor = (n: SpecNode): PaletteName => n.color ?? (n.kind === "decision" ? "amber" : n.kind === "terminal" ? "teal" : n.kind === "data" ? "violet" : n.kind === "note" ? "slate" : n.kind === "concept" ? "teal" : "sky")

function boxFor(n: SpecNode, id = n.id, prefix = ""): LBox {
  const shape = shapeFor(n.kind)
  const fs = FONT.node
  const m = measure(prefix + n.label, fs, shape === "diamond" ? 16 : 22)
  let w: number, h: number
  if (shape === "rectangle") { w = Math.max(120, m.w + 40); h = Math.max(56, m.h + 28) }
  else if (shape === "ellipse") { w = Math.max(130, m.w / 0.72 + 24); h = Math.max(66, m.h / 0.72 + 20) }
  else { w = Math.max(160, m.w / 0.55 + 30); h = Math.max(96, m.h / 0.5 + 30) }
  const c = COLORS[colorFor(n)]
  const strong = n.emphasis === "primary"
  return { t: "box", id, shape, x: 0, y: 0, w: Math.ceil(w / 10) * 10, h: Math.ceil(h / 10) * 10, label: m.text, fontSize: fs, stroke: n.emphasis === "muted" ? COLORS.slate.stroke : c.stroke, fill: n.emphasis === "muted" ? "transparent" : c.fill, strokeWidth: strong ? 3 : 2, role: n.kind ?? "process" }
}

function textItem(id: string, text: string, fontSize: number, role: string, maxChars: number, color = INK, align: "left" | "center" = "left"): LText {
  const m = measure(text, fontSize, maxChars)
  return { t: "text", id, x: 0, y: 0, w: Math.ceil(m.w), h: Math.ceil(m.h), text: m.text, fontSize, align, color, role }
}

// ------------------------------------------------------------------------------------------------------------------ layered layout
interface GNode { id: string; real: boolean; w: number; h: number; layer: number; order: number; pos: number }
const GAP_LAYER = 80, GAP_NODE = 48, GAP_DUMMY = 28

function layeredLayout(spec: DiagramSpec, orientation: "TB" | "LR", opts: { directed?: boolean } = {}): { items: LItem[]; boxes: Map<string, LBox> } {
  const specNodes = spec.nodes ?? []
  const edges = spec.edges ?? []
  const boxes = new Map<string, LBox>(specNodes.map((n) => [n.id, boxFor(n)]))
  const ids = specNodes.map((n) => n.id)

  // 1. Break cycles by reversing DFS back edges (layering only; edges are still drawn in their original direction).
  const out = new Map<string, number[]>(ids.map((i) => [i, []]))
  edges.forEach((e, i) => out.get(e.from)!.push(i))
  const state = new Map<string, 1 | 2>()
  const reversed = new Set<number>()
  const dfs = (n: string) => {
    state.set(n, 1)
    for (const ei of out.get(n)!) {
      const to = edges[ei].to
      if (state.get(to) === 1) reversed.add(ei)
      else if (!state.get(to)) dfs(to)
    }
    state.set(n, 2)
  }
  const indeg0 = ids.filter((i) => !edges.some((e) => e.to === i))
  ;[...indeg0, ...ids].forEach((i) => { if (!state.get(i)) dfs(i) })
  const dagEdges = edges.map((e, i) => (reversed.has(i) ? { from: e.to, to: e.from, orig: i } : { from: e.from, to: e.to, orig: i }))

  // 2. Longest-path layering.
  const layerOf = new Map<string, number>()
  const inc = new Map<string, string[]>(ids.map((i) => [i, []]))
  dagEdges.forEach((e) => inc.get(e.to)!.push(e.from))
  const depth = (n: string): number => {
    if (layerOf.has(n)) return layerOf.get(n)!
    layerOf.set(n, 0)
    const d = inc.get(n)!.length ? Math.max(...inc.get(n)!.map(depth)) + 1 : 0
    layerOf.set(n, d)
    return d
  }
  ids.forEach(depth)

  // 3. Virtual nodes for edges that span more than one layer.
  const nodes = new Map<string, GNode>()
  const horizontal = orientation === "LR"
  const along = (b: { w: number; h: number }) => (horizontal ? b.h : b.w)       // extent inside a layer
  const thick = (b: { w: number; h: number }) => (horizontal ? b.w : b.h)       // extent across layers
  ids.forEach((i) => nodes.set(i, { id: i, real: true, w: boxes.get(i)!.w, h: boxes.get(i)!.h, layer: layerOf.get(i)!, order: 0, pos: 0 }))
  const chains = new Map<number, string[]>()
  const segs: [string, string][] = []
  dagEdges.forEach((e) => {
    const l1 = layerOf.get(e.from)!, l2 = layerOf.get(e.to)!
    const chain = [e.from]
    for (let l = l1 + 1; l < l2; l++) {
      const did = `~${e.orig}_${l}`
      nodes.set(did, { id: did, real: false, w: 12, h: 12, layer: l, order: 0, pos: 0 })
      chain.push(did)
    }
    chain.push(e.to)
    chains.set(e.orig, chain)
    for (let i = 0; i < chain.length - 1; i++) segs.push([chain[i], chain[i + 1]])
  })

  // 4. Ordering inside layers: DFS-derived start, then barycentre sweeps.
  const layers: string[][] = []
  const seenOrder = new Set<string>()
  const orderSeed = [...nodes.keys()]
  orderSeed.forEach((id) => { const l = nodes.get(id)!.layer; (layers[l] ??= []).push(id); seenOrder.add(id) })
  for (let i = 0; i < layers.length; i++) layers[i] ??= []
  const neighbours = (id: string, dir: "up" | "down") => segs.filter((s) => (dir === "up" ? s[1] === id : s[0] === id)).map((s) => (dir === "up" ? s[0] : s[1]))
  const reindex = () => layers.forEach((L) => L.forEach((id, i) => { nodes.get(id)!.order = i }))
  reindex()
  for (let sweep = 0; sweep < 6; sweep++) {
    const down = sweep % 2 === 0
    const range = down ? layers.map((_, i) => i).slice(1) : layers.map((_, i) => i).slice(0, -1).reverse()
    for (const l of range) {
      const bary = new Map<string, number>()
      layers[l].forEach((id) => {
        const ns = neighbours(id, down ? "up" : "down")
        bary.set(id, ns.length ? ns.reduce((a, n) => a + nodes.get(n)!.order, 0) / ns.length : nodes.get(id)!.order)
      })
      layers[l] = [...layers[l]].sort((a, b) => bary.get(a)! - bary.get(b)! || nodes.get(a)!.order - nodes.get(b)!.order)
      reindex()
    }
  }

  // 5. Coordinates. Across layers: cumulative thickness. Inside a layer: packed, then pulled toward neighbours without breaking order.
  const layerThick = layers.map((L) => Math.max(0, ...L.map((id) => thick(nodes.get(id)!))))
  const layerPos: number[] = []
  let cursor = 0
  layerThick.forEach((t, i) => { layerPos[i] = cursor; cursor += t + GAP_LAYER })
  const gap = (a: string, b: string) => (nodes.get(a)!.real || nodes.get(b)!.real ? GAP_NODE : GAP_DUMMY)
  const pack = (L: string[]) => { let p = 0; L.forEach((id, i) => { const n = nodes.get(id)!; if (i > 0) p += gap(L[i - 1], id); n.pos = p + along(n) / 2; p += along(n) }) }
  layers.forEach(pack)
  const widest = Math.max(0, ...layers.map((L) => (L.length ? nodes.get(L[L.length - 1])!.pos + along(nodes.get(L[L.length - 1])!) / 2 : 0)))
  layers.forEach((L) => { if (!L.length) return; const last = nodes.get(L[L.length - 1])!; const span = last.pos + along(last) / 2; const off = (widest - span) / 2; L.forEach((id) => { nodes.get(id)!.pos += off }) })
  for (let it = 0; it < 8; it++) {
    for (const down of [true, false]) {
      const range = down ? layers.map((_, i) => i).slice(1) : layers.map((_, i) => i).slice(0, -1).reverse()
      for (const l of range) {
        const L = layers[l]
        L.forEach((id, i) => {
          const n = nodes.get(id)!
          const ns = neighbours(id, down ? "up" : "down")
          if (!ns.length) return
          const target = ns.reduce((a, m) => a + nodes.get(m)!.pos, 0) / ns.length
          const lo = i > 0 ? nodes.get(L[i - 1])!.pos + along(nodes.get(L[i - 1])!) / 2 + gap(L[i - 1], id) + along(n) / 2 : -Infinity
          const hi = i < L.length - 1 ? nodes.get(L[i + 1])!.pos - along(nodes.get(L[i + 1])!) / 2 - gap(id, L[i + 1]) - along(n) / 2 : Infinity
          n.pos = Math.min(Math.max(target, lo), hi)
        })
      }
    }
  }
  const minPos = Math.min(...[...nodes.values()].map((n) => n.pos - along(n) / 2))
  nodes.forEach((n) => { n.pos -= minPos })

  const items: LItem[] = []
  const centerOf = (id: string): Pt => {
    const n = nodes.get(id)!
    const t = layerPos[n.layer] + layerThick[n.layer] / 2
    return horizontal ? [t, n.pos] : [n.pos, t]
  }
  ids.forEach((id) => {
    const b = boxes.get(id)!
    const [cx, cy] = centerOf(id)
    b.x = Math.round(cx - b.w / 2)
    b.y = Math.round(cy - b.h / 2)
    items.push(b)
  })
  edges.forEach((e, i) => {
    const chain = chains.get(i)!
    const wp = chain.slice(1, -1).map(centerOf)
    if (reversed.has(i)) wp.reverse()
    if (wp.length === 0 && reversed.has(i)) {
      // Adjacent-layer feedback edge: bow it out to the side so it does not retrace the forward arrow.
      const a = boxes.get(e.from)!, b = boxes.get(e.to)!
      const mx = (a.x + a.w / 2 + b.x + b.w / 2) / 2, my = (a.y + a.h / 2 + b.y + b.h / 2) / 2
      const bow = Math.max(a.w, b.w) / 2 + 40
      wp.push(horizontal ? [mx, my - bow] : [mx + bow, my])
    }
    items.push({ t: "edge", id: `e${i}`, from: e.from, to: e.to, label: e.label, dashed: e.style === "dashed", directed: opts.directed !== false, stroke: INK, waypoints: wp.map(([x, y]) => [Math.round(x), Math.round(y)] as Pt) })
  })
  return { items, boxes }
}

// ------------------------------------------------------------------------------------------------------------------ other layouts
function treeLayout(spec: DiagramSpec, orientation: "TB" | "LR"): { items: LItem[]; boxes: Map<string, LBox> } {
  const nodes = spec.nodes ?? [], edges = spec.edges ?? []
  const boxes = new Map(nodes.map((n) => [n.id, boxFor(n)]))
  const kids = new Map<string, string[]>(nodes.map((n) => [n.id, []]))
  edges.forEach((e) => kids.get(e.from)!.push(e.to))
  const root = nodes.find((n) => !edges.some((e) => e.to === n.id))!.id
  const H = orientation === "LR"
  const along = (b: LBox) => (H ? b.h : b.w), thick = (b: LBox) => (H ? b.w : b.h)
  const span = new Map<string, number>()
  const measureSpan = (id: string): number => {
    const ch = kids.get(id)!
    const own = along(boxes.get(id)!)
    const s = ch.length ? Math.max(own, ch.reduce((a, c) => a + measureSpan(c), 0) + (ch.length - 1) * GAP_NODE) : own
    span.set(id, s)
    return s
  }
  measureSpan(root)
  const depthOf = new Map<string, number>()
  const levels: string[][] = []
  const walk = (id: string, d: number) => { depthOf.set(id, d); (levels[d] ??= []).push(id); kids.get(id)!.forEach((c) => walk(c, d + 1)) }
  walk(root, 0)
  const levelThick = levels.map((L) => Math.max(...L.map((i) => thick(boxes.get(i)!))))
  const levelPos: number[] = []
  let cur = 0
  levelThick.forEach((t, i) => { levelPos[i] = cur; cur += t + GAP_LAYER + 10 })
  const place = (id: string, start: number) => {
    const b = boxes.get(id)!
    const s = span.get(id)!
    const c = start + s / 2
    const t = levelPos[depthOf.get(id)!] + levelThick[depthOf.get(id)!] / 2
    const [cx, cy] = H ? [t, c] : [c, t]
    b.x = Math.round(cx - b.w / 2); b.y = Math.round(cy - b.h / 2)
    let off = start
    const ch = kids.get(id)!
    const total = ch.reduce((a, k) => a + span.get(k)!, 0) + Math.max(0, ch.length - 1) * GAP_NODE
    off = start + (s - total) / 2
    ch.forEach((k) => { place(k, off); off += span.get(k)! + GAP_NODE })
  }
  place(root, 0)
  const items: LItem[] = [...boxes.values()]
  edges.forEach((e, i) => items.push({ t: "edge", id: `e${i}`, from: e.from, to: e.to, label: e.label, dashed: e.style === "dashed", directed: false, stroke: INK, waypoints: [] }))
  return { items, boxes }
}

function ringLayout(spec: DiagramSpec): { items: LItem[]; boxes: Map<string, LBox> } {
  const nodes = spec.nodes ?? []
  const boxes = new Map(nodes.map((n) => [n.id, boxFor(n)]))
  const n = nodes.length
  const maxW = Math.max(...[...boxes.values()].map((b) => b.w)), maxH = Math.max(...[...boxes.values()].map((b) => b.h))
  const chord = Math.hypot(maxW, maxH) * 0.85 + 70
  const r = Math.max(150, chord / (2 * Math.sin(Math.PI / n)))
  const rx = r * 1.25, ry = r
  nodes.forEach((nd, i) => {
    const a = -Math.PI / 2 + (2 * Math.PI * i) / n
    const b = boxes.get(nd.id)!
    b.x = Math.round(rx + rx * Math.cos(a) - b.w / 2)
    b.y = Math.round(ry + ry * Math.sin(a) - b.h / 2)
  })
  const items: LItem[] = [...boxes.values()]
  const explicit = spec.edges ?? []
  const ring = explicit.length ? explicit : nodes.map((nd, i) => ({ from: nd.id, to: nodes[(i + 1) % n].id, label: undefined, style: undefined }))
  ring.forEach((e, i) => items.push({ t: "edge", id: `e${i}`, from: e.from, to: e.to, label: e.label, dashed: e.style === "dashed", directed: true, stroke: INK, waypoints: [] }))
  return { items, boxes }
}

function radialLayout(spec: DiagramSpec): { items: LItem[]; boxes: Map<string, LBox> } {
  const nodes = spec.nodes ?? [], edges = spec.edges ?? []
  const boxes = new Map(nodes.map((n) => [n.id, boxFor(n)]))
  const degree = (id: string) => edges.filter((e) => e.from === id || e.to === id).length
  const centerId = (nodes.find((n) => n.emphasis === "primary") ?? [...nodes].sort((a, b) => degree(b.id) - degree(a.id))[0]).id
  const adj = new Map<string, string[]>(nodes.map((n) => [n.id, []]))
  edges.forEach((e) => { adj.get(e.from)!.push(e.to); adj.get(e.to)!.push(e.from) })
  const dist = new Map<string, number>([[centerId, 0]])
  const parent = new Map<string, string>()
  const queue = [centerId]
  while (queue.length) { const c = queue.shift()!; for (const m of adj.get(c)!) if (!dist.has(m)) { dist.set(m, dist.get(c)! + 1); parent.set(m, c); queue.push(m) } }
  const rings: string[][] = []
  nodes.forEach((n) => { const d = dist.get(n.id) ?? 1; if (d > 0) (rings[d - 1] ??= []).push(n.id) })
  const maxW = Math.max(...[...boxes.values()].map((b) => b.w)), maxH = Math.max(...[...boxes.values()].map((b) => b.h))
  const angle = new Map<string, number>()
  let radiusX = 0, radiusY = 0
  rings.forEach((ring, ri) => {
    if (!ring) return
    const sorted = ri === 0 ? ring : [...ring].sort((a, b) => (angle.get(parent.get(a)!) ?? 0) - (angle.get(parent.get(b)!) ?? 0))
    const need = (Math.hypot(maxW, maxH) * 0.8 + 60) * sorted.length / (2 * Math.PI)
    const prevRx = radiusX
    radiusX = Math.max(prevRx + maxW + 110, need * 1.35, 260)
    radiusY = Math.max(radiusY + maxH + 110, need, 200)
    sorted.forEach((id, i) => {
      const base = ri === 0 ? -Math.PI / 2 + (2 * Math.PI * i) / sorted.length : (angle.get(parent.get(id)!) ?? 0)
      const siblings = sorted.filter((s) => parent.get(s) === parent.get(id))
      const k = siblings.indexOf(id)
      const spread = ri === 0 ? 0 : (k - (siblings.length - 1) / 2) * Math.min(0.5, (2 * Math.PI) / Math.max(sorted.length, 6))
      const a = base + spread
      angle.set(id, a)
    })
    sorted.forEach((id) => { const a = angle.get(id)!; const b = boxes.get(id)!; b.x = Math.round(radiusX * Math.cos(a) - b.w / 2); b.y = Math.round(radiusY * Math.sin(a) - b.h / 2) })
  })
  const c = boxes.get(centerId)!
  c.x = Math.round(-c.w / 2); c.y = Math.round(-c.h / 2)
  const items: LItem[] = [...boxes.values()]
  edges.forEach((e, i) => items.push({ t: "edge", id: `e${i}`, from: e.from, to: e.to, label: e.label, dashed: e.style === "dashed", directed: true, stroke: INK, waypoints: [] }))
  return { items, boxes }
}

function stepsLayout(spec: DiagramSpec, orientation: "TB" | "LR"): { items: LItem[]; boxes: Map<string, LBox> } {
  const nodes = spec.nodes ?? []
  const row = orientation === "LR" && nodes.length <= 5
  const boxes = new Map<string, LBox>()
  nodes.forEach((n, i) => boxes.set(n.id, boxFor({ ...n, kind: n.kind === "equation" ? "data" : n.kind === "decision" ? "process" : n.kind }, n.id, `${i + 1}. `)))
  const wMax = Math.max(...[...boxes.values()].map((b) => b.w))
  let x = 0, y = 0
  nodes.forEach((n) => {
    const b = boxes.get(n.id)!
    if (row) { b.x = x; b.y = 0; x += b.w + 70 }
    else { b.w = wMax; b.x = 0; b.y = y; y += b.h + 56 }
  })
  if (row) { const hMax = Math.max(...[...boxes.values()].map((b) => b.h)); boxes.forEach((b) => { b.y = Math.round((hMax - b.h) / 2) }) }
  const items: LItem[] = [...boxes.values()]
  const order = spec.edges?.length ? spec.edges : nodes.slice(1).map((n, i) => ({ from: nodes[i].id, to: n.id, label: undefined, style: undefined }))
  order.forEach((e, i) => items.push({ t: "edge", id: `e${i}`, from: e.from, to: e.to, label: e.label, dashed: e.style === "dashed", directed: true, stroke: INK, waypoints: [] }))
  // Notes attached to a step sit to its right, joined by a thin dashed line.
  ;(spec.notes ?? []).filter((n) => n.near && boxes.has(n.near)).forEach((note, i) => {
    const b = boxes.get(note.near!)!
    const t = textItem(`note${i}`, note.text, FONT.note, "note", 26, COLORS.slate.stroke)
    if (row) { t.x = b.x; t.y = Math.max(...[...boxes.values()].map((q) => q.y + q.h)) + 40 + i * 6; (t as LText).align = "left" }
    else { t.x = wMax + 70; t.y = Math.round(b.y + b.h / 2 - t.h / 2) }
    items.push(t)
    if (!row) items.push({ t: "shape", id: `noteln${i}`, kind: "line", x: b.x + b.w, y: b.y + b.h / 2, points: [[0, 0], [t.x - (b.x + b.w) - 8, 0]], stroke: COLORS.slate.stroke, fill: "transparent", strokeWidth: 1, role: "connector" })
  })
  return { items, boxes }
}

function comparisonLayout(spec: DiagramSpec): { items: LItem[]; boxes: Map<string, LBox> } {
  const cols = spec.columns ?? []
  const widths = cols.map((c) => Math.max(measure(c.title, FONT.node, 22).w + 40, ...c.items.map((it) => measure(it, FONT.label, 26).w + 36), 190))
  const colW = Math.min(300, Math.max(...widths))
  const boxes = new Map<string, LBox>()
  const items: LItem[] = []
  let x = 0
  cols.forEach((c) => {
    const col = COLORS[c.color ?? "sky"]
    const head = measure(c.title, FONT.node, 22)
    const hb: LBox = { t: "box", id: `${c.id}_h`, shape: "rectangle", x, y: 0, w: colW, h: Math.max(56, head.h + 28), label: head.text, fontSize: FONT.node, stroke: col.stroke, fill: col.fill, strokeWidth: 3, role: "header" }
    boxes.set(hb.id, hb); items.push(hb)
    let y = hb.h + 20
    c.items.forEach((it, j) => {
      const m = measure(it, FONT.label, 26)
      const b: LBox = { t: "box", id: `${c.id}_${j}`, shape: "rectangle", x, y, w: colW, h: Math.max(46, m.h + 22), label: m.text, fontSize: FONT.label, stroke: col.stroke, fill: "transparent", strokeWidth: 1, role: "item" }
      boxes.set(b.id, b); items.push(b); y += b.h + 14
    })
    x += colW + 40
  })
  return { items, boxes }
}

// Labeled illustration: draw the figure in its private 0..100 frame, then call out parts with leader arrows that cannot cross.
function illustrationLayout(spec: DiagramSpec): { items: LItem[]; boxes: Map<string, LBox> } {
  const fig = spec.figure!
  const F = 380
  const s = (v: number) => v * (F / 100)
  const items: LItem[] = []
  const boxes = new Map<string, LBox>()
  const anchors = new Map<string, Rect>()
  fig.parts.forEach((p) => {
    const stroke = COLORS[p.stroke ?? "ink"].stroke
    const fill = p.fill ? COLORS[p.fill].fill : "transparent"
    if (p.box && (p.kind === "ellipse" || p.kind === "rectangle" || p.kind === "diamond")) {
      const b: LBox = { t: "box", id: p.id, shape: p.kind, x: s(p.box.x), y: s(p.box.y), w: Math.max(8, s(p.box.w)), h: Math.max(8, s(p.box.h)), label: "", fontSize: FONT.node, stroke, fill, strokeWidth: 2, role: "figure" }
      boxes.set(p.id, b); items.push(b); anchors.set(p.id, { x: b.x, y: b.y, w: b.w, h: b.h })
    } else if (p.points) {
      const abs = p.points.map(([x, y]) => [s(x), s(y)] as Pt)
      const bb = pointsBounds(abs)!
      const rel = abs.map(([x, y]) => [x - abs[0][0], y - abs[0][1]] as Pt)
      items.push({ t: "shape", id: p.id, kind: p.kind === "polygon" ? "polygon" : p.kind === "freehand" ? "freehand" : p.kind === "arrow" ? "arrow" : "line", x: abs[0][0], y: abs[0][1], points: p.kind === "polygon" ? [...rel, [0, 0] as Pt] : rel, stroke, fill, strokeWidth: 2, role: "figure" })
      anchors.set(p.id, bb)
    }
  })
  const fb = union([...anchors.values()])!
  const side = (l: (typeof fig.labels)[number]): "left" | "right" => {
    if (l.side === "left" || l.side === "right") return l.side
    const a = anchors.get(l.part)!
    return a.x + a.w / 2 < fb.x + fb.w / 2 ? "left" : "right"
  }
  const place = (which: "left" | "right") => {
    const group = fig.labels.filter((l) => side(l) === which).map((l) => ({ l, a: anchors.get(l.part)!, t: textItem(`lbl_${l.part}_${which}`, l.text, FONT.node, "label", 20, INK) }))
    group.sort((p, q) => p.a.y + p.a.h / 2 - (q.a.y + q.a.h / 2))
    let prevBottom = -Infinity
    group.forEach((g) => { g.t.y = Math.max(g.a.y + g.a.h / 2 - g.t.h / 2, prevBottom + 22); prevBottom = g.t.y + g.t.h })
    const shift = group.length ? (group.reduce((a, g) => a + (g.a.y + g.a.h / 2 - (g.t.y + g.t.h / 2)), 0) / group.length) : 0
    group.forEach((g) => { g.t.y = Math.round(g.t.y + Math.max(-40, Math.min(40, shift))) })
    // Re-resolve overlaps after the shift.
    prevBottom = -Infinity
    group.forEach((g) => { if (g.t.y < prevBottom + 22) g.t.y = prevBottom + 22; prevBottom = g.t.y + g.t.h })
    return group
  }
  const L = place("left"), R = place("right")
  const lw = Math.max(0, ...L.map((g) => g.t.w)), rw = Math.max(0, ...R.map((g) => g.t.w))
  const LEAD = 90
  const left = lw + LEAD, figX = fb.x
  const shiftX = left - figX
  items.forEach((it) => { if (it.t === "box" || it.t === "shape") it.x += shiftX })
  anchors.forEach((a, k) => anchors.set(k, { ...a, x: a.x + shiftX }))
  const figRight = fb.x + shiftX + fb.w
  const leader = (g: { l: { part: string }; a: Rect; t: LText }, which: "left" | "right") => {
    const a = anchors.get(g.l.part)!
    const p = fig.parts.find((q) => q.id === g.l.part)!
    const ty = g.t.y + g.t.h / 2
    let from: Pt, to: Pt
    if (which === "left") { g.t.x = lw - g.t.w; from = [lw + 10, ty]; to = [a.x + Math.min(10, a.w * 0.15), a.y + a.h / 2] }
    else { g.t.x = figRight + LEAD; from = [figRight + LEAD - 10, ty]; to = [a.x + a.w - Math.min(10, a.w * 0.15), a.y + a.h / 2] }
    if (p.kind === "line" || p.kind === "arrow" || p.kind === "freehand") to = [a.x + a.w / 2, a.y + a.h / 2]
    items.push(g.t)
    items.push({ t: "shape", id: `ld_${g.l.part}_${which}`, kind: "arrow", x: from[0], y: from[1], points: [[0, 0], [to[0] - from[0], to[1] - from[1]]], stroke: COLORS.slate.stroke, fill: "transparent", strokeWidth: 1, role: "leader" })
  }
  L.forEach((g) => leader(g, "left")); R.forEach((g) => leader(g, "right"))
  void rw
  return { items, boxes }
}

// ------------------------------------------------------------------------------------------------------------------ assembly
function normalize(items: LItem[], title: LText | null, notes: LText[]): Layout["items"] {
  const body = bodyBounds(items)
  const out: LItem[] = []
  let dy = 0
  const width = body.w
  if (title) { title.x = Math.round(body.x + (width - title.w) / 2); title.y = body.y - title.h - 36; out.push(title); dy = 0 }
  out.push(...items)
  let ny = body.y + body.h + 40
  notes.forEach((n) => { n.x = body.x; n.y = ny; ny += n.h + 10; out.push(n) })
  void dy
  return out
}

export function itemBounds(it: LItem, boxes?: Map<string, LBox>): Rect | null {
  if (it.t === "box" || it.t === "text") return { x: it.x, y: it.y, w: it.w, h: it.h }
  if (it.t === "shape") { const b = pointsBounds(it.points.map(([x, y]) => [it.x + x, it.y + y] as Pt)); return b ? { x: b.x, y: b.y, w: Math.max(b.w, 1), h: Math.max(b.h, 1) } : null }
  if (it.t === "edge") { void boxes; return it.waypoints.length ? pointsBounds(it.waypoints) : null }
  return null
}
function bodyBounds(items: LItem[]): Rect {
  return union(items.map((i) => itemBounds(i)).filter((r): r is Rect => !!r)) ?? { x: 0, y: 0, w: 0, h: 0 }
}

/** Where an edge leaves/enters a box: the point on the box boundary toward `toward`. */
export function boundaryPoint(b: Rect & { shape?: string }, toward: Pt): Pt {
  const cx = b.x + b.w / 2, cy = b.y + b.h / 2
  const dx = toward[0] - cx, dy = toward[1] - cy
  if (dx === 0 && dy === 0) return [cx, cy]
  let k: number
  if (b.shape === "ellipse") k = 1 / Math.sqrt((dx * dx) / ((b.w / 2) ** 2) + (dy * dy) / ((b.h / 2) ** 2))
  else if (b.shape === "diamond") k = 1 / (Math.abs(dx) / (b.w / 2) + Math.abs(dy) / (b.h / 2))
  else k = Math.min((b.w / 2) / Math.abs(dx || 1e-9), (b.h / 2) / Math.abs(dy || 1e-9))
  return [cx + dx * k, cy + dy * k]
}

/** The polyline a drawn edge follows (start on `from`'s boundary, via waypoints, to `to`'s boundary). */
export function edgeRoute(e: LEdge, boxes: Map<string, LBox>): Pt[] {
  const a = boxes.get(e.from)!, b = boxes.get(e.to)!
  const ca: Pt = [a.x + a.w / 2, a.y + a.h / 2], cb: Pt = [b.x + b.w / 2, b.y + b.h / 2]
  const first = e.waypoints[0] ?? cb, last = e.waypoints[e.waypoints.length - 1] ?? ca
  return [boundaryPoint(a, first), ...e.waypoints, boundaryPoint(b, last)]
}

export function layoutDiagram(spec: DiagramSpec, forceOrientation?: "TB" | "LR"): Layout {
  const orientation = forceOrientation ?? spec.orientation ?? (spec.type === "steps" || spec.type === "hierarchy" ? "TB" : "TB")
  let built: { items: LItem[]; boxes: Map<string, LBox> }
  let strategy: string
  switch (spec.type) {
    case "flowchart": built = layeredLayout(spec, orientation); strategy = `layered-${orientation}`; break
    case "hierarchy": built = treeLayout(spec, orientation); strategy = `tree-${orientation}`; break
    case "cycle": built = ringLayout(spec); strategy = "ring"; break
    case "concept_map": built = radialLayout(spec); strategy = "radial"; break
    case "steps": built = stepsLayout(spec, orientation); strategy = `steps-${orientation}`; break
    case "comparison": built = comparisonLayout(spec); strategy = "columns"; break
    case "labeled_illustration": built = illustrationLayout(spec); strategy = "figure-callouts"; break
  }
  const title = spec.title ? textItem("title", spec.title, FONT.title, "title", 34, INK, "center") : null
  const trailing = (spec.notes ?? []).filter((n) => !(spec.type === "steps" && n.near)).map((n, i) => textItem(`n${i}`, n.text, FONT.note, "note", 60, COLORS.slate.stroke))
  const items = normalize(built.items, title, trailing)
  // Shift to the origin and report the frame.
  const all = union(items.map((i) => itemBounds(i)).filter((r): r is Rect => !!r)) ?? { x: 0, y: 0, w: 0, h: 0 }
  items.forEach((it) => {
    if (it.t === "box" || it.t === "text" || it.t === "shape") { it.x = Math.round(it.x - all.x); it.y = Math.round(it.y - all.y) }
    else if (it.t === "edge") it.waypoints = it.waypoints.map(([x, y]) => [Math.round(x - all.x), Math.round(y - all.y)] as Pt)
  })
  return { width: Math.ceil(all.w), height: Math.ceil(all.h), items, strategy }
}

// ------------------------------------------------------------------------------------------------------------------ internal validation
export function validateLayout(layout: Layout, maxSide = 4200): LayoutIssue[] {
  const issues: LayoutIssue[] = []
  const boxes = new Map<string, LBox>(layout.items.filter((i): i is LBox => i.t === "box").map((b) => [b.id, b]))
  const flat = [...boxes.values()]
  const figure = (b: LBox) => b.role === "figure"
  if (!Number.isFinite(layout.width + layout.height) || layout.width <= 0 || layout.height <= 0) issues.push({ code: "empty_layout", message: "the layout has no extent", severity: "error" })
  if (layout.width > maxSide || layout.height > maxSide) issues.push({ code: "too_large", message: `layout is ${layout.width}x${layout.height}, larger than ${maxSide}`, severity: "error" })
  for (const it of layout.items) {
    if (it.t === "text" && it.fontSize < FONT.min) issues.push({ code: "small_text", message: `text "${it.text.slice(0, 20)}" is below the readable size`, severity: "error" })
    if (it.t === "box" && it.label && it.fontSize < FONT.min) issues.push({ code: "small_text", message: `label "${it.label.slice(0, 20)}" is below the readable size`, severity: "error" })
  }
  for (let i = 0; i < flat.length; i++) for (let j = i + 1; j < flat.length; j++) {
    const a = flat[i], b = flat[j]
    if (figure(a) && figure(b)) continue            // parts of a drawing are meant to touch and overlap
    if (rectsIntersect(a, b, 6)) issues.push({ code: "boxes_overlap", message: `"${a.id}" overlaps "${b.id}"`, severity: "error" })
  }
  const texts = layout.items.filter((i): i is LText => i.t === "text")
  for (const t of texts) for (const b of flat) if (!figure(b) && rectsIntersect(t, b, 2)) issues.push({ code: "text_covers_box", message: `text "${t.id}" overlaps "${b.id}"`, severity: "error" })
  for (let i = 0; i < texts.length; i++) for (let j = i + 1; j < texts.length; j++) if (rectsIntersect(texts[i], texts[j], 2)) issues.push({ code: "text_overlap", message: `text "${texts[i].id}" overlaps "${texts[j].id}"`, severity: "error" })
  for (const it of layout.items) {
    if (it.t !== "edge") continue
    const route = edgeRoute(it, boxes)
    for (const b of flat) {
      if (b.id === it.from || b.id === it.to) continue
      if (polylineIntersectsRect(route, inflate(b, -2), 0)) issues.push({ code: "edge_crosses_node", message: `edge ${it.from}->${it.to} passes through "${b.id}"`, severity: "error" })
    }
    for (const t of texts) if (polylineIntersectsRect(route, t, 2)) issues.push({ code: "edge_crosses_text", message: `edge ${it.from}->${it.to} runs through text "${t.id}"`, severity: "warning" })
  }
  return issues
}
