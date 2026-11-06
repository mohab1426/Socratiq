import { type Board, BOARD_W, BOARD_H } from "./whiteboard"
import {
  BOARD_PADDING,
  computeUnobstructedVisibleViewport,
  findCollisionFreePosition,
  doBoxesIntersect,
  getElementBoundingBox,
  getOccupiedBoxes,
  hasBoxCollision,
  isPlacementVisible,
  type ContainerDimensions,
  type UiOcclusion,
} from "./boardLayoutEngine"

export interface ViewportRect {
  x: number
  y: number
  w: number
  h: number
}

/**
 * Calculates the current visible bounding box on the board stage given the canvas viewport size and viewState.
 */
export function getVisibleViewport(
  viewState: { x: number; y: number; scale: number },
  canvasWidth = 1000,
  canvasHeight = 700
): ViewportRect {
  const vp = computeUnobstructedVisibleViewport(viewState, { width: canvasWidth, height: canvasHeight })
  return vp.unobstructedVisibleRect
}

/**
 * Checks whether two rectangular bounding boxes overlap with an optional buffer.
 */
export function boxesIntersect(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
  buffer = 16
): boolean {
  return doBoxesIntersect(a, b, buffer)
}

/**
 * Calculates a smart, collision-free position for inserting new content.
 *
 * Collision and visibility use the layout engine's own definitions (rotation/line-aware element
 * bounds, freehand ink, UI occlusion) so this path agrees with AI-generated placement.
 */
export function getSmartPlacement(
  board: Board,
  viewState: { x: number; y: number; scale: number },
  itemW = 320,
  itemH = 200,
  selectedId: string | null = null,
  canvasWidth = 1000,
  canvasHeight = 700,
  occlusion?: UiOcclusion
): { x: number; y: number } {
  const container: ContainerDimensions = { width: canvasWidth, height: canvasHeight }
  const occupied = getOccupiedBoxes(board)

  // 1. Contextual placement next to the selected element, but only if that spot is free AND visible.
  if (selectedId) {
    const sel = board.elements.find((e) => e.id === selectedId)
    if (sel) {
      const sb = getElementBoundingBox(sel)
      const candidates = [
        { x: sb.x + sb.w + 24, y: sb.y }, // to the right
        { x: sb.x, y: sb.y + sb.h + 24 }, // below
      ]
      for (const c of candidates) {
        const box = { x: Math.round(c.x), y: Math.round(c.y), w: itemW, h: itemH }
        const inBoard =
          box.x >= BOARD_PADDING && box.y >= BOARD_PADDING &&
          box.x + itemW <= BOARD_W - BOARD_PADDING && box.y + itemH <= BOARD_H - BOARD_PADDING
        if (
          inBoard &&
          !hasBoxCollision(box, occupied, 20) &&
          isPlacementVisible(box, viewState, container, occlusion)
        ) {
          return { x: box.x, y: box.y }
        }
      }
    }
  }

  // 2. Delegate to the adaptive layout engine (visible viewport first, then nearby free space).
  return findCollisionFreePosition(board, itemW, itemH, undefined, [], viewState, 20, container, occlusion)
}
