import { Link } from "react-router-dom"
import { Logo } from "@/components/brand/Logo"

// Only routes / landing sections that exist. Section links resolve on the landing page (it scrolls to the hash).
const product = [
  { label: "How it works", hash: "how-it-works" },
  { label: "For students", hash: "students" },
  { label: "For teachers", hash: "teachers" },
  { label: "Learning evidence", hash: "evidence" },
]

const linkClass = "inline-block py-1 text-sm text-[var(--color-canvas)]/80 underline-offset-4 transition-colors hover:text-white hover:underline"

function Col({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h2 className="text-sm font-semibold text-white">{title}</h2>
      <ul className="mt-3 space-y-2">{children}</ul>
    </div>
  )
}

/** `compact` is the slim one-row version used under auth cards and error pages. */
export function PublicFooter({ compact = false }: { compact?: boolean }) {
  const year = new Date().getFullYear()

  if (compact) {
    return (
      <footer className="bg-[var(--color-ink)] px-6 py-5 text-[var(--color-canvas)]">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-3 sm:flex-row">
          <Link to="/" aria-label="SocratiQ home">
            <Logo size="sm" tone="light" />
          </Link>
          <nav aria-label="Footer" className="flex flex-wrap items-center justify-center gap-x-5 gap-y-1">
            <Link to="/" className={linkClass}>Home</Link>
            <Link to="/login" className={linkClass}>Log in</Link>
            <Link to="/signup" className={linkClass}>Sign up</Link>
          </nav>
          <p className="text-xs text-[var(--color-canvas)]/70">© {year} SocratiQ</p>
        </div>
      </footer>
    )
  }

  return (
    <footer className="bg-[var(--color-ink)] px-6 pb-8 pt-14 text-[var(--color-canvas)] lg:px-10">
      <div className="mx-auto grid max-w-6xl gap-10 sm:grid-cols-2 lg:grid-cols-[1.4fr_1fr_1fr]">
        <div className="max-w-sm">
          <Link to="/" aria-label="SocratiQ home" className="inline-block">
            <Logo size="md" tone="light" />
          </Link>
          <p className="mt-4 text-sm leading-relaxed text-[var(--color-canvas)]/80">
            An AI learning coach for university courses. It asks questions instead of giving answers, and keeps a record of the reasoning behind each piece of work.
          </p>
        </div>

        <Col title="Product">
          {product.map((p) => (
            <li key={p.hash}>
              <Link to={{ pathname: "/", hash: p.hash }} className={linkClass}>{p.label}</Link>
            </li>
          ))}
        </Col>

        <Col title="Get started">
          <li><Link to="/login" className={linkClass}>Log in</Link></li>
          <li><Link to="/signup/student" className={linkClass}>Sign up as a student</Link></li>
          <li><Link to="/signup/teacher" className={linkClass}>Sign up as a teacher</Link></li>
        </Col>
      </div>

      <div className="mx-auto mt-12 flex max-w-6xl flex-col items-start justify-between gap-2 border-t border-white/15 pt-6 text-xs text-[var(--color-canvas)]/70 sm:flex-row sm:items-center">
        <p>© {year} SocratiQ. All rights reserved.</p>
        <a href="mailto:hello@socratiq.app" className="inline-block py-1 underline-offset-4 hover:text-white hover:underline">hello@socratiq.app</a>
      </div>
    </footer>
  )
}
