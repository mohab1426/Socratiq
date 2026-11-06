import type { ReactNode } from "react"

/** Same title block on every teacher page: optional avatar/icon, small eyebrow, h1, one line of context, badges, actions on the right. */
export function PageIntro({ eyebrow, title, subtitle, meta, actions, leading }: {
  eyebrow?: string
  title: string
  subtitle?: ReactNode
  meta?: ReactNode
  actions?: ReactNode
  leading?: ReactNode
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
      <div className="flex min-w-0 items-start gap-4">
        {leading}
        <div className="min-w-0">
          {eyebrow && <p className="text-xs font-medium text-[var(--color-teal-dark)]">{eyebrow}</p>}
          <h1 className="text-balance text-xl font-semibold text-[var(--color-ink)] [overflow-wrap:anywhere] sm:text-2xl">{title}</h1>
          {subtitle && <p className="mt-1 text-sm text-[var(--color-ink-muted)] [overflow-wrap:anywhere]">{subtitle}</p>}
          {meta && <div className="mt-2 flex flex-wrap items-center gap-1.5">{meta}</div>}
        </div>
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  )
}
