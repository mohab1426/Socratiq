/**
 * Interaction Understanding & Freehand Selection Recognition for SocratiQ SmartBoard.
 *
 * Real-time detection and semantic interpretation of student board interactions:
 * - Freehand circles, loops, underlines, cross-outs, and pointers
 * - MCQ option selection recognition across separate elements and multiline text blocks
 * - Support for vertical, horizontal, and grid option arrangements
 * - Ambiguity detection with automated clarification prompts
 * - Interaction tracking with undo/redo reversal and element move synchronization
 */

import {
  type Board,
  type Stroke,
  type ElementKind,
} from "./whiteboard"
import { type RectBox, getElementBoundingBox } from "./boardLayoutEngine"

export type InteractionType =
  | "circle"
  | "underline"
  | "cross_out"
  | "point_to"
  | "freehand_write"
  | "unknown"

export interface SelectionTarget {
  elementId: string
  kind: ElementKind
  text?: string
  latex?: string
  lineIndex?: number
  lineText?: string
  mcqOption?: string // e.g. "A", "B", "C", "D"
  mcqText?: string // e.g. "ReLU"
  boundingBox: RectBox
  containmentScore: number // 0 to 1
}

export interface StrokeInteraction {
  id: string
  stroke?: Stroke
  type: InteractionType
  target?: SelectionTarget
  isAmbiguous: boolean
  competingTargets?: SelectionTarget[]
  clarificationPrompt?: string
  confidence: number
  summary: string
  timestamp: number
  isReversed?: boolean
}

export interface MCQOptionCandidate {
  option: string // e.g. "A", "B"
  text: string // e.g. "ReLU"
  box: RectBox
  elementId: string
  lineIndex?: number
  isMultiline: boolean
}

/**
 * Computes axis-aligned bounding box of a freehand stroke.
 */
export function computeStrokeBoundingBox(stroke: Pick<Stroke, "pts">): RectBox {
  const pts = stroke.pts
  if (!pts || pts.length === 0) {
    return { x: 0, y: 0, w: 0, h: 0 }
  }

  let minX = pts[0][0]
  let maxX = pts[0][0]
  let minY = pts[0][1]
  let maxY = pts[0][1]

  for (let i = 1; i < pts.length; i++) {
    const [x, y] = pts[i]
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }

  return {
    x: Math.round(minX),
    y: Math.round(minY),
    w: Math.max(1, Math.round(maxX - minX)),
    h: Math.max(1, Math.round(maxY - minY)),
  }
}

/**
 * Checks if a stroke forms a closed loop or circle.
 * Evaluates endpoint proximity relative to perimeter / bounding box,
 * aspect ratio, and winding or path extent.
 */
