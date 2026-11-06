import { useState } from "react"
import { Bar, BarChart, CartesianGrid, Cell, LabelList, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts"
import { ChartCard, type ChartState } from "@/components/charts/ChartCard"
import { prefersReducedMotion, truncate, useChartColors } from "@/components/charts/chartTheme"
import type { useDashboard, useTeacherCourse } from "@/lib/queries"

type Dashboard = NonNullable<ReturnType<typeof useDashboard>["data"]>
type TeacherAssignments = NonNullable<ReturnType<typeof useTeacherCourse>["data"]>["assignments"]

const tipStyle = { borderRadius: 12, border: "1px solid var(--color-border-strong)", boxShadow: "none", fontSize: 12 } as const
const axisTick = { fontSize: 12, fill: "var(--color-ink-muted)" }

/**
 * Four charts, every number derived from data the dashboard endpoints already return:
 *  - assignment states  ← teacher course assignments (lifecycle, due date, submitted/enrolled counts)
 *  - submissions        ← the same assignments (submittedCount / studentCount)
 *  - mastery            ← dashboard `students[].mastery`
 *  - recent activity    ← dashboard `activity[].kind` (the API returns only the latest events)
 * Nothing is estimated or invented; empty inputs render a "No data available yet" state.
 */
export default function TeacherAnalytics({
  dashboard,
  assignments,
  assignmentsState,
}: {
  dashboard: Dashboard
  assignments: TeacherAssignments | undefined
  assignmentsState: "loading" | "error" | "ready"
}) {
  const c = useChartColors()
  const animate = !prefersReducedMotion()
  const [now] = useState(() => Date.now())

  /* 1 · assignments by state */
  const states = { Open: 0, Complete: 0, "Past due": 0, Draft: 0, Archived: 0 }
  for (const a of assignments ?? []) {
    const life = a.lifecycle ?? "DRAFT"
    if (life === "DRAFT") states.Draft++
    else if (life === "ARCHIVED") states.Archived++
    else if (a.studentCount > 0 && a.submittedCount >= a.studentCount) states.Complete++
    else if (a.dueDate && new Date(a.dueDate).getTime() < now) states["Past due"]++
    else states.Open++
  }
  const stateColor: Record<string, string> = { Open: c.plum, Complete: c.success, "Past due": c.danger, Draft: c.teal, Archived: c["ink-muted"] }
  const stateData = Object.entries(states).map(([name, value]) => ({ name, value }))
  const stateTotal = assignments?.length ?? 0

  /* 2 · submissions per published assignment */
  const published = (assignments ?? []).filter((a) => a.lifecycle === "PUBLISHED" && a.studentCount > 0)
  const shown = published.slice(0, 8)
  const submissionData = shown.map((a) => ({ name: truncate(a.title, 20), full: a.title, Submitted: a.submittedCount, Remaining: Math.max(a.studentCount - a.submittedCount, 0) }))

  /* 3 · mastery distribution */
  const mastery = { Strong: 0, Moderate: 0, Weak: 0, "Not enough evidence": 0 }
  for (const s of dashboard.students) mastery[s.mastery ?? "Not enough evidence"]++
  const masteryColor: Record<string, string> = { Strong: c.success, Moderate: c["teal-dark"], Weak: c.danger, "Not enough evidence": c["border-strong"] }
  const masteryData = Object.entries(mastery).map(([name, value]) => ({ name, value })).filter((d) => d.value > 0)

  /* 4 · recent activity by type */
  const kinds = { submission: 0, revision: 0, verification: 0, coach_session: 0 }
  for (const e of dashboard.activity) kinds[e.kind]++
  const kindLabel = { submission: "Submissions", revision: "Revisions", verification: "Verifications", coach_session: "Coach sessions" }
  const kindColor = { submission: c["teal-dark"], revision: c.plum, verification: c.success, coach_session: c.slate }
  const activityData = (Object.keys(kinds) as (keyof typeof kinds)[]).map((k) => ({ key: k, name: kindLabel[k], value: kinds[k] }))

  const asgState = (empty: boolean): ChartState => (assignmentsState === "ready" ? (empty ? "empty" : "ready") : assignmentsState)

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <ChartCard title="Assignments by state" description="Where each assignment in this course stands right now." state={asgState(stateTotal === 0)} emptyHint="Create an assignment and it will be counted here.">
        <div role="img" aria-label={`Assignments by state: ${stateData.map((d) => `${d.value} ${d.name}`).join(", ")}`} className="h-56 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={stateData} layout="vertical" margin={{ top: 4, right: 28, bottom: 4, left: 0 }}>
              <CartesianGrid horizontal={false} stroke={c.border} />
              <XAxis type="number" allowDecimals={false} tick={axisTick} axisLine={false} tickLine={false} />
              <YAxis type="category" dataKey="name" width={72} tick={axisTick} axisLine={false} tickLine={false} />
              <Tooltip cursor={{ fill: c["surface-muted"] }} contentStyle={tipStyle} formatter={(v) => [`${v}`, "Assignments"]} />
              <Bar dataKey="value" radius={[0, 6, 6, 0]} isAnimationActive={animate} barSize={22}>
                {stateData.map((d) => (
                  <Cell key={d.name} fill={stateColor[d.name]} />
                ))}
                <LabelList dataKey="value" position="right" style={{ fontSize: 12, fill: c.ink }} />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </ChartCard>

      <ChartCard
        title="Submissions per assignment"
        description="Students who have submitted, out of everyone enrolled. Published assignments only."
        state={asgState(published.length === 0)}
        emptyHint="Appears once you publish an assignment and students are enrolled."
        footnote={published.length > shown.length ? `Showing ${shown.length} of ${published.length} published assignments.` : undefined}
      >
        <div role="img" aria-label={`Submissions per assignment: ${submissionData.map((d) => `${d.full}, ${d.Submitted} of ${d.Submitted + d.Remaining}`).join("; ")}`} className="w-full" style={{ height: Math.max(shown.length * 44 + 56, 200) }}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={submissionData} layout="vertical" margin={{ top: 4, right: 12, bottom: 4, left: 0 }}>
              <CartesianGrid horizontal={false} stroke={c.border} />
              <XAxis type="number" allowDecimals={false} tick={axisTick} axisLine={false} tickLine={false} />
              <YAxis type="category" dataKey="name" width={128} tick={axisTick} axisLine={false} tickLine={false} />
              <Tooltip cursor={{ fill: c["surface-muted"] }} contentStyle={tipStyle} labelFormatter={(_, p) => p?.[0]?.payload?.full ?? ""} />
              <Bar dataKey="Submitted" stackId="s" fill={c["teal-dark"]} isAnimationActive={animate} barSize={20} />
              <Bar dataKey="Remaining" name="Not yet submitted" stackId="s" fill={c["border-strong"]} radius={[0, 6, 6, 0]} isAnimationActive={animate} barSize={20} />
            </BarChart>
          </ResponsiveContainer>
        </div>
        <ul className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-xs text-[var(--color-ink-muted)]">
          <li className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full" style={{ background: c["teal-dark"] }} aria-hidden="true" />Submitted</li>
          <li className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full" style={{ background: c["border-strong"] }} aria-hidden="true" />Not yet submitted</li>
        </ul>
      </ChartCard>

      <ChartCard title="Mastery across students" description="From learning-verification results. Students without enough evidence are shown separately." state={dashboard.students.length === 0 ? "empty" : "ready"} emptyHint="Appears once students join the course.">
        <div className="flex flex-col items-center gap-4 sm:flex-row">
          <div role="img" aria-label={`Mastery: ${masteryData.map((d) => `${d.value} ${d.name}`).join(", ")}`} className="relative h-44 w-44 shrink-0">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie data={masteryData} dataKey="value" nameKey="name" innerRadius="62%" outerRadius="100%" paddingAngle={masteryData.length > 1 ? 2 : 0} stroke="none" isAnimationActive={animate}>
                  {masteryData.map((d) => (
                    <Cell key={d.name} fill={masteryColor[d.name]} />
                  ))}
                </Pie>
                <Tooltip contentStyle={tipStyle} formatter={(v, n) => [`${v} student${v === 1 ? "" : "s"}`, n]} />
              </PieChart>
            </ResponsiveContainer>
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
              <span className="text-2xl font-semibold text-[var(--color-ink)]">{dashboard.students.length}</span>
              <span className="text-xs text-[var(--color-ink-muted)]">students</span>
            </div>
          </div>
          <ul className="w-full space-y-2 text-sm">
            {Object.entries(mastery).map(([name, value]) => (
              <li key={name} className="flex items-center justify-between gap-3">
                <span className="flex items-center gap-2 text-[var(--color-ink)]">
                  <span className="h-2.5 w-2.5 rounded-full" style={{ background: masteryColor[name] }} aria-hidden="true" />
                  {name}
                </span>
                <span className="font-medium text-[var(--color-ink)]">{value}</span>
              </li>
            ))}
          </ul>
        </div>
      </ChartCard>

      <ChartCard
        title="Recent learning activity"
        description="What students have been doing, by type."
        state={dashboard.activity.length === 0 ? "empty" : "ready"}
        emptyHint="Submissions, revisions, verifications and coach sessions are counted here."
        footnote={`Counts the latest ${dashboard.activity.length} recorded event${dashboard.activity.length === 1 ? "" : "s"}, not all-time totals.`}
      >
        <div role="img" aria-label={`Recent activity: ${activityData.map((d) => `${d.value} ${d.name}`).join(", ")}`} className="h-56 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={activityData} layout="vertical" margin={{ top: 4, right: 28, bottom: 4, left: 0 }}>
              <CartesianGrid horizontal={false} stroke={c.border} />
              <XAxis type="number" allowDecimals={false} tick={axisTick} axisLine={false} tickLine={false} />
              <YAxis type="category" dataKey="name" width={104} tick={axisTick} axisLine={false} tickLine={false} />
              <Tooltip cursor={{ fill: c["surface-muted"] }} contentStyle={tipStyle} formatter={(v) => [`${v}`, "Events"]} />
              <Bar dataKey="value" radius={[0, 6, 6, 0]} isAnimationActive={animate} barSize={22}>
                {activityData.map((d) => (
                  <Cell key={d.key} fill={kindColor[d.key]} />
                ))}
                <LabelList dataKey="value" position="right" style={{ fontSize: 12, fill: c.ink }} />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </ChartCard>
    </div>
  )
}
