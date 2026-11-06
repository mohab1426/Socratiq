// @vitest-environment jsdom
import { describe, expect, it } from "vitest"
import { checkSemantics, parseDiagramSpec, tokenize } from "./diagramSpec"
import { SPECS, mustParse } from "@/test/boardFactory"

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v))
const errorsOf = (raw: unknown) => { const r = parseDiagramSpec(raw); return r.ok ? [] : r.errors }

describe("parseDiagramSpec: strict schema", () => {
  it("accepts every reference spec", () => {
    for (const [k, raw] of Object.entries(SPECS)) expect(parseDiagramSpec(raw).ok, k).toBe(true)
  })
  it("rejects non-objects, wrong version and unknown types", () => {
    expect(parseDiagramSpec(null).ok).toBe(false)
    expect(parseDiagramSpec([]).ok).toBe(false)
    expect(errorsOf({ ...SPECS.flow, version: 2 }).join()).toMatch(/version/)
    expect(errorsOf({ ...SPECS.flow, type: "mindmap" }).join()).toMatch(/type/)
  })
  it("rejects unknown fields instead of silently ignoring them (no invented properties)", () => {
    expect(errorsOf({ ...SPECS.flow, x: 10 }).join()).toMatch(/unknown field "x"/)
    const s = clone(SPECS.flow) as any; s.nodes[0].x = 5
    expect(errorsOf(s).join()).toMatch(/nodes\[0\].*unknown field/)
  })
  it("rejects raw coordinates for nodes: the model may not place anything", () => {
    const s = clone(SPECS.flow) as any; s.nodes[1].y = 300
    expect(parseDiagramSpec(s).ok).toBe(false)
  })
  it("rejects dangling edges, self-loops, duplicates and bad ids", () => {
    const base = clone(SPECS.flow) as any
    expect(errorsOf({ ...base, edges: [...base.edges, { from: "a", to: "ghost" }] }).join()).toMatch(/unknown node "ghost"/)
    expect(errorsOf({ ...base, edges: [{ from: "a", to: "a" }] }).join()).toMatch(/itself/)
    expect(errorsOf({ ...base, edges: [...base.edges, { from: "s", to: "a" }] }).join()).toMatch(/duplicate edge/)
    expect(errorsOf({ ...base, nodes: [...base.nodes, { id: "bad id!", label: "x" }] }).join()).toMatch(/letters, digits/)
    expect(errorsOf({ ...base, nodes: [...base.nodes, { id: "s", label: "again" }] }).join()).toMatch(/duplicate id/)
  })
  it("rejects empty or oversized text and too many nodes", () => {
    const base = clone(SPECS.flow) as any
    expect(errorsOf({ ...base, nodes: [{ id: "q", label: "   " }, ...base.nodes.slice(1)] }).join()).toMatch(/empty/)
    expect(errorsOf({ ...base, nodes: [{ id: "q", label: "x".repeat(200) }, ...base.nodes.slice(1)] }).join()).toMatch(/at most 90/)
    expect(errorsOf({ ...base, nodes: Array.from({ length: 30 }, (_, i) => ({ id: "n" + i, label: "n" })), edges: [] }).join()).toMatch(/more than 24/)
  })
  it("validates figure parts: frame range, required geometry, label references", () => {
    const s = clone(SPECS.fig) as any
    s.figure.parts[0].box = { x: 50, y: 50, w: 80, h: 20 }
    expect(errorsOf(s).join()).toMatch(/box/)
    const t = clone(SPECS.fig) as any
    t.figure.parts[1] = { id: "nuc", kind: "ellipse" }
    expect(errorsOf(t).join()).toMatch(/needs a box/)
    const u = clone(SPECS.fig) as any
    u.figure.labels.push({ part: "missing", text: "x" })
    expect(errorsOf(u).join()).toMatch(/unknown part/)
    const v = clone(SPECS.fig) as any
    v.figure.parts[4].points = [[10, 2], [300, 6]]
    expect(errorsOf(v).join()).toMatch(/0..100 frame/)
    const w = clone(SPECS.fig) as any
    w.figure.parts.push({ id: "tri", kind: "polygon", points: [[0, 0], [10, 10]] })
    expect(errorsOf(w).join()).toMatch(/at least 3 points/)
  })
  it("normalises whitespace in labels", () => {
    const r = parseDiagramSpec({ ...clone(SPECS.cycle), title: "  The   water \n cycle " })
    expect(r.ok && r.spec.title).toBe("The water cycle")
  })
})

