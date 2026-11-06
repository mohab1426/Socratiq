import { describe, it, expect, beforeEach } from "vitest"
import {
  computeStrokeBoundingBox,
  isStrokeClosedOrLoop,
  isStrokeUnderline,
  isStrokeCrossOut,
  calculateBoxContainment,
  detectMCQOptions,
  interpretStrokeInteraction,
  BoardInteractionTracker,
} from "./interactionUnderstanding"
import { type Board, type Stroke, EMPTY_BOARD } from "./whiteboard"

describe("Interaction Understanding & Freehand Selection Recognition", () => {
  let mockBoard: Board

  beforeEach(() => {
    mockBoard = {
      ...EMPTY_BOARD,
      elements: [],
      strokes: [],
    }
  })

  // Helper to generate circular points
  function generateCirclePoints(cx: number, cy: number, r: number, points = 24, closeGap = 5): [number, number][] {
    const pts: [number, number][] = []
    const count = points
    for (let i = 0; i < count; i++) {
      const angle = (i / count) * 2 * Math.PI
      const jitter = (i % 2 === 0 ? 2 : -2)
      pts.push([
        Math.round(cx + (r + jitter) * Math.cos(angle)),
        Math.round(cy + (r + jitter) * Math.sin(angle)),
      ])
    }
    // Add point close to start to close the loop
    pts.push([pts[0][0] + closeGap, pts[0][1] + closeGap])
    return pts
  }

  // Helper to generate horizontal line points
  function generateLinePoints(x1: number, y1: number, x2: number, y2: number, steps = 10): [number, number][] {
    const pts: [number, number][] = []
    for (let i = 0; i <= steps; i++) {
      const t = i / steps
      pts.push([Math.round(x1 + t * (x2 - x1)), Math.round(y1 + t * (y2 - y1))])
    }
    return pts
  }

  it("1. recognizes circling Option B in a vertical MCQ", () => {
    mockBoard.elements = [
      { id: "q1", kind: "text", author: "coach", seq: 1, x: 100, y: 100, w: 400, h: 40, text: "Which activation function is most used?" },
      { id: "opt_a", kind: "text", author: "coach", seq: 2, x: 100, y: 160, w: 250, h: 36, text: "A. Sigmoid" },
      { id: "opt_b", kind: "text", author: "coach", seq: 3, x: 100, y: 220, w: 250, h: 36, text: "B. ReLU" },
      { id: "opt_c", kind: "text", author: "coach", seq: 4, x: 100, y: 280, w: 250, h: 36, text: "C. Tanh" },
    ]

    // Circle drawn around Option B (box: x:100, y:220, w:250, h:36, center: 225, 238)
    const pts = generateCirclePoints(225, 238, 50)
    const stroke: Stroke = { t: "p", w: 3, pts, color: "#ef4444" }

    const interaction = interpretStrokeInteraction(stroke, mockBoard)
    expect(interaction.type).toBe("circle")
    expect(interaction.isAmbiguous).toBe(false)
    expect(interaction.target).toBeDefined()
    expect(interaction.target?.mcqOption).toBe("B")
    expect(interaction.target?.mcqText).toBe("ReLU")
    expect(interaction.summary).toContain("Option B")
  })

  it("2. recognizes circling Option C in a horizontal MCQ", () => {
    mockBoard.elements = [
      { id: "q1", kind: "text", author: "coach", seq: 1, x: 100, y: 100, w: 600, h: 40, text: "Choose the learning rate:" },
      { id: "opt_a", kind: "text", author: "coach", seq: 2, x: 100, y: 180, w: 120, h: 36, text: "A) 0.1" },
      { id: "opt_b", kind: "text", author: "coach", seq: 3, x: 250, y: 180, w: 120, h: 36, text: "B) 0.01" },
      { id: "opt_c", kind: "text", author: "coach", seq: 4, x: 400, y: 180, w: 120, h: 36, text: "C) 0.001" },
    ]

    // Circle drawn around Option C (center: 460, 198)
    const pts = generateCirclePoints(460, 198, 45)
    const stroke: Stroke = { t: "p", w: 3, pts }

    const interaction = interpretStrokeInteraction(stroke, mockBoard)
    expect(interaction.type).toBe("circle")
    expect(interaction.isAmbiguous).toBe(false)
    expect(interaction.target?.mcqOption).toBe("C")
    expect(interaction.target?.mcqText).toBe("0.001")
  })

  it("3. recognizes rough and imperfect freehand circles", () => {
    // Imperfect circle with 16 points and uneven radii
    const pts: [number, number][] = [
      [200, 200], [240, 195], [280, 210], [305, 245],
      [310, 280], [290, 315], [250, 330], [210, 325],
      [180, 295], [175, 255], [185, 220], [208, 205],
    ]
    const stroke: Stroke = { t: "p", w: 3, pts }
    const result = isStrokeClosedOrLoop(stroke)
    expect(result.isLoop).toBe(true)
    expect(result.confidence).toBeGreaterThan(0.6)
  })

  it("4. handles ambiguous strokes overlapping two options with clarification prompt", () => {
    mockBoard.elements = [
      { id: "opt_b", kind: "text", author: "coach", seq: 1, x: 100, y: 200, w: 200, h: 40, text: "B. Momentum" },
      { id: "opt_c", kind: "text", author: "coach", seq: 2, x: 100, y: 250, w: 200, h: 40, text: "C. RMSprop" },
    ]

    // Circle drawn right on the boundary between B and C (y ~ 245, covering both)
    const pts = generateCirclePoints(200, 245, 48)
    const stroke: Stroke = { t: "p", w: 3, pts }

    const interaction = interpretStrokeInteraction(stroke, mockBoard)
    expect(interaction.isAmbiguous).toBe(true)
    expect(interaction.competingTargets?.length).toBe(2)
    expect(interaction.clarificationPrompt).toContain("Did you mean option")
    expect(interaction.summary).toContain("Ambiguous")
  })

  it("5. recognizes underlining a term in a paragraph or equation", () => {
    mockBoard.elements = [
      { id: "txt1", kind: "text", author: "coach", seq: 1, x: 150, y: 150, w: 300, h: 50, text: "Overfitting occurs when model memorizes training data." },
    ]

    // Underline directly beneath the text element (x: 150 to 440, y: 208)
    const pts = generateLinePoints(160, 208, 430, 210)
    const stroke: Stroke = { t: "p", w: 4, pts }

    const interaction = interpretStrokeInteraction(stroke, mockBoard)
    expect(interaction.type).toBe("underline")
    expect(interaction.target?.elementId).toBe("txt1")
    expect(interaction.summary).toContain("underlined")
  })

  it("6. recognizes crossing out an answer or element", () => {
    mockBoard.elements = [
      { id: "opt_wrong", kind: "text", author: "coach", seq: 1, x: 100, y: 200, w: 200, h: 40, text: "D. Random Guessing" },
    ]

    // Line cutting through the middle of the option (y: 220)
    const pts = generateLinePoints(90, 220, 310, 220)
    const stroke: Stroke = { t: "p", w: 3, pts }

    const interaction = interpretStrokeInteraction(stroke, mockBoard)
    expect(interaction.type).toBe("cross_out")
    expect(interaction.target?.elementId).toBe("opt_wrong")
    expect(interaction.summary).toContain("crossed out")
  })

  it("7. undoing a circle removes and reverses selection in tracker", () => {
    const tracker = new BoardInteractionTracker()
    mockBoard.elements = [
      { id: "opt_a", kind: "text", author: "coach", seq: 1, x: 100, y: 100, w: 200, h: 40, text: "A. Gradient Descent" },
    ]

    const pts = generateCirclePoints(200, 120, 45)
    const stroke: Stroke = { t: "p", w: 3, pts }

    tracker.recordStroke(stroke, mockBoard)
    expect(tracker.getLatestSelection()?.mcqOption).toBe("A")

    // Undo the stroke
    const undone = tracker.recordUndo()
    expect(undone).toBeDefined()
    expect(undone?.isReversed).toBe(true)
    expect(tracker.getLatestSelection()).toBeNull()

    // Redo restores it
    tracker.recordRedo()
    expect(tracker.getLatestSelection()?.mcqOption).toBe("A")
  })

  it("8. moving an option does not leave stale associations", () => {
    const tracker = new BoardInteractionTracker()
    mockBoard.elements = [
      { id: "opt_a", kind: "text", author: "coach", seq: 1, x: 100, y: 100, w: 200, h: 40, text: "A. Gradient Descent" },
    ]

    const pts = generateCirclePoints(200, 120, 45)
    const stroke: Stroke = { t: "p", w: 3, pts }

    tracker.recordStroke(stroke, mockBoard)
    expect(tracker.getLatestSelection()?.boundingBox.x).toBe(100)

    // Option moves to (300, 400)
    tracker.recordElementMoved("opt_a", { x: 300, y: 400, w: 200, h: 40 })
    expect(tracker.getLatestSelection()?.boundingBox.x).toBe(300)
    expect(tracker.getLatestSelection()?.boundingBox.y).toBe(400)
  })

  it("9. distinguishes newly drawn marks from existing shapes on board", () => {
    mockBoard.elements = [
      // Existing circle shape placed by coach
      { id: "shape_circ", kind: "circle", author: "coach", seq: 1, x: 500, y: 500, w: 100, h: 100 },
    ]

    // New student stroke elsewhere on board
    const pts = generateLinePoints(100, 100, 300, 100)
    const studentStroke: Stroke = { t: "p", w: 3, pts }

    const interaction = interpretStrokeInteraction(studentStroke, mockBoard)
    expect(interaction.type).toBe("underline")
    // Should NOT confuse stroke with the existing circle shape element
    expect(interaction.target?.elementId).not.toBe("shape_circ")
  })

  it("10. does not interpret arbitrary circle in empty space as MCQ selection", () => {
    mockBoard.elements = [
      { id: "opt_a", kind: "text", author: "coach", seq: 1, x: 100, y: 100, w: 200, h: 40, text: "A. Option A" },
    ]

    // Circle drawn in distant empty space (x: 1000, y: 800)
    const pts = generateCirclePoints(1000, 800, 50)
    const stroke: Stroke = { t: "p", w: 3, pts }

    const interaction = interpretStrokeInteraction(stroke, mockBoard)
    expect(interaction.type).toBe("circle")
    expect(interaction.target).toBeUndefined()
    expect(interaction.summary).toContain("drew a circle")
  })

  it("handles multiline text blocks containing MCQs correctly", () => {
    mockBoard.elements = [
      {
        id: "multi_mcq",
        kind: "text",
        author: "coach",
        seq: 1,
        x: 100,
        y: 100,
        w: 400,
        h: 200,
        fontSize: 24,
        text: "Question 1:\nA) Linear\nB) Non-linear\nC) Quadratic",
      },
    ]

    const options = detectMCQOptions(mockBoard)
    expect(options.length).toBe(3)
    expect(options[0].option).toBe("A")
    expect(options[1].option).toBe("B")
    expect(options[2].option).toBe("C")
    expect(options[1].isMultiline).toBe(true)

    // Option B line is around y: 100 + 8 + 2 * (24*1.35 + 8) = ~100 + 8 + 80 = 188
    const lineBBox = options[1].box
    const pts = generateCirclePoints(lineBBox.x + 80, lineBBox.y + 16, 30)
    const stroke: Stroke = { t: "p", w: 3, pts }

    const interaction = interpretStrokeInteraction(stroke, mockBoard)
    expect(interaction.type).toBe("circle")
    expect(interaction.target?.mcqOption).toBe("B")
    expect(interaction.target?.mcqText).toBe("Non-linear")
  })
})
