/**
 * Structured diagram specification: the ONLY thing the LLM is allowed to produce for a drawing.
 * It describes semantics (what exists, how things relate, how they are labelled) and never raw canvas coordinates.
 * Positions come from the deterministic layout engine and the board-aware placement engine.
 *
 * Illustration parts are the one place with numbers: they live in a private 0..100 frame ("draw the figure on a 100x100 sheet") and are
 * scaled and positioned by the layout engine, so the model cannot place anything on the student's board.
 *
 * The same contract is enforced server-side (`ai/whiteboard/diagram.py`). Keep both in sync.
 */
export const DIAGRAM_TYPES = ["flowchart", "cycle", "hierarchy", "concept_map", "steps", "comparison", "labeled_illustration"] as const
export type DiagramType = (typeof DIAGRAM_TYPES)[number]

export const PALETTE_NAMES = ["ink", "teal", "sky", "amber", "rose", "violet", "green", "slate"] as const
export type PaletteName = (typeof PALETTE_NAMES)[number]

export const NODE_KINDS = ["process", "decision", "terminal", "data", "concept", "equation", "note"] as const
export type NodeKind = (typeof NODE_KINDS)[number]

export const PART_KINDS = ["ellipse", "rectangle", "diamond", "line", "polygon", "freehand", "arrow"] as const
export type PartKind = (typeof PART_KINDS)[number]

export interface SpecNode { id: string; label: string; kind?: NodeKind; emphasis?: "primary" | "secondary" | "muted"; color?: PaletteName }
export interface SpecEdge { from: string; to: string; label?: string; style?: "solid" | "dashed" }
export interface SpecColumn { id: string; title: string; items: string[]; color?: PaletteName }
export interface FigurePart { id: string; kind: PartKind; box?: { x: number; y: number; w: number; h: number }; points?: [number, number][]; fill?: PaletteName | null; stroke?: PaletteName }
export interface FigureLabel { part: string; text: string; side?: "left" | "right" | "auto" }
export interface SpecNote { text: string; near?: string }
export interface SpecRelation { mode: "new" | "extend" | "explain"; targetId?: string }

export interface DiagramSpec {
  version: 1
  type: DiagramType
  topic: string
  title?: string
  orientation?: "TB" | "LR"
  nodes?: SpecNode[]
  edges?: SpecEdge[]
  columns?: SpecColumn[]
  figure?: { parts: FigurePart[]; labels: FigureLabel[] }
  notes?: SpecNote[]
  relation?: SpecRelation
}

export const LIMITS = { nodes: 24, edges: 40, label: 90, title: 80, topic: 120, columns: 4, items: 8, parts: 30, figureLabels: 14, freehandPoints: 80, notes: 6, id: 32 } as const
const ID_RE = /^[A-Za-z0-9_-]{1,32}$/

export type ParseResult = { ok: true; spec: DiagramSpec } | { ok: false; errors: string[] }

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v)

class Collector {
  errors: string[] = []
  err(path: string, msg: string) { if (this.errors.length < 25) this.errors.push(`${path}: ${msg}`) }
}

function noExtra(c: Collector, path: string, o: Obj, allowed: readonly string[]) {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) c.err(path, `unknown field "${k}"`)
}
function str(c: Collector, path: string, v: unknown, max: number, required = true): string | undefined {
  if (v === undefined || v === null) { if (required) c.err(path, "is required"); return undefined }
  if (typeof v !== "string") { c.err(path, "must be a string"); return undefined }
  const t = v.replace(/\s+/g, " ").trim()
  if (!t) { if (required) c.err(path, "must not be empty"); return undefined }
  if (t.length > max) { c.err(path, `must be at most ${max} characters`); return undefined }
  return t
}
function oneOf<T extends string>(c: Collector, path: string, v: unknown, allowed: readonly T[], required = false): T | undefined {
  if (v === undefined || v === null) { if (required) c.err(path, "is required"); return undefined }
  if (typeof v !== "string" || !allowed.includes(v as T)) { c.err(path, `must be one of ${allowed.join(", ")}`); return undefined }
  return v as T
}
function id(c: Collector, path: string, v: unknown): string | undefined {
  if (typeof v !== "string" || !ID_RE.test(v)) { c.err(path, "must be 1-32 letters, digits, '_' or '-'"); return undefined }
  return v
}
const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v)
function list(c: Collector, path: string, v: unknown, max: number, min = 0): unknown[] | undefined {
  if (v === undefined || v === null) return undefined
  if (!Array.isArray(v)) { c.err(path, "must be a list"); return undefined }
  if (v.length > max) { c.err(path, `has more than ${max} entries`); return undefined }
  if (v.length < min) { c.err(path, `needs at least ${min} entries`); return undefined }
  return v
}