export function isStrokeClosedOrLoop(stroke: Stroke): { isLoop: boolean; confidence: number } {
  const pts = stroke.pts
  if (!pts || pts.length < 5) {
    return { isLoop: false, confidence: 0 }
  }

  const box = computeStrokeBoundingBox(stroke)
  const maxDim = Math.max(box.w, box.h)
  const minDim = Math.min(box.w, box.h)

  // A circle/ellipse must have a 2D presence (not a thin straight line)
  if (minDim < 14 || maxDim < 18) {
    return { isLoop: false, confidence: 0 }
  }

  const aspect = minDim / maxDim
  // If extremely elongated (aspect < 0.22), it's probably a scratch line or underline
  if (aspect < 0.22) {
    return { isLoop: false, confidence: 0.1 }
  }

  const start = pts[0]
  const end = pts[pts.length - 1]
  const closingDist = Math.hypot(end[0] - start[0], end[1] - start[1])

  // Normal gap threshold: endpoints close within 38% of max dimension or 48px
  const threshold = Math.max(48, maxDim * 0.38)
  const isDirectlyClosed = closingDist <= threshold

  // Also check if any point near the end is close to start (e.g. spiral or overlap)
  let minTailDist = closingDist
  const tailStart = Math.max(Math.floor(pts.length * 0.75), pts.length - 12)
  for (let i = tailStart; i < pts.length; i++) {
    const d = Math.hypot(pts[i][0] - start[0], pts[i][1] - start[1])
    if (d < minTailDist) minTailDist = d
  }
  const isTailClosed = minTailDist <= threshold

  if (!isDirectlyClosed && !isTailClosed) {
    return { isLoop: false, confidence: 0.1 }
  }

  // Calculate rough centroid and check that points surround it
  let sumX = 0
  let sumY = 0
  for (const [x, y] of pts) {
    sumX += x
    sumY += y
  }
  const cx = sumX / pts.length
  const cy = sumY / pts.length

  let hasLeft = false
  let hasRight = false
  let hasTop = false
  let hasBottom = false

  for (const [x, y] of pts) {
    if (x < cx - box.w * 0.12) hasLeft = true
    if (x > cx + box.w * 0.12) hasRight = true
    if (y < cy - box.h * 0.12) hasTop = true
    if (y > cy + box.h * 0.12) hasBottom = true
  }

  const surroundsCentroid = hasLeft && hasRight && hasTop && hasBottom

  if (surroundsCentroid) {
    const ratioScore = Math.min(1, Math.max(0.4, aspect * 1.1))
    const closureScore = Math.max(0.4, 1 - minTailDist / threshold)
    const confidence = Math.min(0.98, Math.round((ratioScore * 0.5 + closureScore * 0.5) * 100) / 100)
    return { isLoop: true, confidence }
  }

  // If endpoints are very close even if slightly uneven
  if (minTailDist <= 25 && aspect >= 0.35) {
    return { isLoop: true, confidence: 0.72 }
  }

  return { isLoop: false, confidence: 0.2 }
}

/**
 * Checks if a stroke represents an underline.
 * An underline is predominantly horizontal, relatively flat, and drawn left-to-right or right-to-left.
 */
export function isStrokeUnderline(stroke: Stroke): { isUnderline: boolean; confidence: number } {
  const pts = stroke.pts
  if (!pts || pts.length < 3) return { isUnderline: false, confidence: 0 }

  const box = computeStrokeBoundingBox(stroke)
  // Must have decent width and small height
  if (box.w < 24) return { isUnderline: false, confidence: 0 }

  const aspect = box.w / Math.max(1, box.h)
  if (aspect < 2.0) return { isUnderline: false, confidence: 0 }

  // Check endpoint horizontal spread
  const start = pts[0]
  const end = pts[pts.length - 1]
  const dx = Math.abs(end[0] - start[0])
  const dy = Math.abs(end[1] - start[1])

  if (dx < box.w * 0.65 || dy > dx * 0.4) {
    return { isUnderline: false, confidence: 0.1 }
  }

  const confidence = Math.min(0.95, Math.round((aspect / 5) * 100) / 100)
  return { isUnderline: true, confidence: Math.max(0.6, confidence) }
}

/**
 * Checks if a stroke represents a cross-out gesture on targetBox.
 */
export function isStrokeCrossOut(stroke: Stroke, targetBox: RectBox): { isCrossOut: boolean; confidence: number } {
  const pts = stroke.pts
  if (!pts || pts.length < 3) return { isCrossOut: false, confidence: 0 }

  const box = computeStrokeBoundingBox(stroke)
  if (box.w < 20 || box.h < 1) return { isCrossOut: false, confidence: 0 }

  // Check intersection with target box
  const intersects = !(
    box.x + box.w < targetBox.x ||
    targetBox.x + targetBox.w < box.x ||
    box.y + box.h < targetBox.y ||
    targetBox.y + targetBox.h < box.y
  )

  if (!intersects) return { isCrossOut: false, confidence: 0 }

  const targetCenterY = targetBox.y + targetBox.h / 2
  const strokeCenterY = box.y + box.h / 2

  // Stroke intersects vertically across the middle 65% of target
  const yOffset = Math.abs(strokeCenterY - targetCenterY)
  if (yOffset <= targetBox.h * 0.35 && box.w >= Math.min(60, targetBox.w * 0.35)) {
    return { isCrossOut: true, confidence: 0.88 }
  }

  return { isCrossOut: false, confidence: 0.2 }
}

