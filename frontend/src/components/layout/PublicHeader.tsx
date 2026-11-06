import { useEffect, useState } from "react"
import { Link } from "react-router-dom"
import { Logo } from "@/components/brand/Logo"
import { ButtonLink } from "@/components/ui/Button"
import { cn } from "@/lib/utils"

const links = [
  { label: "How it works", hash: "how-it-works" },
  { label: "Students", hash: "students" },
  { label: "Teachers", hash: "teachers" },
  { label: "Evidence", hash: "evidence" },
]

/** Sticky public header. Anchor links point at real sections on the landing page. */
export function PublicHeader() {
  const [scrolled, setScrolled] = useState(false)
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8)
    onScroll()
    window.addEventListener("scroll", onScroll, { passive: true })
    return () => window.removeEventListener("scroll", onScroll)
  }, [])

  return (
    <header className={cn("sticky top-0 z-30 bg-[var(--color-canvas)] transition-shadow duration-200", scrolled && "shadow-[0_1px_0_var(--color-border-strong)]")}>
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-2 px-4 py-3 sm:gap-4 sm:px-6 sm:py-4 lg:px-10">
        <Link to="/" aria-label="SocratiQ home" className="rounded-[var(--radius-sm)]">
          <Logo size="lg" />
        </Link>
        <nav aria-label="Primary" className="flex shrink-0 items-center gap-1 sm:gap-2">
          <ul className="mr-2 hidden items-center gap-1 lg:flex">
            {links.map((l) => (
              <li key={l.hash}>
                <Link
                  to={{ pathname: "/", hash: l.hash }}
                  className="inline-flex min-h-10 items-center rounded-full px-3 text-sm font-medium text-[var(--color-ink-muted)] transition-colors hover:bg-white/70 hover:text-[var(--color-ink)]"
                >
                  {l.label}
                </Link>
              </li>
            ))}
          </ul>
          <ButtonLink to="/login" variant="ghost" size="md" className="px-2.5 text-[var(--color-ink)] sm:border sm:border-[color:var(--color-ink)] sm:bg-transparent sm:px-4 sm:hover:bg-white/60">
              Log in
            </ButtonLink>
          <ButtonLink to="/signup" size="md" className="px-3.5 sm:px-4">Sign up</ButtonLink>
        </nav>
      </div>
    </header>
  )
}
