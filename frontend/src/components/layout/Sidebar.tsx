import { useEffect, useRef } from "react"
import { NavLink } from "react-router-dom"
import { Home, BookOpen, Settings, LayoutDashboard, LogOut, X } from "lucide-react"
import { Avatar } from "@/components/ui/Avatar"
import { Logo } from "@/components/brand/Logo"
import { cn } from "@/lib/utils"
import type { Course, Role } from "@/types"

export interface SidebarProps {
  role: Role
  userName: string
  userEmail: string
  courses: Course[]
  open: boolean
  onClose: () => void
  onSignOut?: () => void
}

const studentIconFor = (key: string) => {
  switch (key) {
    case "home":
      return Home
    case "courses":
      return BookOpen
    default:
      return Settings
  }
}

export function Sidebar({ role, userName, userEmail, courses, open, onClose, onSignOut }: SidebarProps) {
  const base = role === "student" ? "/student" : "/teacher"

  const drawer = useRef<HTMLElement>(null)
  const closeButton = useRef<HTMLButtonElement>(null)

  // Mobile drawer behaviour: Escape closes it, focus moves in when it opens and stays inside, and returns to the menu button on close.
  useEffect(() => {
    if (!open) return
    const opener = document.activeElement as HTMLElement | null
    // The drawer is still visibility:hidden on the first frame of its open transition, and hidden elements cannot take focus, so retry for a few frames.
    let frames = 0
    let raf = 0
    const focusClose = () => {
      closeButton.current?.focus()
      if (document.activeElement !== closeButton.current && frames++ < 12) raf = requestAnimationFrame(focusClose)
    }
    focusClose()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") return onClose()
      if (e.key !== "Tab" || !drawer.current) return
      const items = Array.from(drawer.current.querySelectorAll<HTMLElement>("a[href], button:not([disabled])")).filter((el) => el.offsetParent !== null)
      if (items.length === 0) return
      const first = items[0]
      const last = items[items.length - 1]
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
    }
    window.addEventListener("keydown", onKey)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener("keydown", onKey)
      opener?.focus?.()
    }
  }, [open, onClose])

  return (
    <>
      {open && (
        <div
          className="fixed inset-0 z-30 bg-black/30 lg:hidden"
          onClick={onClose}
          aria-hidden
        />
      )}
      <aside
        ref={drawer}
        // Closed on a phone the drawer is off-screen: `invisible` also takes its links out of the tab order.
        className={cn(
          "fixed inset-y-0 left-0 z-40 flex w-72 shrink-0 flex-col border-r border-[var(--color-border)] bg-white p-4 transition-[transform,visibility] duration-200 motion-reduce:transition-none lg:sticky lg:top-0 lg:z-auto lg:h-dvh lg:translate-x-0 lg:self-start",
          open ? "translate-x-0" : "-translate-x-full max-lg:invisible"
        )}
        aria-label="Sidebar"
        role={open ? "dialog" : undefined}
        aria-modal={open ? true : undefined}
      >
        <div className="mb-6 flex items-center justify-between px-1">
          <NavLink to={base} aria-label="SocratiQ home" className="rounded-[var(--radius-sm)]">
            <Logo size="md" />
          </NavLink>
          <button ref={closeButton} className="rounded-[var(--radius-sm)] p-2.5 text-[var(--color-ink-muted)] hover:bg-[var(--color-surface-muted)] lg:hidden" onClick={onClose} aria-label="Close menu">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="mb-4 flex items-center gap-3 rounded-[var(--radius-md)] bg-[var(--color-slate-light)]/60 p-3">
          <Avatar name={userName} />
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-[var(--color-ink)]">{userName}</p>
            <p className="truncate text-xs text-[var(--color-ink-muted)]">{userEmail}</p>
          </div>
        </div>

        <nav aria-label="Main" className="min-h-0 flex-1 space-y-1 overflow-y-auto thin-scroll">
          {role === "student" ? (
            <NavItem to="/student" end icon={studentIconFor("home")} label="Home" onClick={onClose} />
          ) : (
            <NavItem to="/teacher" end icon={LayoutDashboard} label="Dashboard" onClick={onClose} />
          )}

          <div>
            <NavItem to={`${base}/courses`} icon={BookOpen} label="Courses" onClick={onClose} />
            <div className="mt-1 space-y-1">
              {courses.map((c) => (
                <NavItem
                  key={c.id}
                  to={`${base}/courses/${c.id}`}
                  icon={BookOpen}
                  label={c.name}
                  onClick={onClose}
                  indent
                />
              ))}
            </div>
          </div>

          <NavItem to={`${base}/settings`} icon={Settings} label="Settings" onClick={onClose} />
        </nav>
        {onSignOut && (
          <div className="mt-2 shrink-0 border-t border-[var(--color-border)] pt-2">
            <button
              type="button"
              onClick={onSignOut}
              className="flex w-full items-center gap-2.5 rounded-[var(--radius-md)] px-3 py-2 text-sm font-medium text-[var(--color-ink-muted)] transition-colors hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-ink)]"
            >
              <LogOut className="h-4 w-4 shrink-0" aria-hidden="true" />
              <span>Log out</span>
            </button>
          </div>
        )}
      </aside>
    </>
  )
}

function NavItem({
  to,
  icon: Icon,
  label,
  end,
  indent,
  onClick,
}: {
  to: string
  icon: typeof Home
  label: string
  end?: boolean
  indent?: boolean
  onClick?: () => void
}) {
  return (
    <NavLink
      to={to}
      end={end}
      onClick={onClick}
      className={({ isActive }) =>
        cn(
          "flex items-center gap-2.5 rounded-[var(--radius-md)] px-3 py-2 text-sm font-medium transition-colors",
          indent && "pl-7",
          isActive
            ? "bg-[var(--color-plum)] font-semibold text-[var(--color-on-plum)]"
            : "text-[var(--color-ink-muted)] hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-ink)]"
        )
      }
    >
      {indent ? (
        <span className="flex h-4 w-4 shrink-0 items-center justify-center" aria-hidden="true"><span className="h-1.5 w-1.5 rounded-full bg-current opacity-60" /></span>
      ) : (
        <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
      )}
      <span className="truncate">{label}</span>
    </NavLink>
  )
}