/**
 * Calculates containment and overlap score (0 to 1) of targetBox by strokeBox.
 * Robust against wide text targets where a student circles an option badge or phrase.
 */
export function calculateBoxContainment(strokeBox: RectBox, targetBox: RectBox): number {
  const overlapX = Math.max(
    0,
    Math.min(strokeBox.x + strokeBox.w, targetBox.x + targetBox.w) -
      Math.max(strokeBox.x, targetBox.x)
  )
  const overlapY = Math.max(
    0,
    Math.min(strokeBox.y + strokeBox.h, targetBox.y + targetBox.h) -
      Math.max(strokeBox.y, targetBox.y)
  )

  if (overlapX === 0 || overlapY === 0) return 0

  const overlapArea = overlapX * overlapY
  const strokeArea = Math.max(1, strokeBox.w * strokeBox.h)

  // Vertical coverage: how much of the target height is covered
  const verticalCoverage = overlapY / Math.max(1, targetBox.h)
  // Horizontal coverage: relative to the stroke width or target width
  const strokeHorizontalCoverage = overlapX / Math.max(1, strokeBox.w)
  const strokeCoverageInTarget = overlapArea / strokeArea

  // Strict center check: is target center strictly inside stroke box?
  const targetCenterX = targetBox.x + targetBox.w / 2
  const targetCenterY = targetBox.y + targetBox.h / 2
  const isStrictCenterInside =
    targetCenterX >= strokeBox.x &&
    targetCenterX <= strokeBox.x + strokeBox.w &&
    targetCenterY >= strokeBox.y &&
    targetCenterY <= strokeBox.y + strokeBox.h

  // If vertical coverage is negligible (< 35%), the stroke barely brushed the top/bottom edge
  if (verticalCoverage < 0.35) {
    return 0
  }

  let score = 0
  if (isStrictCenterInside) {
    score = 0.5 + verticalCoverage * 0.3 + strokeHorizontalCoverage * 0.2
  } else {
    // Student circled the option text or badge
    score = verticalCoverage * 0.5 + strokeCoverageInTarget * 0.4 + strokeHorizontalCoverage * 0.1
  }

  // Penalize if stroke box is gigantic (e.g. circled entire board)
  const targetArea = Math.max(1, targetBox.w * targetBox.h)
  if (strokeArea > targetArea * 15) {
    score *= 0.4
  }

  return Math.min(1, Math.round(score * 100) / 100)
}

/**
 * Pattern regexes for matching MCQ options in text.
 * Matches:
 * "A. Softmax", "A) ReLU", "A: Sigmoid", "1. Matrix", "[B] Option", "(C) Adam", "Option B: ReLU"
 */
const MCQ_LINE_REGEX = /^\s*(?:Option\s+)?([A-Ea-e1-5])[.)\]:\-]\s*(.*)$/i
const STANDALONE_OPTION_REGEX = /^(?:Option\s+)?([A-Ea-e1-5])[.)\]:\-]?$/i

/**
 * Detects all MCQ options on the board.
 * Supports:
 * 1. Multiline text blocks (where questions & options are lines inside a single element)
 * 2. Separate text elements (where each option or letter is a distinct element)
 */
