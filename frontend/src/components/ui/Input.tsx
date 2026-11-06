import { forwardRef, type InputHTMLAttributes, type SelectHTMLAttributes } from "react"
import { cn } from "@/lib/utils"

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => (
    <input
      ref={ref}
      className={cn(
        "h-11 w-full rounded-full border border-[var(--color-control-border)] bg-white px-4 text-sm text-[var(--color-ink)] placeholder:text-[var(--color-ink-muted)]",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-teal-dark)] focus-visible:ring-offset-1",
        className
      )}
      {...props}
    />
  )
)
Input.displayName = "Input"

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(({ className, children, ...props }, ref) => (
  <select
    ref={ref}
    className={cn(
      "h-11 w-full rounded-full border border-[var(--color-control-border)] bg-white px-4 text-sm text-[var(--color-ink)]",
      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-teal-dark)] focus-visible:ring-offset-1",
      className
    )}
    {...props}
  >
    {children}
  </select>
))
Select.displayName = "Select"
