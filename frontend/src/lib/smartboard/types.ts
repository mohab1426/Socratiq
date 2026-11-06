/**
 * Shared types for the Excalidraw-based SmartBoard.
 *
 * `SceneEl` is a STRUCTURAL subset of Excalidraw's `ExcalidrawElement`. The geometry, placement and layout code only depends on this
 * subset, so it can be unit-tested with plain objects, and real Excalidraw elements are assignable to it without casts.
 */
export type Author = "student" | "ai" | "coach"

export type Pt = readonly [number, number]

export interface SceneEl {
  id: string
  type: string
  x: number
  y: number
  width: number
  height: number
  angle?: number
  isDeleted?: boolean
  groupIds?: readonly string[]
  points?: readonly Pt[]
  strokeWidth?: number
  backgroundColor?: string
  containerId?: string | null
  boundElements?: readonly { id: string; type: string }[] | null
  customData?: Record<string, unknown>
  text?: string
  version?: number
  updated?: number
  fileId?: string | null
  polygon?: boolean
  index?: string | null
}

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/** Key under `element.customData` that holds SocratiQ's own metadata (Excalidraw reserves `customData` for app use). */
export const SOCRATIQ_KEY = "socratiq"

/** Scene coordinates are bounded so that numeric overflow or a runaway layout can never produce an unusable canvas. */
export const MAX_SCENE_COORD = 200_000