/** Strict parse: unknown fields, wrong types, bad ids, dangling references and out-of-range numbers are all rejected. */
export function parseDiagramSpec(raw: unknown): ParseResult {
  const c = new Collector()
  if (!isObj(raw)) return { ok: false, errors: ["spec: must be an object"] }
  noExtra(c, "spec", raw, ["version", "type", "topic", "title", "orientation", "nodes", "edges", "columns", "figure", "notes", "relation"])
  if (raw.version !== 1) c.err("version", "must be 1")
  const type = oneOf(c, "type", raw.type, DIAGRAM_TYPES, true)
  const topic = str(c, "topic", raw.topic, LIMITS.topic)
  const title = str(c, "title", raw.title, LIMITS.title, false)
  const orientation = oneOf(c, "orientation", raw.orientation, ["TB", "LR"] as const)

  const nodes: SpecNode[] = []
  const nodeIds = new Set<string>()
  list(c, "nodes", raw.nodes, LIMITS.nodes)?.forEach((n, i) => {
    const p = `nodes[${i}]`
    if (!isObj(n)) return c.err(p, "must be an object")
    noExtra(c, p, n, ["id", "label", "kind", "emphasis", "color"])
    const nid = id(c, p + ".id", n.id)
    const label = str(c, p + ".label", n.label, LIMITS.label)
    if (nid && nodeIds.has(nid)) c.err(p + ".id", `duplicate id "${nid}"`)
    if (nid) nodeIds.add(nid)
    if (nid && label) nodes.push({ id: nid, label, kind: oneOf(c, p + ".kind", n.kind, NODE_KINDS), emphasis: oneOf(c, p + ".emphasis", n.emphasis, ["primary", "secondary", "muted"] as const), color: oneOf(c, p + ".color", n.color, PALETTE_NAMES) })
  })

  const edges: SpecEdge[] = []
  list(c, "edges", raw.edges, LIMITS.edges)?.forEach((e, i) => {
    const p = `edges[${i}]`
    if (!isObj(e)) return c.err(p, "must be an object")
    noExtra(c, p, e, ["from", "to", "label", "style"])
    const from = id(c, p + ".from", e.from), to = id(c, p + ".to", e.to)
    if (from && !nodeIds.has(from)) c.err(p + ".from", `refers to unknown node "${from}"`)
    if (to && !nodeIds.has(to)) c.err(p + ".to", `refers to unknown node "${to}"`)
    if (from && to && from === to) c.err(p, "an edge cannot connect a node to itself")
    if (from && to && nodeIds.has(from) && nodeIds.has(to) && from !== to) {
      if (edges.some((x) => x.from === from && x.to === to)) c.err(p, `duplicate edge ${from} -> ${to}`)
      else edges.push({ from, to, label: str(c, p + ".label", e.label, 40, false), style: oneOf(c, p + ".style", e.style, ["solid", "dashed"] as const) })
    }
  })

  const columns: SpecColumn[] = []
  list(c, "columns", raw.columns, LIMITS.columns)?.forEach((col, i) => {
    const p = `columns[${i}]`
    if (!isObj(col)) return c.err(p, "must be an object")
    noExtra(c, p, col, ["id", "title", "items", "color"])
    const cid = id(c, p + ".id", col.id)
    const t = str(c, p + ".title", col.title, 50)
    const items = (list(c, p + ".items", col.items, LIMITS.items, 1) ?? []).map((it, j) => str(c, `${p}.items[${j}]`, it, LIMITS.label)).filter((x): x is string => !!x)
    if (cid && t && items.length > 0) columns.push({ id: cid, title: t, items, color: oneOf(c, p + ".color", col.color, PALETTE_NAMES) })
  })

  let figure: DiagramSpec["figure"]
  if (raw.figure !== undefined) {
    const f = raw.figure
    if (!isObj(f)) c.err("figure", "must be an object")
    else {
      noExtra(c, "figure", f, ["parts", "labels"])
      const parts: FigurePart[] = []
      const partIds = new Set<string>()
      list(c, "figure.parts", f.parts, LIMITS.parts, 1)?.forEach((pt, i) => {
        const p = `figure.parts[${i}]`
        if (!isObj(pt)) return c.err(p, "must be an object")
        noExtra(c, p, pt, ["id", "kind", "box", "points", "fill", "stroke"])
        const pid = id(c, p + ".id", pt.id)
        const kind = oneOf(c, p + ".kind", pt.kind, PART_KINDS, true)
        if (pid && partIds.has(pid)) c.err(p + ".id", `duplicate id "${pid}"`)
        if (pid) partIds.add(pid)
        const inFrame = (n: unknown) => num(n) && n >= 0 && n <= 100
        let box: FigurePart["box"]
        let points: FigurePart["points"]
        if (pt.box !== undefined) {
          const b = pt.box
          if (!isObj(b) || !inFrame(b.x) || !inFrame(b.y) || !num(b.w) || !num(b.h) || b.w <= 0 || b.h <= 0 || (b.x as number) + b.w > 100.001 || (b.y as number) + b.h > 100.001) c.err(p + ".box", "needs x, y, w, h inside the 0..100 frame")
          else box = { x: b.x as number, y: b.y as number, w: b.w, h: b.h }
        }
        if (pt.points !== undefined) {
          const arr = list(c, p + ".points", pt.points, LIMITS.freehandPoints, 2)
          const ok = arr?.every((q) => Array.isArray(q) && q.length === 2 && inFrame(q[0]) && inFrame(q[1]))
          if (arr && !ok) c.err(p + ".points", "must be [x, y] pairs inside the 0..100 frame")
          else if (arr) points = arr as [number, number][]
        }
        if (kind && ["ellipse", "rectangle", "diamond"].includes(kind) && !box) c.err(p, `${kind} needs a box`)
        if (kind && ["line", "polygon", "freehand", "arrow"].includes(kind) && !points) c.err(p, `${kind} needs points`)
        if (kind === "polygon" && points && points.length < 3) c.err(p + ".points", "a polygon needs at least 3 points")
        const fill = pt.fill === null ? null : oneOf(c, p + ".fill", pt.fill, PALETTE_NAMES)
        if (pid && kind) parts.push({ id: pid, kind, box, points, fill, stroke: oneOf(c, p + ".stroke", pt.stroke, PALETTE_NAMES) })
      })
      const labels: FigureLabel[] = []
      list(c, "figure.labels", f.labels, LIMITS.figureLabels, 1)?.forEach((lb, i) => {
        const p = `figure.labels[${i}]`
        if (!isObj(lb)) return c.err(p, "must be an object")
        noExtra(c, p, lb, ["part", "text", "side"])
        const part = id(c, p + ".part", lb.part)
        if (part && !partIds.has(part)) c.err(p + ".part", `refers to unknown part "${part}"`)
        const text = str(c, p + ".text", lb.text, 60)
        if (part && text && partIds.has(part)) labels.push({ part, text, side: oneOf(c, p + ".side", lb.side, ["left", "right", "auto"] as const) })
      })
      if (parts.length > 0 && labels.length > 0) figure = { parts, labels }
      else if (c.errors.length === 0) c.err("figure", "needs at least one part and one label")
    }
  }

  const notes: SpecNote[] = []
  list(c, "notes", raw.notes, LIMITS.notes)?.forEach((n, i) => {
    const p = `notes[${i}]`
    if (!isObj(n)) return c.err(p, "must be an object")
    noExtra(c, p, n, ["text", "near"])
    const text = str(c, p + ".text", n.text, 160)
    const near = n.near === undefined ? undefined : id(c, p + ".near", n.near)
    if (near && !nodeIds.has(near)) c.err(p + ".near", `refers to unknown node "${near}"`)
    if (text) notes.push({ text, near })
  })

  let relation: SpecRelation | undefined
  if (raw.relation !== undefined) {
    const r = raw.relation
    if (!isObj(r)) c.err("relation", "must be an object")
    else {
      noExtra(c, "relation", r, ["mode", "targetId"])
      const mode = oneOf(c, "relation.mode", r.mode, ["new", "extend", "explain"] as const, true)
      const targetId = r.targetId === undefined || r.targetId === null ? undefined : str(c, "relation.targetId", r.targetId, 64)
      if (mode) relation = { mode, targetId }
    }
  }

  if (c.errors.length > 0 || !type || !topic) return { ok: false, errors: c.errors.length ? c.errors : ["spec: incomplete"] }
  const spec: DiagramSpec = { version: 1, type, topic, title, orientation, nodes: nodes.length ? nodes : undefined, edges: edges.length ? edges : undefined, columns: columns.length ? columns : undefined, figure, notes: notes.length ? notes : undefined, relation }
  return { ok: true, spec }
}

