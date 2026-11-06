import "@/test/excalidrawEnv"
import { convertToExcalidrawElements, restoreElements } from "@excalidraw/excalidraw"
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types"
import { generateNKeysBetween } from "fractional-indexing"
import { parseDiagramSpec, type DiagramSpec } from "@/lib/smartboard/diagramSpec"
import { withMeta } from "@/lib/smartboard/meta"

/** Builds boards out of REAL Excalidraw elements so tests exercise the same data structures the app does. */
type Skel = Record<string, unknown>
const NOW = 1_700_000_000_000

export function board(...parts: (ExcalidrawElement | ExcalidrawElement[])[]): ExcalidrawElement[] {
  const flat = parts.flat()
  const keys = generateNKeysBetween(null, null, flat.length)
  return flat.map((e, i) => ({ ...e, index: keys[i] as never }))
}
const conv = (s: Skel[]) => convertToExcalidrawElements(s as never, { regenerateIds: false }) as ExcalidrawElement[]

export const text = (id: string, x: number, y: number, t: string, fontSize = 20, extra: Skel = {}) => conv([{ type: "text", id, x, y, text: t, fontSize, ...extra }])
export const rectEl = (id: string, x: number, y: number, w: number, h: number, extra: Skel = {}) => conv([{ type: "rectangle", id, x, y, width: w, height: h, ...extra }])
export const ellipseEl = (id: string, x: number, y: number, w: number, h: number) => conv([{ type: "ellipse", id, x, y, width: w, height: h }])
export const arrowEl = (id: string, x: number, y: number, w: number, h: number) => conv([{ type: "arrow", id, x, y, width: w, height: h }])

function hand(id: string, type: string, x: number, y: number, pts: [number, number][], extra: Skel = {}): ExcalidrawElement[] {
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1])
  return restoreElements([{ id, type, x, y, width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys), angle: 0, strokeColor: "#1e1e1e", backgroundColor: "transparent", fillStyle: "solid", strokeWidth: 2, strokeStyle: "solid", roughness: 1, opacity: 100,
    groupIds: [], frameId: null, index: null, roundness: null, seed: 1, version: 1, versionNonce: 1, isDeleted: false, boundElements: null, updated: NOW, link: null, locked: false, points: pts, pressures: [], simulatePressure: true, lastCommittedPoint: null, ...extra }] as never, null, { refreshDimensions: false }) as ExcalidrawElement[]
}
export const freedraw = (id: string, x: number, y: number, pts: [number, number][]) => hand(id, "freedraw", x, y, pts)
/** A closed circular doodle, the kind a student draws around something. */
export const loop = (id: string, cx: number, cy: number, r: number) => freedraw(id, cx + r, cy, Array.from({ length: 25 }, (_, i) => [r * (Math.cos((2 * Math.PI * i) / 24) - 1), r * Math.sin((2 * Math.PI * i) / 24)] as [number, number]))
export const imageEl = (id: string, x: number, y: number, w: number, h: number) => hand(id, "image", x, y, [[0, 0], [w, h]], { fileId: "file-" + id, status: "saved", scale: [1, 1], crop: null, points: undefined, width: w, height: h })

/** Put elements in one group authored by the AI. */
export function aiGroup(opId: string, els: ExcalidrawElement[]): ExcalidrawElement[] {
  return els.map((e) => ({ ...e, groupIds: [`ai-group-${opId}`], customData: withMeta(undefined, { author: "ai", opId, role: "part" }) }))
}
export const inGroup = (gid: string, els: ExcalidrawElement[]) => els.map((e) => ({ ...e, groupIds: [gid] }))

export const mustParse = (raw: unknown): DiagramSpec => {
  const r = parseDiagramSpec(raw)
  if (!r.ok) throw new Error("bad test spec: " + r.errors.join("; "))
  return r.spec
}