describe("checkSemantics: valid JSON is not proof of a correct diagram", () => {
  const sem = (raw: unknown, req = "") => checkSemantics(mustParse(raw), req)
  it("passes all reference specs", () => {
    for (const [k, raw] of Object.entries(SPECS)) expect(sem(raw).errors, k).toEqual([])
  })
  it("flowchart: decisions need branches, no disconnected parts", () => {
    const s = clone(SPECS.flow) as any
    s.edges = s.edges.filter((e: any) => !(e.from === "d" && e.to === "e"))
    expect(sem(s).errors.join()).toMatch(/decision "Valid\?" needs at least 2/)
    const d = clone(SPECS.flow) as any
    d.nodes.push({ id: "z1", label: "Orphan one" }, { id: "z2", label: "Orphan two" }); d.edges.push({ from: "z1", to: "z2" })
    expect(sem(d).errors.join()).toMatch(/disconnected/)
  })
  it("flowchart: warns on unlabeled decision branches", () => {
    const s = clone(SPECS.flow) as any
    s.edges.forEach((e: any) => { if (e.from === "d") delete e.label })
    expect(sem(s).warnings.join()).toMatch(/should be labelled/)
  })
  it("cycle: explicit edges must form one closed ring", () => {
    const s = clone(SPECS.cycle) as any
    s.edges = [{ from: "n0", to: "n1" }, { from: "n1", to: "n2" }, { from: "n2", to: "n3" }, { from: "n3", to: "n0" }]
    expect(sem(s).errors).toEqual([])
    s.edges[3] = { from: "n3", to: "n1" }
    expect(sem(s).errors.join()).toMatch(/closed ring/)
    expect(sem({ ...SPECS.cycle, nodes: SPECS.cycle.nodes.slice(0, 2) }).errors.join()).toMatch(/at least 3/)
  })
  it("hierarchy: one root, one parent each, no cycles", () => {
    const s = clone(SPECS.tree) as any
    s.edges[4] = { from: "b", to: "f" }; s.edges.push({ from: "a", to: "f" }); s.edges.pop()
    expect(sem({ ...s, edges: [...s.edges.slice(0, 4), { from: "d", to: "e" }] }).errors.join()).toMatch(/two parents|one root|parent edge/)
    const forest = clone(SPECS.tree) as any
    forest.edges = forest.edges.filter((e: any) => e.from !== "a")
    expect(sem(forest).errors.length).toBeGreaterThan(0)
  })
  it("concept map: needs relationships and connectivity", () => {
    expect(sem({ ...SPECS.map, edges: [SPECS.map.edges[0]] }).errors.join()).toMatch(/at least 2 relationships/)
  })
  it("steps must be a single chain; comparison needs two columns; illustration needs labels on distinct parts", () => {
    const st = clone(SPECS.steps) as any
    st.edges = [{ from: "1", to: "2" }, { from: "1", to: "3" }]
    expect(sem(st).errors.join()).toMatch(/single chain/)
    expect(sem({ ...SPECS.cmp, columns: [SPECS.cmp.columns[0]] }).errors.join()).toMatch(/at least 2 columns/)
    const fig = clone(SPECS.fig) as any
    fig.figure.labels = [{ part: "wall", text: "Wall" }, { part: "wall", text: "Also wall" }]
    expect(sem(fig).errors.join()).toMatch(/different parts/)
  })
  it("relevance is a warning, not a rejection, so translated labels are not blocked", () => {
    // An Arabic request against an English spec whose topic and labels agree: fine.
    const ok = sem(SPECS.cycle, "ارسم دورة الماء")
    expect(ok.errors).toEqual([])
    expect(ok.warnings.join()).not.toMatch(/may not match/)
    // Labels that share no vocabulary with the stated topic or the request: warn, never reject.
    const off = sem({ version: 1, type: "steps", topic: "photosynthesis", nodes: [{ id: "a", label: "Buy milk" }, { id: "b", label: "Pay at the till" }] }, "explain photosynthesis")
    expect(off.errors).toEqual([])
    expect(off.warnings.join()).toMatch(/may not match/)
    expect(sem(SPECS.map, "explain photosynthesis").warnings.join()).not.toMatch(/may not match/)
  })
})

describe("tokenize", () => {
  it("is unicode-aware and normalises Arabic letter variants", () => {
    expect(tokenize("Photosynthesis, in plants!")).toEqual(["photosynthesis", "in", "plants"])
    expect(tokenize("أشرح الإنزيم")).toEqual(tokenize("اشرح الانزيم"))
  })
})
