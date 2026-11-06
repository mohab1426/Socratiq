import { useEffect, useState, type FormEvent } from "react"
import { Link, useLocation, useNavigate } from "react-router-dom"
import { AuthLayout } from "@/components/layout/AuthLayout"
import { Input } from "@/components/ui/Input"
import { PasswordInput } from "@/components/ui/PasswordInput"
import { Field } from "@/components/ui/Field"
import { fieldProps } from "@/components/ui/fieldProps"
import { Button } from "@/components/ui/Button"
import { homeFor, useAuth } from "@/lib/auth"

export default function Login() {
  const navigate = useNavigate()
  const location = useLocation()
  const { status, me, signIn } = useAuth()
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")

  // Once the session AND the application profile are loaded, go where the account's real role belongs.
  useEffect(() => {
    if (status === "ready" && me) {
      const from = (location.state as { from?: string } | null)?.from
      navigate(from && from.startsWith(`/${me.role}`) ? from : homeFor(me.role), { replace: true })
    } else if (status === "needs_profile") {
      navigate("/complete-profile", { replace: true })
    }
  }, [status, me, navigate, location.state])

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    if (!email || !password) {
      setError("Enter your email and password.")
      return
    }
    setSubmitting(true)
    try {
      await signIn(email.trim(), password)
    } catch (err) {
      setError(err instanceof Error ? err.message : "We couldn't log you in.")
      setSubmitting(false)
    }
  }

  return (
    <AuthLayout>
      <h1 className="text-center text-lg font-semibold text-[var(--color-ink)]">Log in</h1>
      <form className="mt-6 space-y-4" onSubmit={handleSubmit} noValidate>
        <Field id="login-email" label="Email">
          <Input {...fieldProps("login-email")} type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field id="login-password" label="Password">
          <PasswordInput {...fieldProps("login-password")} autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>

        {error && (
          <p role="alert" className="rounded-[var(--radius-md)] bg-[var(--color-danger-light)] px-3 py-2 text-sm text-[var(--color-danger-ink)]">
            {error}
          </p>
        )}

        <div className="flex justify-end">
          <Link to="/login/forgot" className="inline-flex min-h-8 items-center text-sm font-medium text-[var(--color-ink)] underline-offset-4 hover:underline">
            Forgot password?
          </Link>
        </div>

        <div className="flex items-center justify-between gap-3 pt-1">
          <Link to="/" className="inline-flex min-h-8 items-center text-sm font-medium text-[var(--color-ink-muted)] hover:text-[var(--color-ink)] hover:underline">
            Back to home
          </Link>
          <Button type="submit" disabled={submitting} aria-busy={submitting}>
            {submitting ? "Logging in…" : "Log in"}
          </Button>
        </div>

        <p className="text-center text-sm text-[var(--color-ink-muted)]">
          New to SocratiQ?{" "}
          <Link to="/signup" className="font-semibold text-[var(--color-ink)] underline-offset-4 hover:underline">Sign up</Link>
        </p>
      </form>
    </AuthLayout>
  )
}
