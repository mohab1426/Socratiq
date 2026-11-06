import { Link } from "react-router-dom"
import { GraduationCap, School } from "lucide-react"
import { AuthLayout } from "@/components/layout/AuthLayout"
import { ButtonLink } from "@/components/ui/Button"

export default function ChooseSignup() {
  return (
    <AuthLayout>
      <h1 className="text-center text-lg font-semibold text-[var(--color-ink)]">Choose what to sign up as</h1>
      <div className="mt-6 space-y-3">
        <ButtonLink to="/signup/student" variant="outline" size="lg" className="w-full">
          <GraduationCap className="h-4 w-4" aria-hidden="true" /> Sign up as student
        </ButtonLink>
        <ButtonLink to="/signup/teacher" variant="outline" size="lg" className="w-full">
          <School className="h-4 w-4" aria-hidden="true" /> Sign up as teacher
        </ButtonLink>
      </div>
      <p className="mt-6 text-center text-sm text-[var(--color-ink-muted)]">
        Already have an account?{" "}
        <Link to="/login" className="font-semibold text-[var(--color-ink)] underline-offset-4 hover:underline">Log in</Link>
      </p>
      <p className="mt-2 text-center text-sm">
        <Link to="/" className="inline-flex min-h-8 items-center font-medium text-[var(--color-ink-muted)] hover:text-[var(--color-ink)] hover:underline">Back to home</Link>
      </p>
    </AuthLayout>
  )
}
