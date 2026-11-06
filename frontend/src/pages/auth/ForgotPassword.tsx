import { useState, type FormEvent } from "react"
import { Link } from "react-router-dom"
import { AuthLayout } from "@/components/layout/AuthLayout"
import { Input } from "@/components/ui/Input"
import { Field } from "@/components/ui/Field"
import { fieldProps } from "@/components/ui/fieldProps"
import { Button, ButtonLink } from "@/components/ui/Button"
import { MailCheck } from "lucide-react"
import { useAuth } from "@/lib/auth"

export default function ForgotPassword() {
  const { resetPassword } = useAuth()
  const [email, setEmail] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [sent, setSent] = useState(false)

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    if (!email) {
      setError("Enter the email on your account.")
      return
    }
    setSubmitting(true)
    try {
      await resetPassword(email.trim())
      setSent(true)                // same message whether or not the account exists (no account enumeration)
    } catch (err) {
      setError(err instanceof Error ? err.message : "We couldn't send the email. Try again.")
    } finally {
      setSubmitting(false)
    }
  }

  if (sent) {
    return (
      <AuthLayout>
        <div className="flex flex-col items-center py-2 text-center">
          <MailCheck className="h-9 w-9 text-[var(--color-teal-dark)]" aria-hidden="true" />
          <h1 className="mt-3 text-lg font-semibold text-[var(--color-ink)]">Check your email</h1>
          <p className="mt-1 text-sm text-[var(--color-ink-soft)]">
            If an account exists for <span className="font-medium text-[var(--color-ink)]">{email}</span>, a reset
            link is on its way.
          </p>
          <ButtonLink to="/login" size="sm" className="mt-5">Back to log in</ButtonLink>
        </div>
      </AuthLayout>
    )
  }

  return (
    <AuthLayout>
      <h1 className="text-center text-lg font-semibold text-[var(--color-ink)]">Reset your password</h1>
      <p className="mt-2 text-center text-sm text-[var(--color-ink-soft)]">
        Enter your email and we'll send you a link to get back in.
      </p>
      <form className="mt-6 space-y-4" onSubmit={handleSubmit} noValidate>
        <Field id="forgot-email" label="Email">
          <Input {...fieldProps("forgot-email")} type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>

        {error && (
          <p role="alert" className="text-sm text-[var(--color-danger-ink)]">
            {error}
          </p>
        )}

        <div className="flex items-center justify-between pt-1">
          <Link to="/login" className="inline-flex min-h-8 items-center text-sm font-medium text-[var(--color-ink-muted)] hover:text-[var(--color-ink)] hover:underline">
            Back to log in
          </Link>
          <Button type="submit" disabled={submitting} aria-busy={submitting}>
            {submitting ? "Sending…" : "Send reset link"}
          </Button>
        </div>
      </form>
    </AuthLayout>
  )
}
