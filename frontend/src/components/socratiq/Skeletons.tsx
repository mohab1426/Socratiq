import { Skeleton } from "@/components/ui/States"

const box = "rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-white p-5 shadow-[var(--shadow-panel)]"

function Busy({ children }: { children: React.ReactNode }) {
  return (
    <div role="status" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading…</span>
      {children}
    </div>
  )
}

export function TableSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className="space-y-3">
      {Array.from({ length: rows }, (_, i) => <Skeleton key={i} className="h-10 w-full" />)}
    </div>
  )
}

/** Header + metrics + review table + two columns: the same silhouette as the loaded page, so nothing jumps. */
export function DashboardBodySkeleton() {
  return (
    <Busy>
      <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {Array.from({ length: 5 }, (_, i) => <div key={i} className={box}><Skeleton className="h-4 w-1/2" /><Skeleton className="mt-3 h-8 w-1/3" /></div>)}
      </div>
      <div className={`${box} mt-6`}><Skeleton className="mb-4 h-5 w-40" /><TableSkeleton rows={3} /></div>
      <div className="mt-6 grid gap-5 lg:grid-cols-5">
        <div className={`${box} lg:col-span-3`}><Skeleton className="mb-4 h-5 w-36" /><TableSkeleton rows={4} /></div>
        <div className={`${box} lg:col-span-2`}><Skeleton className="mb-4 h-5 w-36" /><TableSkeleton rows={3} /></div>
      </div>
    </Busy>
  )
}

export function DashboardSkeleton() {
  return (
    <Busy>
      <Skeleton className="h-7 w-64" />
      <Skeleton className="mt-2 h-4 w-80 max-w-full" />
      <DashboardBodySkeleton />
    </Busy>
  )
}

export function StudentSkeleton() {
  return (
    <Busy>
      <div className="flex items-center gap-4"><Skeleton className="h-14 w-14 rounded-full" /><div className="flex-1"><Skeleton className="h-6 w-48" /><Skeleton className="mt-2 h-4 w-64 max-w-full" /></div></div>
      <div className={`${box} mt-5`}><Skeleton className="mb-4 h-5 w-48" /><div className="grid gap-3 sm:grid-cols-4"><Skeleton className="h-20 sm:col-span-2" /><Skeleton className="h-20" /><Skeleton className="h-20" /></div></div>
      <div className="mt-5 grid gap-5 lg:grid-cols-5">
        <div className={`${box} lg:col-span-3`}><Skeleton className="mb-4 h-5 w-32" /><TableSkeleton rows={5} /></div>
        <div className={`${box} lg:col-span-2`}><Skeleton className="mb-4 h-5 w-32" /><TableSkeleton rows={3} /></div>
      </div>
    </Busy>
  )
}

export function SubmissionSkeleton() {
  return (
    <Busy>
      <Skeleton className="h-7 w-56" />
      <Skeleton className="mt-2 h-4 w-72 max-w-full" />
      <div className={`${box} mt-5`}><Skeleton className="mb-4 h-5 w-32" /><Skeleton className="h-32 w-full" /></div>
      <div className={`${box} mt-5`}><Skeleton className="mb-4 h-5 w-40" /><TableSkeleton rows={3} /></div>
    </Busy>
  )
}
