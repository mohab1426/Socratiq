/**
 * Per-tool drawing settings for the SmartBoard.
 *
 * Previously a single colour and a single width were shared by every tool. That caused two verified
 * problems: the highlighter inherited the pen's default black (so it never used its yellow default),
 * and picking a highlighter colour silently changed the pen colour when the user switched back.
 *
 * Settings are grouped by "family" so related tools (line, arrow, shapes, text) keep sharing one
 * set of defaults, matching the existing toolbar, while pen and highlighter are independent.
 */

export type SettingsFamily = "pen" | "highlighter" | "eraser" | "shape"

export interface ToolSetting {
  color: string
  width: number
}

export type ToolSettings = Record<SettingsFamily, ToolSetting>

export const DEFAULT_TOOL_SETTINGS: ToolSettings = {
  pen: { color: "#000000", width: 4 },
  highlighter: { color: "#facc15", width: 6 },
  // The eraser has no width control; keep it independent so a line/shape width never resizes it.
  eraser: { color: "#000000", width: 4 },
  shape: { color: "#000000", width: 4 },
}

/** Which settings family a tool belongs to. Pen and highlighter are independent; everything else shares "shape". */
export function settingsFamily(tool: string): SettingsFamily {
  if (tool === "pen") return "pen"
  if (tool === "highlighter") return "highlighter"
  if (tool === "eraser") return "eraser"
  return "shape"
}

/** Immutable update of one field for the family of `tool`. Returns the same object when nothing changes. */
export function updateToolSetting(
  settings: ToolSettings,
  tool: string,
  patch: Partial<ToolSetting>,
): ToolSettings {
  const family = settingsFamily(tool)
  const prev = settings[family]
  const next: ToolSetting = {
    color: patch.color ?? prev.color,
    width: patch.width ?? prev.width,
  }
  if (next.color === prev.color && next.width === prev.width) return settings
  return { ...settings, [family]: next }
}

/** Width the highlighter nib is stored with: never thinner than the minimum highlighter size. */
export const MIN_HIGHLIGHTER_WIDTH = 6
export function highlighterWidth(width: number | undefined): number {
  return width ? Math.max(width, MIN_HIGHLIGHTER_WIDTH) : MIN_HIGHLIGHTER_WIDTH
}

/**
 * An explicit colour pick by the user. In a drawing tool it changes only that tool's family. In select/pan
 * mode (recolouring a selection) it also becomes the default pen colour, which is the existing behaviour
 * the toolbar documents; the highlighter and eraser are never changed by it.
 */
export function applyExplicitColor(settings: ToolSettings, tool: string, color: string): ToolSettings {
  let next = updateToolSetting(settings, tool, { color })
  if (tool === "select" || tool === "pan") next = updateToolSetting(next, "pen", { color })
  return next
}