export function detectMCQOptions(board: Board): MCQOptionCandidate[] {
  const candidates: MCQOptionCandidate[] = []

  for (const el of board.elements) {
    if (el.kind !== "text" || !el.text) continue

    const text = el.text.trim()
    const lines = el.text.split("\n")

    // Check if multiline text element contains MCQ options
    if (lines.length > 1) {
      const fontSize = el.fontSize || 24
      const lineHeight = Math.round(fontSize * 1.35 + 8)
      const elementBox = getElementBoundingBox(el)

      let foundAnyInElement = false
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim()
        const match = line.match(MCQ_LINE_REGEX)
        if (match) {
          foundAnyInElement = true
          const option = match[1].toUpperCase()
          const optText = match[2].trim()

          const lineY = elementBox.y + 8 + i * lineHeight
          // Use estimated natural text width instead of whole element box width
          const charWidth = fontSize * 0.58
          const estimatedTextW = Math.min(elementBox.w, Math.round(line.length * charWidth + 40))

          const lineBox: RectBox = {
            x: elementBox.x,
            y: lineY,
            w: Math.max(140, estimatedTextW),
            h: Math.max(32, lineHeight),
          }

          candidates.push({
            option,
            text: optText || `Option ${option}`,
            box: lineBox,
            elementId: el.id,
            lineIndex: i,
            isMultiline: true,
          })
        }
      }

      if (foundAnyInElement) continue
    }

    // Check if individual element represents an MCQ option
    const matchLine = text.match(MCQ_LINE_REGEX)
    if (matchLine) {
      candidates.push({
        option: matchLine[1].toUpperCase(),
        text: matchLine[2].trim() || `Option ${matchLine[1].toUpperCase()}`,
        box: getElementBoundingBox(el),
        elementId: el.id,
        isMultiline: false,
      })
      continue
    }

    const matchStandalone = text.match(STANDALONE_OPTION_REGEX)
    if (matchStandalone) {
      candidates.push({
        option: matchStandalone[1].toUpperCase(),
        text: `Option ${matchStandalone[1].toUpperCase()}`,
        box: getElementBoundingBox(el),
        elementId: el.id,
        isMultiline: false,
      })
    }
  }

  return candidates
}

/**
 * Interprets a student freehand stroke against the current board state.
 * Recognizes circling, underlining, crossing out, and selection ambiguity.
 */
