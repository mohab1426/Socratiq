import type { ReactNode } from "react"
import { AlertCircle } from "lucide-react"
import type { UseQueryResult } from "@tanstack/react-query"
import { Button } from "./Button"
import { ApiError } from "@/lib/api"

export function EmptyState({
  title,
  description,
  action,
  icon,
}: {
  title: string
  description: string
  action?: { label: string; onClick?: () => void }
  icon?: ReactNode
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-[var(--radius-lg)] border border-dashed border-[var(--color-border-strong)] bg-[var(--color-surface-muted)] px-6 py-14 text-center">
      {icon && <div className="mb-3 text-[var(--color-ink-muted)]">{icon}</div>}
      <h3 className="text-base font-semibold text-[var(--color-ink)]">{title}</h3>
      <p className="mt-1 max-w-sm text-sm text-[var(--color-ink-soft)]">{description}</p>
      {action && (
        <Button className="mt-4" size="sm" onClick={action.onClick}>
          {action.label}
        </Button>
      )}
    </div>
  )
}

export function ErrorState({ title, description, onRetry }: { title: string; description: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="flex flex-col items-center justify-center rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-white px-6 py-12 text-center shadow-[var(--shadow-panel)]">
      <span className="mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-[var(--color-danger-light)] text-[var(--color-danger-ink)]">
        <AlertCircle className="h-5 w-5" aria-hidden="true" />
      </span>
      <h3 className="text-base font-semibold text-[var(--color-ink)]">{title}</h3>
      <p className="mt-1 max-w-sm text-sm text-[var(--color-ink-muted)]">{description}</p>
      {onRetry && (
        <Button className="mt-4" size="sm" variant="outline" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  )
}

export function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse motion-reduce:animate-none rounded-[var(--radius-md)] bg-[var(--color-border)] ${className}`} />
}

export function CardSkeleton() {
  return (
    <div className="rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-white p-5">
      <Skeleton className="h-24 w-full rounded-[var(--radius-md)] mb-4" />
      <Skeleton className="h-4 w-2/3 mb-2" />
      <Skeleton className="h-3 w-1/2" />
    </div>
  )
}

/** Consistent loading / not-found / error handling for any React Query result. */
export function QueryState<T>({
  query,
  what,
  children,
  skeleton,
}: {
  query: UseQueryResult<T>
  what: string
  children: (data: T) => ReactNode
  /** Page-shaped placeholder shown while loading; defaults to a generic one. */
  skeleton?: ReactNode
}) {
  if (query.isPending) {
    if (skeleton) return <>{skeleton}</>
    return (
      <div className="space-y-3" aria-busy="true" aria-live="polite">
        <Skeleton className="h-7 w-1/3" />
        <Skeleton className="h-4 w-1/2" />
        <div className="grid grid-cols-1 gap-4 pt-4 sm:grid-cols-2 lg:grid-cols-3">
          <CardSkeleton />
          <CardSkeleton />
          <CardSkeleton />
        </div>
      </div>
    )
  }
  if (query.isError) {
    const err = query.error
    if (err instanceof ApiError && (err.status === 404 || err.status === 403)) {
      return <ErrorState title={`${what} not found`} description="It may have been removed, or you may not have access to it." />
    }
    // No raw server text in the normal UI: it is technical and not actionable for a teacher.
    return (
      <ErrorState title="Something went wrong" description={`We couldn't load the ${what.toLowerCase()}. Check your connection and try again.`} onRetry={() => void query.refetch()} />
    )
  }
  return <>{children(query.data)}</>
}

/** Shown when a search matches nothing. Always offers a way back. */
export function NoMatches({ query, onClear }: { query: string; onClear: () => void }) {
  return <EmptyState title="No matches" description={`Nothing matches “${query.trim()}”. Check the spelling or try a shorter search.`} action={{ label: "Clear search", onClick: onClear }} />
}
