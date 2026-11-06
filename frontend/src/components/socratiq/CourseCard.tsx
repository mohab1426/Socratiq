import { Link } from "react-router-dom"
import { Plus } from "lucide-react"
import { Badge } from "@/components/ui/Badge"
import type { Course } from "@/types"

const colorMap: Record<Course["color"], string> = {
  plum: "bg-[var(--color-plum)]",
  slate: "bg-[var(--color-slate)]",
  teal: "bg-[var(--color-teal)]",
  clay: "bg-[var(--color-clay)]",
}

export function CourseCard({ course, to }: { course: Course; to: string }) {
  return (
    <Link
      to={to}
      className="group flex flex-col overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-white transition-shadow hover:shadow-md"
    >
      <div className={`flex h-24 flex-col justify-end p-4 text-[var(--color-ink)] ${colorMap[course.color]}`}>
        <p className="text-xs font-semibold opacity-80">{course.code}</p>
        <h3 className="text-base font-semibold">{course.name}</h3>
      </div>
      <div className="flex flex-1 flex-col gap-2 p-4">
        <p className="text-sm text-[var(--color-ink-muted)]">{course.description}</p>
        <div className="mt-auto flex items-center justify-between pt-2 text-xs">
          <span className="text-[var(--color-ink-muted)]">{course.teacher}</span>
          <Badge tone="success">{course.status}</Badge>
        </div>
      </div>
    </Link>
  )
}

export function JoinCourseCard({ label = "Join a course", onClick }: { label?: string; onClick?: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex h-full min-h-[152px] flex-col items-center justify-center gap-2 rounded-[var(--radius-lg)] border border-dashed border-[var(--color-border-strong)] bg-white text-sm font-medium text-[var(--color-ink-muted)] transition-colors hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-ink)]"
    >
      <Plus className="h-5 w-5 text-[var(--color-teal-dark)]" />
      {label}
    </button>
  )
}
