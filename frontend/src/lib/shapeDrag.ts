/**
 * Geometry of a shape being dragged out with the pointer. The live preview and the committed element MUST be
 * computed by the same function, otherwise the shape "jumps" on release. (Before this module the circle
 * preview was an ellipse filling the drag box while the committed circle used the drag DIAGONAL as its
 * diameter, and the ellipse tool previewed a rectangle.)
 */
export type Pt = readonly [number, number]
export interface DragBox { x: number; y: number; w: number; h: number }

/** Axis-aligned box spanned by the two drag points, whatever direction the drag went. */
export function dragBox(a: Pt, b: Pt): DragBox {
  return { x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]), w: Math.abs(b[0] - a[0]), h: Math.abs(b[1] - a[1]) }
}

/**
 * The circle inscribed in the drag box: diameter = the shorter side, anchored at the corner where the drag
 * started and growing toward the pointer, so it never extends beyond what the user dragged.
 */
export function circleFromDrag(a: Pt, b: Pt): DragBox {
  const size = Math.round(Math.min(Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1])))
  return { x: b[0] >= a[0] ? a[0] : a[0] - size, y: b[1] >= a[1] ? a[1] : a[1] - size, w: size, h: size }
}

/** Smallest drag that creates a rectangle / ellipse / triangle: a clear drag, but a thin bar is allowed. */
export const MIN_SHAPE_LONG_SIDE = 30
export const MIN_SHAPE_SHORT_SIDE = 8
/** Smallest circle diameter. */
export const MIN_CIRCLE_SIZE = 24

export const isDrawableBox = (w: number, h: number): boolean =>
  Math.max(w, h) >= MIN_SHAPE_LONG_SIDE && Math.min(w, h) >= MIN_SHAPE_SHORT_SIDE
