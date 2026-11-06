import type { HTMLAttributes } from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"

const badgeVariants = cva("inline-flex max-w-full items-center rounded-full px-2.5 py-0.5 text-xs font-medium [overflow-wrap:anywhere]", {
  variants: {
    tone: {
      plum: "bg-[var(--color-plum-light)] text-[var(--color-ink)]",
      teal: "bg-[var(--color-teal-light)] text-[var(--color-teal-dark)]",
      slate: "bg-[var(--color-slate-light)] text-[var(--color-ink)]",
      success: "bg-[var(--color-success-light)] text-[var(--color-success-ink)]",
      warning: "bg-[var(--color-warning-light)] text-[var(--color-warning-ink)]",
      danger: "bg-[var(--color-danger-light)] text-[var(--color-danger-ink)]",
      neutral: "bg-[var(--color-surface-muted)] text-[var(--color-ink-muted)]",
    },
  },
  defaultVariants: { tone: "neutral" },
})

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}

export function Badge({ className, tone, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />
}
