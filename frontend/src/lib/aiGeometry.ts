/**
 * Pure geometry helpers for AI-generated lines, arrows and SVG paths.
 *
 * Why this exists: the layout planner may have to TRANSLATE an AI-supplied drawing (to avoid existing
 * content or to bring it on screen). That must move the whole drawing rigidly - never just its first
 * point - and must keep the drawing's direction and length. These helpers make that explicit and testable.
 *
 * Storage conventions (they match how the renderer in SmartBoard.tsx and the student tools work):
 *   - line:  (x, y) is the START, (x2, y2) the END; w / h are |dx| / |dy|.
 *   - arrow: (x, y) is the START and the END is (x + w, y + h) with SIGNED w / h (x2 / y2 are not used
 *            by the renderer for free arrows; `arrowEndpoints` in whiteboard.ts derives the end from w/h).
 *   - path:  `pathData` is element-LOCAL; it is rendered as translate(x, y) + d. Moving a path is
 *            therefore a change of (x, y); its drawn region is (x + localMinX, y + localMinY, w, h).
 */
import { BOARD_H, BOARD_W } from "./whiteboard"

export interface Box {
  x: number
  y: number
  w: number
  h: number
}

/** Board edge margin used by the placement engine (kept equal to boardLayoutEngine.BOARD_PADDING). */
export const GEOMETRY_BOARD_PADDING = 32
/** Length of the line the fallback draws when the AI gave no usable coordinates. */
export const DEFAULT_LINE_LENGTH = 140

/** A finite number, from a number or a numeric string; otherwise undefined. */
export function finiteNumber(v: unknown): number | undefined {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v)
    return Number.isFinite(n) ? n : undefined
  }
  return undefined
}

/**
 * Whether a box is positioned where the AI evidently meant it to be: finite, inside the board, and not
 * parked at the top-left origin (the value models emit when they do not know where to draw).
 */
export function isMeaningfulBox(box: Box): boolean {
  if (![box.x, box.y, box.w, box.h].every(Number.isFinite)) return false
  if (box.x < 0 || box.y < 0 || box.x + box.w > BOARD_W || box.y + box.h > BOARD_H) return false
  return !(box.x < GEOMETRY_BOARD_PADDING && box.y < GEOMETRY_BOARD_PADDING)
}

// ---------------------------------------------------------------------------------------------------- lines & arrows

export interface Segment {
  x1: number
  y1: number
  x2: number
  y2: number
}

/** Read four endpoints from tool args. Returns null unless all four are finite and the segment is not a point. */
export function readSegment(args: Record<string, unknown>): Segment | null {
  const x1 = finiteNumber(args.x1)
  const y1 = finiteNumber(args.y1)
  const x2 = finiteNumber(args.x2)
  const y2 = finiteNumber(args.y2)
  if (x1 === undefined || y1 === undefined || x2 === undefined || y2 === undefined) return null
  if (Math.hypot(x2 - x1, y2 - y1) < 1) return null
  return { x1, y1, x2, y2 }
}

export const segmentBox = (s: Segment): Box => ({
  x: Math.min(s.x1, s.x2),
  y: Math.min(s.y1, s.y2),
  w: Math.abs(s.x2 - s.x1),
  h: Math.abs(s.y2 - s.y1),
})

/** Rigid translation. Direction and length are unchanged by construction. */
export const translateSegment = (s: Segment, dx: number, dy: number): Segment => ({
  x1: s.x1 + dx,
  y1: s.y1 + dy,
  x2: s.x2 + dx,
  y2: s.y2 + dy,
})

/**
 * The translation that brings `box` inside [margin, board - margin] on each axis while moving it as little
 * as possible. A box larger than the board is centred on that axis (it cannot fit; it is never scaled).
 */
export function translationIntoBoard(box: Box, margin = 0): { dx: number; dy: number } {
  const fit = (pos: number, size: number, max: number) => {
    const lo = margin
    const hi = max - margin
    if (size >= hi - lo) return (lo + hi) / 2 - (pos + size / 2)
    if (pos < lo) return lo - pos
    if (pos + size > hi) return hi - (pos + size)
    return 0
  }
  return { dx: fit(box.x, box.w, BOARD_W), dy: fit(box.y, box.h, BOARD_H) }
}

