import type { ReactNode } from "react"
import { Menu, Search, X } from "lucide-react"
import { Link } from "react-router-dom"

export interface HeaderSearch {
  value: string
  onChange: (value: string) => void
  placeholder?: string
}

export function PageHeader({
  crumbs,
  search,
  onMenuClick,
  right,
}: {
  crumbs: { label: string; to?: string }[]
  search?: HeaderSearch
  onMenuClick: () => void
  right?: ReactNode
}) {
  return (
    <header className="sticky top-0 z-20 flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-[var(--color-border)] bg-white px-4 py-3 lg:px-6">
      <button
        className="rounded-[var(--radius-sm)] p-2.5 text-[var(--color-ink-muted)] hover:bg-[var(--color-surface-muted)] lg:hidden"
        onClick={onMenuClick}
        aria-label="Open menu"
      >
        <Menu className="h-5 w-5" />
      </button>

      <nav aria-label="Breadcrumb" className="min-w-0 flex-1 truncate text-sm leading-6 text-[var(--color-ink-muted)]">
        {crumbs.map((c, i) => (
          <span key={i}>
            {c.to ? (
              <Link to={c.to} className="inline-block hover:text-[var(--color-ink)] hover:underline">
                {c.label}
              </Link>
            ) : (
              <span aria-current="page" className="font-semibold text-[var(--color-ink)]">{c.label}</span>
            )}
            {i < crumbs.length - 1 && <span className="mx-2 text-[var(--color-ink-muted)]" aria-hidden="true">/</span>}
          </span>
        ))}
      </nav>

      {right}

      {search && (
        // full-width second row on phones, fixed-width in the header row from sm up
        <div className="relative order-last w-full sm:order-none sm:w-72 lg:w-80">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--color-ink-muted)]" aria-hidden="true" />
          <input
            type="search"
            value={search.value}
            onChange={(e) => search.onChange(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && search.onChange("")}
            placeholder={search.placeholder ?? "Search…"}
            aria-label={search.placeholder ?? "Search"}
            className="h-9 w-full rounded-full border border-[var(--color-control-border)] bg-[var(--color-surface-muted)] pl-9 pr-9 text-sm text-[var(--color-ink)] placeholder:text-[var(--color-ink-muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-teal-dark)] [&::-webkit-search-cancel-button]:hidden"
          />
          {search.value && (
            <button
              type="button"
              onClick={() => search.onChange("")}
              aria-label="Clear search"
              className="absolute right-1.5 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-full text-[var(--color-ink-muted)] hover:bg-white hover:text-[var(--color-ink)]"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      )}
    </header>
  )
}
