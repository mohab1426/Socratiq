import type { ReactNode } from "react"

/** Visible label + optional hint + inline error, wired together for assistive tech. Spread `fieldProps` onto the control. */
export function Field({ id, label, error, hint, children, className }: { id: string; label: string; error?: string; hint?: string; children: ReactNode; className?: string }) {
  return (
    <div className={className}>
      <label htmlFor={id} className="mb-1.5 block text-sm font-medium text-[var(--color-ink)]">{label}</label>
      {children}
      {error ? (
        <p id={`${id}-error`} className="mt-1.5 text-sm text-[var(--color-danger-ink)]">{error}</p>
      ) : hint ? (
        <p id={`${id}-hint`} className="mt-1.5 text-xs text-[var(--color-ink-muted)]">{hint}</p>
      ) : null}
    </div>
  )
}
