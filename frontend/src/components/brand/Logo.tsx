import { cn } from "@/lib/utils"

/**
 * SocratiQ mark: a Greek phi (Φ), the initial of *philosophia* — one ring and one vertical stroke.
 * The ring is always brand orange; the stroke follows `currentColor`, so the mark works on light and dark surfaces
 * and collapses cleanly to a single colour (set both to the same value) for monochrome use.
 */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="6 0 36 48" fill="none" aria-hidden="true" className={cn("h-8 w-auto shrink-0", className)}>
      <circle cx="24" cy="24" r="12.5" stroke="var(--color-plum)" strokeWidth="6" />
      <path d="M24 4V44" stroke="currentColor" strokeWidth="6" />
    </svg>
  )
}

const sizes = {
  sm: { mark: "h-7", text: "text-xl", gap: "gap-2" },
  md: { mark: "h-8", text: "text-2xl", gap: "gap-2.5" },
  lg: { mark: "h-8 sm:h-11", text: "text-[1.5rem] sm:text-4xl", gap: "gap-2.5" },
} as const

export function Logo({ size = "md", tone = "dark", className }: { size?: keyof typeof sizes; tone?: "dark" | "light"; className?: string }) {
  const s = sizes[size]
  return (
    <span className={cn("inline-flex items-center", s.gap, tone === "dark" ? "text-[var(--color-ink)]" : "text-[var(--color-canvas)]", className)}>
      <LogoMark className={s.mark} />
      <span className={cn("font-serif font-bold leading-none tracking-[-0.01em]", s.text)}>SocratiQ</span>
    </span>
  )
}
