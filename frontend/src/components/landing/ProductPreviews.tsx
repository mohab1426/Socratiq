import { Badge } from "@/components/ui/Badge"
import { DueDate } from "@/components/socratiq/DueDate"
import { LearningJourney } from "@/components/socratiq/LearningJourney"
import { Reveal } from "@/components/ui/Reveal"
import { useState } from "react"
import { Send } from "lucide-react"
import { cn } from "@/lib/utils"

/**
 * Schematic previews built from the real interface components and styles.
 * They show layout and wording only: no numbers, names or results are implied (shapes are decorative).
 */

function Frame({ title, caption, children, className }: { title: string; caption: string; children: React.ReactNode; className?: string }) {
  return (
    <figure className={cn("flex h-full flex-col overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-white shadow-[0_1px_0_rgba(20,17,2,0.04)] transition-shadow duration-200 hover:shadow-md", className)}>
      <div className="flex items-center gap-1.5 border-b border-[var(--color-border)] bg-[var(--color-surface-muted)] px-4 py-2.5" aria-hidden="true">
        <span className="h-2 w-2 rounded-full bg-[var(--color-border-strong)]" />
        <span className="h-2 w-2 rounded-full bg-[var(--color-border-strong)]" />
        <span className="h-2 w-2 rounded-full bg-[var(--color-border-strong)]" />
      </div>
      <div className="flex-1 p-5" role="img" aria-label={`${title}: illustration of the interface`}>{children}</div>
      <figcaption className="border-t border-[var(--color-border)] px-5 py-3.5">
        <p className="text-sm font-semibold text-[var(--color-ink)]">{title}</p>
        <p className="mt-0.5 text-sm text-[var(--color-ink-muted)]">{caption}</p>
      </figcaption>
    </figure>
  )
}

function CoachPreview() {
  return (
    <div className="space-y-2.5 text-sm" aria-hidden="true">
      <div className="flex justify-end">
        <p className="max-w-[80%] rounded-[var(--radius-lg)] bg-[var(--color-teal-light)] px-4 py-2.5 text-[var(--color-ink)]">My loop never stops and I can't see why.</p>
      </div>
      <div className="flex justify-start">
        <div className="max-w-[85%] rounded-[var(--radius-lg)] bg-[var(--color-surface-muted)] px-4 py-2.5 text-[var(--color-ink)]">
          <p>What has to change on each pass for the condition to become false?</p>
          <p className="mt-1.5 text-xs text-[var(--color-ink-muted)]">From course material: Week 3 slides (p. 12)</p>
        </div>
      </div>
      <div className="flex items-center gap-2 pt-1">
        <span className="h-9 min-w-0 flex-1 truncate rounded-full border border-[var(--color-border-strong)] px-4 py-2 text-[var(--color-ink-muted)]">Start your chat here…</span>
        <span className="flex h-9 w-9 items-center justify-center rounded-full bg-[var(--color-plum)] text-[var(--color-on-plum)]"><Send className="h-4 w-4" /></span>
      </div>
    </div>
  )
}

function AssignmentPreview() {
  const [soon] = useState(() => new Date(Date.now() + 2 * 86_400_000).toISOString())
  return (
    <div aria-hidden="true">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-semibold text-[var(--color-ink)]">Sorting algorithms and trade-offs</p>
          <p className="mt-1 text-sm text-[var(--color-ink-muted)]">Data Structures</p>
          <div className="mt-2"><DueDate dueDate={soon} /></div>
        </div>
        <Badge tone="warning">In progress</Badge>
      </div>
      <div className="mt-5">
        <LearningJourney
          steps={[
            { label: "Initial attempt", state: "done" },
            { label: "AI coaching", state: "current" },
            { label: "Final submission", state: "upcoming" },
            { label: "Learning verification", state: "upcoming" },
          ]}
        />
      </div>
    </div>
  )
}