/** Element fields for a `line`: start (x, y), end (x2, y2), w / h = absolute extents. */
export function lineElementGeometry(s: Segment) {
  return { x: s.x1, y: s.y1, w: Math.abs(s.x2 - s.x1), h: Math.abs(s.y2 - s.y1), x2: s.x2, y2: s.y2 }
}

/**
 * Element fields for a free `arrow`: start (x, y) and SIGNED w / h so the renderer's
 * (x, y) -> (x + w, y + h) draws the arrow in the direction the AI asked for. (Storing min/abs, as an
 * earlier version did, flips every arrow that points left or up.)
 */
export function arrowElementGeometry(s: Segment) {
  return { x: s.x1, y: s.y1, w: s.x2 - s.x1, h: s.y2 - s.y1 }
}

/** Start and end of a line or free arrow element, using the conventions above. */
export function connectorEndpoints(el: {
  kind: string
  x: number
  y: number
  w: number
  h: number
  x2?: number
  y2?: number
}): Segment {
  if (el.kind === "line") return { x1: el.x, y1: el.y, x2: el.x2 ?? el.x + el.w, y2: el.y2 ?? el.y + el.h }
  return { x1: el.x, y1: el.y, x2: el.x + el.w, y2: el.y + el.h }
}

// ---------------------------------------------------------------------------------------------------- SVG paths

interface PathCommand {
  cmd: string
  args: number[]
}

