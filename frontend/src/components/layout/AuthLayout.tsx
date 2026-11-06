import type { ReactNode } from "react"
import { Link } from "react-router-dom"
import { Logo } from "@/components/brand/Logo"
import { PublicFooter } from "./PublicFooter"
import { cn } from "@/lib/utils"

export function AuthLayout({ children, wide = false }: { children: ReactNode; wide?: boolean }) {
  return (
    <div className="flex min-h-screen flex-col">
      <main className="flex flex-1 items-center justify-center bg-gradient-to-br from-[var(--color-plum-light)] via-[var(--color-canvas)] to-[var(--color-teal-light)] px-4 py-10">
        <div className={cn("w-full rounded-[var(--radius-xl)] bg-white p-6 shadow-sm sm:p-8", wide ? "max-w-md" : "max-w-sm")}>
          <div className="mb-6 flex justify-center">
            <Link to="/" aria-label="SocratiQ home" className="rounded-[var(--radius-sm)]">
              <Logo size="md" />
            </Link>
          </div>
          {children}
        </div>
      </main>
      <PublicFooter compact />
    </div>
  )
}