function Bar({ w, tone }: { w: string; tone: string }) {
  return (
    <div className="h-2 rounded-full bg-[var(--color-surface-muted)]">
      <div className="h-2 rounded-full" style={{ width: w, background: `var(--color-${tone})` }} />
    </div>
  )
}

function DashboardPreview() {
  const tiles = ["Assignment completion", "Verified understanding", "Socratic AI usage", "Review indicators"]
  const widths = ["72%", "48%", "60%", "24%"]
  return (
    <div className="grid grid-cols-2 gap-3" aria-hidden="true">
      {tiles.map((t, i) => (
        <div key={t} className="rounded-[var(--radius-md)] border border-[var(--color-border)] p-3">
          <div className="mb-3"><Bar w={widths[i]} tone={i === 3 ? "clay" : "teal-dark"} /></div>
          <p className="text-xs font-medium text-[var(--color-ink-muted)]">{t}</p>
        </div>
      ))}
      <div className="col-span-2 rounded-[var(--radius-md)] border border-[var(--color-border)]">
        {["Student", "Student", "Student"].map((s, i) => (
          <div key={i} className={cn("flex items-center gap-3 px-3 py-2.5", i > 0 && "border-t border-[var(--color-border)]")}>
            <span className="h-6 w-6 rounded-full bg-[var(--color-slate-light)]" />
            <span className="h-2 w-24 rounded-full bg-[var(--color-border)]" />
            <span className="ml-auto h-2 w-16 rounded-full bg-[var(--color-teal-light)]" />
          </div>
        ))}
      </div>
    </div>
  )
}

function AnalyticsPreview() {
  const rows: [string, string, string][] = [
    ["Draft", "22%", "teal"],
    ["Open", "64%", "plum"],
    ["Complete", "40%", "success"],
    ["Past due", "16%", "danger"],
  ]
  return (
    <div className="grid grid-cols-[1fr_auto] items-center gap-5" aria-hidden="true">
      <div className="space-y-3">
        {rows.map(([label, w, tone]) => (
          <div key={label} className="grid grid-cols-[4.5rem_1fr] items-center gap-3 text-xs text-[var(--color-ink-muted)]">
            <span>{label}</span>
            <Bar w={w} tone={tone} />
          </div>
        ))}
      </div>
      <svg viewBox="0 0 36 36" className="h-24 w-24 -rotate-90">
        <circle cx="18" cy="18" r="13" fill="none" stroke="var(--color-surface-muted)" strokeWidth="6" />
        <circle cx="18" cy="18" r="13" fill="none" stroke="var(--color-success)" strokeWidth="6" strokeDasharray="34 82" />
        <circle cx="18" cy="18" r="13" fill="none" stroke="var(--color-slate)" strokeWidth="6" strokeDasharray="28 82" strokeDashoffset="-34" />
        <circle cx="18" cy="18" r="13" fill="none" stroke="var(--color-danger)" strokeWidth="6" strokeDasharray="12 82" strokeDashoffset="-62" />
      </svg>
    </div>
  )
}

export function ProductPreviews() {
  return (
    <>
      <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
        <Reveal><Frame title="Student AI Coach" caption="A conversation that answers with the next question, and cites the course material it used."><CoachPreview /></Frame></Reveal>
        <Reveal delay={120}><Frame title="Assignment" caption="Prompt, due date and a four-step journey from first attempt to verification."><AssignmentPreview /></Frame></Reveal>
        <Reveal delay={0}><Frame title="Teacher dashboard" caption="Completion, verified understanding, coach usage and a row per student."><DashboardPreview /></Frame></Reveal>
        <Reveal delay={120}><Frame title="Learning analytics" caption="Charts drawn from the class's own data: assignment states, submissions, mastery and activity."><AnalyticsPreview /></Frame></Reveal>
      </div>
      <p className="mt-5 text-sm text-[var(--color-ink-muted)]">Illustrations of the interface. Text and shapes are examples only; your dashboard fills with your own class's data.</p>
    </>
  )
}