const ARG_COUNT: Record<string, number> = { m: 2, l: 2, h: 1, v: 1, c: 6, s: 4, q: 4, t: 2, a: 7, z: 0 }
const TOKEN = /([MmLlHhVvCcSsQqTtAaZz])|([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)/g

/**
 * Parse an SVG path `d` string into commands (implicit repeats are expanded: "M 0 0 10 10" becomes M then L).
 * Returns null for anything it cannot parse with certainty (bad token, wrong argument count, no leading
 * move). Compact arc-flag notation such as "a1 1 0 01.5.5" is deliberately treated as unparseable.
 */
export function parsePathData(d: unknown): PathCommand[] | null {
  if (typeof d !== "string") return null
  const src = d.trim()
  if (!src) return null

  const tokens: Array<{ cmd?: string; num?: number }> = []
  let last = 0
  TOKEN.lastIndex = 0
  for (let m = TOKEN.exec(src); m; m = TOKEN.exec(src)) {
    if (/[^\s,]/.test(src.slice(last, m.index))) return null // stray characters between tokens
    last = TOKEN.lastIndex
    if (m[1]) tokens.push({ cmd: m[1] })
    else tokens.push({ num: Number(m[2]) })
  }
  if (/[^\s,]/.test(src.slice(last))) return null
  if (tokens.length === 0 || !tokens[0].cmd || !/[Mm]/.test(tokens[0].cmd)) return null

  const out: PathCommand[] = []
  let i = 0
  while (i < tokens.length) {
    const t = tokens[i]
    if (!t.cmd) return null
    i++
    let cmd = t.cmd
    const n = ARG_COUNT[cmd.toLowerCase()]
    if (n === 0) {
      out.push({ cmd, args: [] })
      continue
    }
    let groups = 0
    while (i < tokens.length && tokens[i].num !== undefined) {
      if (i + n > tokens.length) return null
      const args: number[] = []
      for (let k = 0; k < n; k++) {
        const tok = tokens[i + k]
        if (tok.num === undefined || !Number.isFinite(tok.num)) return null
        args.push(tok.num)
      }
      out.push({ cmd, args })
      i += n
      groups++
      // After the first coordinate pair, further pairs of a moveto are implicit linetos.
      if (cmd === "M") cmd = "L"
      else if (cmd === "m") cmd = "l"
    }
    if (groups === 0) return null
  }
  return out
}

/** Bounds of a parsed path in its own local coordinates (end points and control points; arcs use end points only). */
export function getPathBounds(commands: PathCommand[]): Box | null {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  let cx = 0
  let cy = 0
  let sx = 0
  let sy = 0
  const add = (x: number, y: number) => {
    minX = Math.min(minX, x)
    maxX = Math.max(maxX, x)
    minY = Math.min(minY, y)
    maxY = Math.max(maxY, y)
  }
  commands.forEach(({ cmd, args }, idx) => {
    const rel = cmd !== cmd.toUpperCase() && !(idx === 0 && cmd === "m")
    const ox = rel ? cx : 0
    const oy = rel ? cy : 0
    switch (cmd.toUpperCase()) {
      case "M":
        cx = ox + args[0]; cy = oy + args[1]; sx = cx; sy = cy; add(cx, cy); break
      case "L":
      case "T":
        cx = ox + args[0]; cy = oy + args[1]; add(cx, cy); break
      case "H":
        cx = ox + args[0]; add(cx, cy); break
      case "V":
        cy = oy + args[0]; add(cx, cy); break
      case "C":
        add(ox + args[0], oy + args[1]); add(ox + args[2], oy + args[3])
        cx = ox + args[4]; cy = oy + args[5]; add(cx, cy); break
      case "S":
      case "Q":
        add(ox + args[0], oy + args[1])
        cx = ox + args[2]; cy = oy + args[3]; add(cx, cy); break
      case "A":
        cx = ox + args[5]; cy = oy + args[6]; add(cx, cy); break
      case "Z":
        cx = sx; cy = sy; break
    }
  })
  if (!Number.isFinite(minX)) return null
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
}

const fmt = (n: number) => String(Math.round(n * 100) / 100)

/**
 * Shift every ABSOLUTE coordinate by (dx, dy). Relative commands are unchanged because they are already
 * offsets from the (shifted) current point; the very first moveto is always absolute, even when written "m".
 */
export function translatePathCommands(commands: PathCommand[], dx: number, dy: number): string {
  return commands
    .map(({ cmd, args }, idx) => {
      const absolute = cmd === cmd.toUpperCase() || (idx === 0 && cmd === "m")
      const a = [...args]
      if (absolute) {
        switch (cmd.toUpperCase()) {
          case "M": case "L": case "T": case "C": case "S": case "Q":
            for (let k = 0; k + 1 < a.length; k += 2) { a[k] += dx; a[k + 1] += dy }
            break
          case "H": a[0] += dx; break
          case "V": a[0] += dy; break
          case "A": a[5] += dx; a[6] += dy; break
        }
      }
      return a.length ? `${cmd} ${a.map(fmt).join(" ")}` : cmd
    })
    .join(" ")
}

export interface PathIntent {
  /** `d` to store on the element: re-based to local (0, 0) when parseable, otherwise the AI's original string. */
  pathData: string
  /** Where the AI's drawing sits on the board (its drawn region). */
  box: Box
  /** True when `pathData` was parsed and re-based, so `box.w/h` are the real drawn extents. */
  parsed: boolean
  /** True when the AI placed it somewhere meaningful (see isMeaningfulBox). */
  anchored: boolean
}

/**
 * Resolve a draw_path call to its drawn region. The AI's x / y (default 0) are the translate applied by the
 * renderer, so the drawn region is the path's local bounds shifted by them. Returns null when there is no
 * usable `pathData` at all (nothing could be drawn).
 */
export function resolvePathIntent(args: Record<string, unknown>): PathIntent | null {
  const raw = args.pathData
  if (typeof raw !== "string" || raw.trim() === "") return null
  const ox = finiteNumber(args.x) ?? 0
  const oy = finiteNumber(args.y) ?? 0

  const commands = parsePathData(raw)
  const bounds = commands ? getPathBounds(commands) : null
  if (commands && bounds) {
    const box: Box = { x: ox + bounds.x, y: oy + bounds.y, w: Math.max(1, bounds.w), h: Math.max(1, bounds.h) }
    return {
      pathData: translatePathCommands(commands, -bounds.x, -bounds.y),
      box,
      parsed: true,
      anchored: isMeaningfulBox(box),
    }
  }
  // Unparseable: keep the string untouched (so it still renders as the AI wrote it) and trust the declared size.
  const w = finiteNumber(args.width)
  const h = finiteNumber(args.height)
  const box: Box = { x: ox, y: oy, w: w && w > 0 ? w : 300, h: h && h > 0 ? h : 200 }
  return { pathData: raw, box, parsed: false, anchored: isMeaningfulBox(box) }
}
