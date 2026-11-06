import { ButtonLink } from "@/components/ui/Button"
import { PublicFooter } from "@/components/layout/PublicFooter"
import { Logo } from "@/components/brand/Logo"

export default function NotFound() {
  return (
    <div className="flex min-h-screen flex-col bg-[var(--color-canvas)]">
      <main className="flex flex-1 flex-col items-center justify-center px-4 py-16 text-center">
        <Logo size="md" />
        <p className="mt-10 text-sm font-semibold text-[var(--color-teal-dark)]">404</p>
        <h1 className="mt-2 text-2xl font-semibold text-[var(--color-ink)]">Page not found</h1>
        <p className="mt-2 max-w-sm text-[var(--color-ink-muted)]">The page you're looking for doesn't exist or may have moved.</p>
        <div className="mt-6 flex flex-wrap justify-center gap-3">
          <ButtonLink to="/">Back to home</ButtonLink>
          <ButtonLink to="/login" variant="outline">Log in</ButtonLink>
        </div>
      </main>
      <PublicFooter compact />
    </div>
  )
}
