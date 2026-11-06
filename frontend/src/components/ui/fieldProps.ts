import { cn } from "@/lib/utils"

/** Spread onto a form control so its id, invalid state and description line up with <Field>. */
export function fieldProps(id: string, error?: string, hasHint = false) {
  return {
    id,
    "aria-invalid": error ? true : undefined,
    "aria-describedby": error ? `${id}-error` : hasHint ? `${id}-hint` : undefined,
    className: cn(error && "border-[var(--color-danger)]"),
  } as const
}