export function interpretStrokeInteraction(
  stroke: Stroke,
  board: Board
): StrokeInteraction {
  const timestamp = Date.now()
  const strokeId = "int_" + timestamp.toString(36) + Math.random().toString(36).slice(2, 6)

  // Eraser strokes don't count as content selection
  if (stroke.t === "e") {
    return {
      id: strokeId,
      stroke,
      type: "unknown",
      isAmbiguous: false,
      confidence: 1,
      summary: "Student used eraser tool on board",
      timestamp,
    }
  }

  const strokeBox = computeStrokeBoundingBox(stroke)
  const loopCheck = isStrokeClosedOrLoop(stroke)

  // 1. Check if the stroke is a circle/loop
  if (loopCheck.isLoop) {
    // First, check MCQ options on board
    const mcqOptions = detectMCQOptions(board)

    if (mcqOptions.length > 0) {
      // Score containment against all MCQ options
      const scored = mcqOptions
        .map((opt) => ({
          opt,
          score: calculateBoxContainment(strokeBox, opt.box),
        }))
        .filter((item) => item.score >= 0.25)
        .sort((a, b) => b.score - a.score)

      if (scored.length > 0) {
        const top = scored[0]

        // Check for ambiguity: if top two options both have significant scores and close difference
        if (
          scored.length >= 2 &&
          scored[1].score >= 0.35 &&
          top.score - scored[1].score < 0.2
        ) {
          const opt1 = top.opt
          const opt2 = scored[1].opt

          const competingTargets: SelectionTarget[] = [
            {
              elementId: opt1.elementId,
              kind: "text",
              lineIndex: opt1.lineIndex,
              lineText: opt1.text,
              mcqOption: opt1.option,
              mcqText: opt1.text,
              boundingBox: opt1.box,
              containmentScore: top.score,
            },
            {
              elementId: opt2.elementId,
              kind: "text",
              lineIndex: opt2.lineIndex,
              lineText: opt2.text,
              mcqOption: opt2.option,
              mcqText: opt2.text,
              boundingBox: opt2.box,
              containmentScore: scored[1].score,
            },
          ]

          return {
            id: strokeId,
            stroke,
            type: "circle",
            isAmbiguous: true,
            competingTargets,
            clarificationPrompt: `Did you mean option ${opt1.option} (${opt1.text}) or option ${opt2.option} (${opt2.text})?`,
            confidence: 0.5,
            summary: `Student circled between Option ${opt1.option} and Option ${opt2.option} (Ambiguous)`,
            timestamp,
          }
        }

        // Unambiguous selection of top option
        if (top.score >= 0.3) {
          const target: SelectionTarget = {
            elementId: top.opt.elementId,
            kind: "text",
            lineIndex: top.opt.lineIndex,
            lineText: top.opt.text,
            mcqOption: top.opt.option,
            mcqText: top.opt.text,
            boundingBox: top.opt.box,
            containmentScore: top.score,
          }

          const optLabel = top.opt.text
            ? `Option ${top.opt.option} (${top.opt.text})`
            : `Option ${top.opt.option}`

          return {
            id: strokeId,
            stroke,
            type: "circle",
            target,
            isAmbiguous: false,
            confidence: Math.min(0.98, top.score + 0.15),
            summary: `Student circled ${optLabel}`,
            timestamp,
          }
        }
      }
    }

    // If not an MCQ option, check regular elements (equations, shapes, text, etc.)
    const elementScores = board.elements
      .map((el) => {
        const box = getElementBoundingBox(el)
        const score = calculateBoxContainment(strokeBox, box)
        return { el, box, score }
      })
      .filter((item) => item.score >= 0.3)
      .sort((a, b) => b.score - a.score)

    if (elementScores.length > 0) {
      const top = elementScores[0]
      const el = top.el
      let desc = el.kind.toUpperCase()
      if (el.kind === "equation" && el.latex) {
        desc = `equation "${el.latex}"`
      } else if (el.kind === "text" && el.text) {
        const snippet = el.text.split("\n")[0].slice(0, 35)
        desc = `text "${snippet}"`
      } else if (el.kind === "shape" || el.kind === "circle") {
        desc = `${el.shape || el.kind} shape`
      }

      return {
        id: strokeId,
        stroke,
        type: "circle",
        target: {
          elementId: el.id,
          kind: el.kind,
          text: el.text,
          latex: el.latex,
          boundingBox: top.box,
          containmentScore: top.score,
        },
        isAmbiguous: false,
        confidence: top.score,
        summary: `Student circled ${desc}`,
        timestamp,
      }
    }

    // Arbitrary freehand circle in empty space
    return {
      id: strokeId,
      stroke,
      type: "circle",
      isAmbiguous: false,
      confidence: loopCheck.confidence,
      summary: `Student drew a circle at (${strokeBox.x}, ${strokeBox.y})`,
      timestamp,
    }
  }

  // 2. Check cross-out on any element first (before underline, since cross-out slices through element body)
  for (const el of board.elements) {
    const box = getElementBoundingBox(el)
    const crossCheck = isStrokeCrossOut(stroke, box)
    if (crossCheck.isCrossOut) {
      const snippet = (el.text || el.latex || el.kind).slice(0, 30)
      return {
        id: strokeId,
        stroke,
        type: "cross_out",
        target: {
          elementId: el.id,
          kind: el.kind,
          text: el.text,
          latex: el.latex,
          boundingBox: box,
          containmentScore: crossCheck.confidence,
        },
        isAmbiguous: false,
        confidence: crossCheck.confidence,
        summary: `Student crossed out "${snippet}"`,
        timestamp,
      }
    }
  }

  // 3. Check underline
  const underlineCheck = isStrokeUnderline(stroke)
  if (underlineCheck.isUnderline) {
    // Find text element situated directly above stroke
    for (const el of board.elements) {
      if (el.kind !== "text" && el.kind !== "equation") continue
      const box = getElementBoundingBox(el)

      const xOverlap = Math.max(
        0,
        Math.min(strokeBox.x + strokeBox.w, box.x + box.w) - Math.max(strokeBox.x, box.x)
      )
      // Underline must be situated near or below the bottom edge of element
      const isUnder =
        strokeBox.y >= box.y + box.h * 0.7 &&
        strokeBox.y <= box.y + box.h + 35 &&
        xOverlap > Math.min(strokeBox.w, box.w) * 0.35

      if (isUnder) {
        const snippet = (el.text || el.latex || "").slice(0, 40)
        return {
          id: strokeId,
          stroke,
          type: "underline",
          target: {
            elementId: el.id,
            kind: el.kind,
            text: el.text,
            latex: el.latex,
            boundingBox: box,
            containmentScore: 0.8,
          },
          isAmbiguous: false,
          confidence: underlineCheck.confidence,
          summary: `Student underlined "${snippet}"`,
          timestamp,
        }
      }
    }

    // Underline stroke not attached to any text element
    return {
      id: strokeId,
      stroke,
      type: "underline",
      isAmbiguous: false,
      confidence: underlineCheck.confidence,
      summary: `Student drew an underline at (${strokeBox.x}, ${strokeBox.y})`,
      timestamp,
    }
  }

  // Default freehand annotation
  return {
    id: strokeId,
    stroke,
    type: "freehand_write",
    isAmbiguous: false,
    confidence: 0.6,
    summary: `Student added freehand stroke at (${strokeBox.x}, ${strokeBox.y})`,
    timestamp,
  }
}