export const SPECS = {
  flow: { version: 1, type: "flowchart", topic: "login flow", title: "Login flow", nodes: [
    { id: "s", label: "Start", kind: "terminal" }, { id: "a", label: "Enter credentials" }, { id: "d", label: "Valid?", kind: "decision" },
    { id: "h", label: "Show home page" }, { id: "e", label: "Show error message" }, { id: "x", label: "End", kind: "terminal" }],
    edges: [{ from: "s", to: "a" }, { from: "a", to: "d" }, { from: "d", to: "h", label: "yes" }, { from: "d", to: "e", label: "no" }, { from: "e", to: "a" }, { from: "h", to: "x" }] },
  cycle: { version: 1, type: "cycle", topic: "water cycle", title: "The water cycle", nodes: ["Evaporation", "Condensation", "Precipitation", "Collection"].map((l, i) => ({ id: "n" + i, label: l })) },
  tree: { version: 1, type: "hierarchy", topic: "animal classification", nodes: [{ id: "a", label: "Animals" }, { id: "b", label: "Vertebrates" }, { id: "c", label: "Invertebrates" }, { id: "d", label: "Mammals" }, { id: "e", label: "Birds" }, { id: "f", label: "Insects" }],
    edges: [{ from: "a", to: "b" }, { from: "a", to: "c" }, { from: "b", to: "d" }, { from: "b", to: "e" }, { from: "c", to: "f" }] },
  map: { version: 1, type: "concept_map", topic: "photosynthesis", title: "Photosynthesis", nodes: [{ id: "p", label: "Photosynthesis", emphasis: "primary" }, { id: "l", label: "Light energy" }, { id: "w", label: "Water" }, { id: "c", label: "Carbon dioxide" }, { id: "g", label: "Glucose" }, { id: "o", label: "Oxygen" }],
    edges: [{ from: "l", to: "p", label: "powers" }, { from: "w", to: "p", label: "input" }, { from: "c", to: "p", label: "input" }, { from: "p", to: "g", label: "produces" }, { from: "p", to: "o", label: "releases" }] },
  steps: { version: 1, type: "steps", topic: "solving a quadratic equation", nodes: [{ id: "1", label: "Write ax^2 + bx + c = 0" }, { id: "2", label: "Compute the discriminant b^2 - 4ac" }, { id: "3", label: "Apply the quadratic formula" }], notes: [{ text: "a must not be 0", near: "1" }] },
  cmp: { version: 1, type: "comparison", topic: "mitosis versus meiosis", columns: [{ id: "a", title: "Mitosis", items: ["One division", "2 identical cells"] }, { id: "b", title: "Meiosis", items: ["Two divisions", "4 different cells", "Makes gametes"], color: "rose" }] },
  fig: { version: 1, type: "labeled_illustration", topic: "plant cell", title: "Plant cell", figure: { parts: [
    { id: "wall", kind: "rectangle", box: { x: 5, y: 10, w: 90, h: 80 }, stroke: "green" }, { id: "nuc", kind: "ellipse", box: { x: 35, y: 35, w: 25, h: 25 }, fill: "violet" },
    { id: "vac", kind: "ellipse", box: { x: 60, y: 55, w: 28, h: 28 }, fill: "sky" }, { id: "chl", kind: "ellipse", box: { x: 12, y: 60, w: 18, h: 12 }, fill: "green" },
    { id: "ray", kind: "freehand", points: [[10, 2], [30, 6], [50, 9], [60, 8]], stroke: "amber" }],
    labels: [{ part: "wall", text: "Cell wall" }, { part: "nuc", text: "Nucleus" }, { part: "vac", text: "Vacuole" }, { part: "chl", text: "Chloroplast" }, { part: "ray", text: "Sunlight" }] } },
} as const
export const spec = (k: keyof typeof SPECS) => mustParse(SPECS[k])
export const bigFlow = (n: number): DiagramSpec => mustParse({ version: 1, type: "flowchart", topic: "large process", nodes: Array.from({ length: n }, (_, i) => ({ id: "n" + i, label: `Step number ${i + 1} of the process` })), edges: Array.from({ length: n - 1 }, (_, i) => ({ from: "n" + i, to: "n" + (i + 1) })) })