// ------------------------------------------------------------------------------------------------------------------ semantic checks
export interface SemanticReport { errors: string[]; warnings: string[] }

export const tokenize = (s: string): string[] =>
  (s.toLowerCase().normalize("NFKD").replace(/\p{M}/gu, "").replace(/[أإآٱ]/g, "ا").replace(/ى/g, "ي").replace(/ة/g, "ه").match(/[\p{L}\p{N}]+/gu) ?? []).filter((t) => t.length > 1)

function components(ids: string[], edges: SpecEdge[]): number {
  const parent = new Map(ids.map((i) => [i, i]))
  const find = (a: string): string => { let r = a; while (parent.get(r) !== r) r = parent.get(r)!; parent.set(a, r); return r }
  for (const e of edges) parent.set(find(e.from), find(e.to))
  return new Set(ids.map(find)).size
}
function hasCycle(ids: string[], edges: SpecEdge[]): boolean {
  const out = new Map<string, string[]>(ids.map((i) => [i, []]))
  edges.forEach((e) => out.get(e.from)!.push(e.to))
  const state = new Map<string, 1 | 2>()
  const visit = (n: string): boolean => {
    if (state.get(n) === 2) return false
    if (state.get(n) === 1) return true
    state.set(n, 1)
    for (const m of out.get(n)!) if (visit(m)) return true
    state.set(n, 2)
    return false
  }
  return ids.some(visit)
}

