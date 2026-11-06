import { describe, expect, it } from "vitest"
import {
  DEFAULT_TOOL_SETTINGS,
  MIN_HIGHLIGHTER_WIDTH,
  applyExplicitColor,
  highlighterWidth,
  settingsFamily,
  updateToolSetting,
} from "@/lib/toolSettings"

describe("toolSettings", () => {
  it("defaults the highlighter to yellow, not the pen's black", () => {
    expect(DEFAULT_TOOL_SETTINGS.highlighter.color).toBe("#facc15")
    expect(DEFAULT_TOOL_SETTINGS.pen.color).toBe("#000000")
  })

  it("groups tools into independent pen / highlighter / eraser families and one shared shape family", () => {
    expect(settingsFamily("pen")).toBe("pen")
    expect(settingsFamily("highlighter")).toBe("highlighter")
    expect(settingsFamily("eraser")).toBe("eraser")
    for (const t of ["line", "arrow", "rect", "ellipse", "triangle", "text", "select"]) {
      expect(settingsFamily(t)).toBe("shape")
    }
  })

  it("keeps the pen colour when the highlighter colour changes and the user returns to the pen", () => {
    let s = updateToolSetting(DEFAULT_TOOL_SETTINGS, "pen", { color: "#2563eb" })
    s = updateToolSetting(s, "highlighter", { color: "#22c55e" })
    expect(s.pen.color).toBe("#2563eb")
    expect(s.highlighter.color).toBe("#22c55e")
  })

  it("keeps width independent per family", () => {
    const s = updateToolSetting(DEFAULT_TOOL_SETTINGS, "highlighter", { width: 8 })
    expect(s.highlighter.width).toBe(8)
    expect(s.pen.width).toBe(DEFAULT_TOOL_SETTINGS.pen.width)
  })

  it("does not let a line/shape width change the eraser size", () => {
    const s = updateToolSetting(DEFAULT_TOOL_SETTINGS, "line", { width: 8 })
    expect(s.shape.width).toBe(8)
    expect(s.eraser.width).toBe(DEFAULT_TOOL_SETTINGS.eraser.width)
  })

  it("returns the same object for a no-op update and never mutates its input", () => {
    expect(updateToolSetting(DEFAULT_TOOL_SETTINGS, "pen", { color: "#000000" })).toBe(DEFAULT_TOOL_SETTINGS)
    updateToolSetting(DEFAULT_TOOL_SETTINGS, "pen", { color: "#ef4444" })
    expect(DEFAULT_TOOL_SETTINGS.pen.color).toBe("#000000")
  })

  it("clamps the highlighter nib to its minimum width", () => {
    expect(highlighterWidth(undefined)).toBe(MIN_HIGHLIGHTER_WIDTH)
    expect(highlighterWidth(2)).toBe(MIN_HIGHLIGHTER_WIDTH)
    expect(highlighterWidth(8)).toBe(8)
  })

  describe("applyExplicitColor", () => {
    it("in a drawing tool changes only that tool", () => {
      const s = applyExplicitColor(DEFAULT_TOOL_SETTINGS, "highlighter", "#22c55e")
      expect(s.highlighter.color).toBe("#22c55e")
      expect(s.pen.color).toBe("#000000")
    })

    it("in select mode recolours the default pen/shape colour but never the highlighter or eraser", () => {
      const s = applyExplicitColor(DEFAULT_TOOL_SETTINGS, "select", "#ef4444")
      expect(s.pen.color).toBe("#ef4444")
      expect(s.shape.color).toBe("#ef4444")
      expect(s.highlighter.color).toBe("#facc15")
      expect(s.eraser.color).toBe("#000000")
    })
  })
})
