/** Small, dependency-free date helpers for instructor views. All inputs are ISO strings from the API (or null). */
export function relativeTime(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return "No activity yet"
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return "Unknown"
  const s = Math.max(0, Math.round((now - t) / 1000))
  if (s < 60) return "Just now"
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} hour${h === 1 ? "" : "s"} ago`
  const d = Math.round(h / 24)
  if (d < 30) return `${d} day${d === 1 ? "" : "s"} ago`
  return new Date(t).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—"
  const t = new Date(iso)
  if (Number.isNaN(t.getTime())) return "—"
  return t.toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })
}

/** "10:31" in the viewer's locale. */
export function formatTime(iso: string | null | undefined): string {
  if (!iso) return "—"
  const t = new Date(iso)
  return Number.isNaN(t.getTime()) ? "—" : t.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
}

/** "Tue, 29 Sep": used as the group heading of a timeline day. */
export function formatDay(iso: string | null | undefined): string {
  if (!iso) return "Unknown date"
  const t = new Date(iso)
  return Number.isNaN(t.getTime()) ? "Unknown date" : t.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })
}