/**
 * Real-time Interaction Tracker with bounded in-memory history.
 * Handles undo/redo reversal, element movement updates, and live summaries.
 */
export class BoardInteractionTracker {
  private history: StrokeInteraction[] = []
  private undoStack: StrokeInteraction[] = []
  private maxHistory = 20

  constructor(maxHistory = 20) {
    this.maxHistory = maxHistory
  }

  /**
   * Processes and records a newly completed stroke.
   */
  public recordStroke(stroke: Stroke, board: Board): StrokeInteraction {
    const interaction = interpretStrokeInteraction(stroke, board)
    this.history.push(interaction)
    if (this.history.length > this.maxHistory) {
      this.history.shift()
    }
    // New action clears redo stack
    this.undoStack = []
    return interaction
  }

  /**
   * Records an undo action, marking the most recent interaction as reversed.
   */
  public recordUndo(): StrokeInteraction | null {
    if (this.history.length === 0) return null
    const last = this.history.pop()!
    last.isReversed = true
    this.undoStack.push(last)
    return last
  }

  /**
   * Records a redo action, restoring the previously reversed interaction.
   */
  public recordRedo(): StrokeInteraction | null {
    if (this.undoStack.length === 0) return null
    const restored = this.undoStack.pop()!
    restored.isReversed = false
    this.history.push(restored)
    return restored
  }

  /**
   * Updates coordinates of targets when an element is moved, avoiding stale coordinates.
   */
  public recordElementMoved(elementId: string, newBox: RectBox): void {
    for (const item of this.history) {
      if (item.target && item.target.elementId === elementId) {
        item.target.boundingBox = { ...newBox }
      }
      if (item.competingTargets) {
        for (const ct of item.competingTargets) {
          if (ct.elementId === elementId) {
            ct.boundingBox = { ...newBox }
          }
        }
      }
    }
  }

  /**
   * Retrieves active, non-reversed recent interactions.
   */
  public getRecentInteractions(count = 5): StrokeInteraction[] {
    return this.history
      .filter((i) => !i.isReversed)
      .slice(-count)
  }

  /**
   * Retrieves the most recent unambiguous selection target.
   */
  public getLatestSelection(): SelectionTarget | null {
    for (let i = this.history.length - 1; i >= 0; i--) {
      const item = this.history[i]
      if (!item.isReversed && !item.isAmbiguous && item.target) {
        return item.target
      }
    }
    return null
  }

  /**
   * Generates a concise summary string for AI prompts / Live updates.
   */
  public getRealtimeSummary(): string {
    const active = this.history.filter((i) => !i.isReversed).slice(-3)
    if (active.length === 0) return "No recent student interactions."
    return active.map((a) => a.summary).join("; ")
  }

  /**
   * Clears the tracker history.
   */
  public clear(): void {
    this.history = []
    this.undoStack = []
  }
}