/**
 * Does this spec really describe a coherent diagram of the stated type? Valid JSON is necessary, never sufficient.
 * Errors reject the spec; warnings are surfaced in diagnostics only (a relevance heuristic must not block legitimate synonyms/translations).
 */
export function checkSemantics(spec: DiagramSpec, request = ""): SemanticReport {
  const errors: string[] = []
  const warnings: string[] = []
  const nodes = spec.nodes ?? []
  const edges = spec.edges ?? []
  const ids = nodes.map((n) => n.id)
  const outDeg = (id: string) => edges.filter((e) => e.from === id).length
  const inDeg = (id: string) => edges.filter((e) => e.to === id).length

  switch (spec.type) {
    case "flowchart": {
      if (nodes.length < 2) errors.push("a flowchart needs at least 2 nodes")
      if (edges.length < 1) errors.push("a flowchart needs at least 1 edge")
      if (nodes.length >= 2 && edges.length >= 1 && components(ids, edges) > 1) errors.push("the flowchart has disconnected parts")
      for (const n of nodes) if (n.kind === "decision" && outDeg(n.id) < 2) errors.push(`decision "${n.label}" needs at least 2 outgoing branches`)
      for (const n of nodes) if (n.kind === "decision" && edges.filter((e) => e.from === n.id && !e.label).length > 0) warnings.push(`branches out of "${n.label}" should be labelled`)
      break
    }
    case "cycle": {
      if (nodes.length < 3) errors.push("a cycle needs at least 3 nodes")
      if (edges.length > 0) {
        if (edges.length !== nodes.length || nodes.some((n) => inDeg(n.id) !== 1 || outDeg(n.id) !== 1) || components(ids, edges) !== 1) errors.push("cycle edges must form one closed ring through every node")
      }
      break
    }
    case "hierarchy": {
      if (nodes.length < 2) errors.push("a hierarchy needs at least 2 nodes")
      if (edges.length !== nodes.length - 1) errors.push("a hierarchy needs exactly one parent edge per non-root node")
      else {
        if (nodes.some((n) => inDeg(n.id) > 1)) errors.push("a node in a hierarchy cannot have two parents")
        if (nodes.filter((n) => inDeg(n.id) === 0).length !== 1) errors.push("a hierarchy needs exactly one root")
        if (hasCycle(ids, edges)) errors.push("a hierarchy cannot contain a cycle")
      }
      break
    }
    case "concept_map": {
      if (nodes.length < 3) errors.push("a concept map needs at least 3 concepts")
      if (edges.length < 2) errors.push("a concept map needs at least 2 relationships")
      else if (components(ids, edges) > 1) errors.push("the concept map has disconnected concepts")
      if (edges.length > 0 && edges.filter((e) => !e.label).length > edges.length / 2) warnings.push("most relationships are unlabelled")
      break
    }
    case "steps": {
      if (nodes.length < 2) errors.push("steps need at least 2 entries")
      if (edges.length > 0 && (edges.length !== nodes.length - 1 || nodes.some((n) => inDeg(n.id) > 1 || outDeg(n.id) > 1) || components(ids, edges) !== 1 || hasCycle(ids, edges))) errors.push("step edges must form a single chain")
      break
    }
    case "comparison": {
      const cols = spec.columns ?? []
      if (cols.length < 2) errors.push("a comparison needs at least 2 columns")
      break
    }
    case "labeled_illustration": {
      const fig = spec.figure
      if (!fig) { errors.push("an illustration needs a figure"); break }
      if (fig.labels.length < 2) errors.push("an illustration needs at least 2 labels")
      const labelled = new Set(fig.labels.map((l) => l.part))
      if (labelled.size < Math.min(2, fig.parts.length)) errors.push("labels must point at different parts")
      if (fig.parts.length > 0 && labelled.size / fig.parts.length < 0.3) warnings.push("most parts of the figure are unlabelled")
      break
    }
  }
  if (spec.type !== "comparison" && spec.type !== "labeled_illustration" && nodes.length === 0) errors.push(`${spec.type} needs nodes`)

  const texts = [spec.title ?? "", ...nodes.map((n) => n.label), ...edges.map((e) => e.label ?? ""), ...(spec.columns ?? []).flatMap((c) => [c.title, ...c.items]), ...(spec.figure?.labels.map((l) => l.text) ?? [])]
  if (new Set(texts.map((t) => t.toLowerCase()).filter(Boolean)).size < texts.filter(Boolean).length * 0.6) warnings.push("many labels are duplicated")
  const want = new Set([...tokenize(spec.topic), ...tokenize(request)])
  if (want.size > 0 && !texts.some((t) => tokenize(t).some((w) => want.has(w)))) warnings.push("no label shares vocabulary with the request: the diagram may not match it")
  return { errors, warnings }
}
