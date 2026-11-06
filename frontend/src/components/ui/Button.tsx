import { forwardRef, type ButtonHTMLAttributes } from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Link, type LinkProps } from "react-router-dom"
import { cn } from "@/lib/utils"

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 rounded-full font-medium transition-colors duration-150 disabled:opacity-40 disabled:pointer-events-none whitespace-nowrap",
  {
    variants: {
      variant: {
        primary: "bg-[var(--color-plum)] text-[var(--color-on-plum)] hover:bg-[var(--color-plum-dark)]",
        secondary: "bg-[var(--color-teal)] text-[var(--color-on-teal)] hover:bg-[var(--color-teal-dark)] hover:text-white",
        outline: "border border-[var(--color-border-strong)] text-[var(--color-ink)] bg-white hover:bg-[var(--color-surface-muted)]",
        ghost: "text-[var(--color-ink-soft)] hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-ink)]",
        danger: "bg-[var(--color-danger-ink)] text-white hover:opacity-90",
        link: "p-0 rounded-none text-[var(--color-ink)] underline underline-offset-4 hover:text-[var(--color-ink-muted)]",
      },
      size: {
        sm: "h-8 px-3 text-sm",
        md: "h-10 px-4 text-sm",
        lg: "h-11 px-5 text-[0.95rem]",
      },
    },
    defaultVariants: { variant: "primary", size: "md" },
  }
)

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, ...props }, ref) => (
    <button ref={ref} className={cn(buttonVariants({ variant, size }), className)} {...props} />
  )
)
Button.displayName = "Button"

/** A real link (one tab stop, correct semantics) that looks like a Button. Use instead of <Link><Button/></Link>. */
export const ButtonLink = forwardRef<HTMLAnchorElement, LinkProps & VariantProps<typeof buttonVariants>>(
  ({ className, variant, size, ...props }, ref) => <Link ref={ref} className={cn(buttonVariants({ variant, size }), className)} {...props} />
)
ButtonLink.displayName = "ButtonLink"
