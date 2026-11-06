export type DueState = "none" | "upcoming" | "soon" | "overdue" | "done"

export interface DueInfo {
  state: DueState
  /** Short text for the badge, e.g. "Due tomorrow, 5:00 PM". */
  label: string
  /** Full date + time for a tooltip. */
  full: string | null
  iso: string | null
  /** Epoch ms, for sorting. null when there is no due date. */
  time: number | null
}

const DAY = 86_400_000
/** An assignment counts as "due soon" inside this window. */
export const DUE_SOON_MS = 3 * DAY

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
const time = (d: Date) => d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
const dateShort = (d: Date, withYear: boolean) => d.toLocaleDateString(undefined, { month: "short", day: "numeric", ...(withYear ? { year: "numeric" } : {}) })

/** Turns a due date (+ whether the student already handed the work in) into one of five display states. */
export function dueInfo(dueDate: string | null | undefined, done = false, now: Date = new Date()): DueInfo {
  if (!dueDate) return { state: "none", label: "No due date", full: null, iso: null, time: null }
  const due = new Date(dueDate)
  if (Number.isNaN(due.getTime())) return { state: "none", label: "No due date", full: null, iso: null, time: null }

  const sameYear = due.getFullYear() === now.getFullYear()
  const full = `${due.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" })}, ${time(due)}`
  const base = { full, iso: due.toISOString(), time: due.getTime() }

  if (done) return { ...base, state: "done", label: `Due ${dateShort(due, !sameYear)}` }

  const diff = due.getTime() - now.getTime()
  if (diff < 0) {
    const days = Math.floor(-diff / DAY)
    return { ...base, state: "overdue", label: days < 1 ? `Overdue · was due ${time(due)}` : `Overdue by ${days} day${days === 1 ? "" : "s"}` }
  }
  if (diff <= DUE_SOON_MS) {
    const dayGap = Math.round((startOfDay(due) - startOfDay(now)) / DAY)
    const when = dayGap <= 0 ? `today, ${time(due)}` : dayGap === 1 ? `tomorrow, ${time(due)}` : `in ${dayGap} days`
    return { ...base, state: "soon", label: `Due ${when}` }
  }
  return { ...base, state: "upcoming", label: `Due ${dateShort(due, !sameYear)}` }
}

/** "Sep 20, 2:03 PM" from an API timestamp; falls back to the raw text if it can't be parsed. */
export function formatWhen(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const sameYear = d.getFullYear() === new Date().getFullYear()
  return `${dateShort(d, !sameYear)}, ${time(d)}`
}
