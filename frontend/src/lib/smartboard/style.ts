import type { PaletteName } from "./diagramSpec"

/** SocratiQ-flavoured, readable on light and dark (Excalidraw inverts colours for its dark theme). */
export const COLORS: Record<PaletteName, { stroke: string; fill: string }> = {
  ink: { stroke: "#1e293b", fill: "#f8fafc" },
  teal: { stroke: "#0f766e", fill: "#ccfbf1" },
  sky: { stroke: "#0369a1", fill: "#e0f2fe" },
  amber: { stroke: "#b45309", fill: "#fef3c7" },
  rose: { stroke: "#be123c", fill: "#ffe4e6" },
  violet: { stroke: "#6d28d9", fill: "#ede9fe" },
  green: { stroke: "#15803d", fill: "#dcfce7" },
  slate: { stroke: "#475569", fill: "#f1f5f9" },
}
export const INK = "#1e293b"
export const FONT = { title: 28, node: 20, label: 16, note: 16, min: 14 } as const
/** Conservative average glyph width in em. Real fonts are narrower for Latin and similar for Arabic; being wide only makes boxes roomier. */
export const CHAR_W = 0.62
export const LINE_H = 1.3
