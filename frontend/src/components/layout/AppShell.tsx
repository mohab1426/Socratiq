import { useState, type ReactNode } from "react"
import { Sidebar } from "./Sidebar"
import { PageHeader, type HeaderSearch } from "./PageHeader"
import { useAuth } from "@/lib/auth"
import { useCourses } from "@/lib/queries"
import type { Role } from "@/types"
import { cn } from "@/lib/utils"

/** The signed-in user and their course list come from the session and the API; pages only describe their own content. */
export function AppShell({
  role,
  crumbs,
  search,
  headerRight,
  mainClassName,
  children,
}: {
  role: Role
  crumbs: { label: string; to?: string }[]
  /** Pass a controlled value to show a working search box in the header; omit it on pages with nothing to search. */
  search?: HeaderSearch
  headerRight?: ReactNode
  mainClassName?: string
  children: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const { me, signOut } = useAuth()
  const { data: courses = [] } = useCourses(role)

  return (
    <div className="flex min-h-[100dvh] bg-[var(--color-canvas)]">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-50 focus:rounded-full focus:bg-[var(--color-ink)] focus:px-4 focus:py-2 focus:text-sm focus:text-white"
      >
        Skip to main content
      </a>
      <Sidebar role={role} userName={me?.name ?? ""} userEmail={me?.email ?? ""} courses={courses} open={open} onClose={() => setOpen(false)} onSignOut={signOut} />
      <div className="flex min-w-0 flex-1 flex-col">
        <PageHeader crumbs={crumbs} search={search} onMenuClick={() => setOpen(true)} right={headerRight} />
        <main id="main" className={cn("flex-1", mainClassName ?? "p-4 lg:p-8")}>{children}</main>
      </div>
    </div>
  )
}
