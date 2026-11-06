import { Check } from "lucide-react"
import { cn } from "@/lib/utils"

export interface JourneyStep {
  label: string
  state: "done" | "current" | "upcoming"
}

/**
 * Four-step progress. In a narrow container (phones, half-width cards) the steps stack vertically so labels like
 * "Learning verification" are never squeezed; from 28rem of container width they run left to right.
 */
export function LearningJourney({ steps }: { steps: JourneyStep[] }) {
  return (
    <div className="@container w-full">
      <ol className="flex w-full flex-col @md:flex-row @md:items-center" aria-label="Learning journey">
        {steps.map((step, i) => (
          <li key={step.label} aria-current={step.state === "current" ? "step" : undefined} className="flex min-w-0 flex-col @md:flex-1 @md:flex-row @md:items-start">
            <div className="flex min-w-0 items-center gap-3 @md:flex-col @md:gap-1.5">
              <span
                className={cn(
                  "flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold",
                  step.state === "done" && "bg-[var(--color-teal)] text-[var(--color-on-teal)]",
                  step.state === "current" && "bg-[var(--color-plum)] text-[var(--color-on-plum)]",
                  step.state === "upcoming" && "border border-[var(--color-control-border)] bg-[var(--color-surface-muted)] text-[var(--color-ink-muted)]"
                )}
              >
                {step.state === "done" ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : i + 1}
              </span>
              <span
                className={cn(
                  "min-w-0 text-sm @md:w-full @md:max-w-[6.5rem] @md:text-center @md:text-xs",
                  step.state === "upcoming" ? "text-[var(--color-ink-muted)]" : "font-semibold text-[var(--color-ink)]"
                )}
              >
                {step.label}
                {step.state === "done" && <span className="sr-only"> (done)</span>}
                {step.state === "current" && <span className="sr-only"> (current step)</span>}
              </span>
            </div>
            {i < steps.length - 1 && (
              <div
                aria-hidden="true"
                className={cn(
                  "ml-3 h-3 w-px @md:mx-1 @md:ml-1 @md:mt-3 @md:h-px @md:min-w-2 @md:w-auto @md:flex-1",
                  step.state === "done" ? "bg-[var(--color-teal)]" : "bg-[var(--color-border-strong)]"
                )}
              />
            )}
          </li>
        ))}
      </ol>
    </div>
  )
}
