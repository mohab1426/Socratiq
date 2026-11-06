import { useMemo } from "react"

const tokens = ["plum", "plum-dark", "teal", "teal-dark", "slate", "clay", "success", "danger", "ink", "ink-muted", "border", "border-strong", "surface-muted"] as const
export type ChartColors = Record<(typeof tokens)[number], string>

/** Chart colours come straight from the app's CSS tokens, so charts can never drift from the palette. */
export function useChartColors(): ChartColors {
  return useMemo(() => {
    const css = getComputedStyle(document.documentElement)
    return Object.fromEntries(tokens.map((t) => [t, css.getPropertyValue(`--color-${t}`).trim() || "#999999"])) as ChartColors
  }, [])
}

export const prefersReducedMotion = () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches

export const truncate = (text: string, max = 22) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)
