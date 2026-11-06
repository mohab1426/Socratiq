import { useEffect, useRef, useState, type FormEvent } from "react"
import { Link, useNavigate } from "react-router-dom"
import { Loader2, MailCheck } from "lucide-react"
import { AuthLayout } from "@/components/layout/AuthLayout"
import { Input, Select } from "@/components/ui/Input"
import { PasswordInput } from "@/components/ui/PasswordInput"
import { Field } from "@/components/ui/Field"
import { fieldProps } from "@/components/ui/fieldProps"
import { Button, ButtonLink } from "@/components/ui/Button"
import { homeFor, useAuth } from "@/lib/auth"
import { fetchUniversities } from "@/lib/queries"
import type { Role } from "@/types"

type Values = { firstName: string; lastName: string; email: string; universityId: string; password: string; confirm: string }
type Errors = Partial<Record<keyof Values, string>>

const ORDER: (keyof Values)[] = ["firstName", "lastName", "email", "universityId", "password", "confirm"]

function validate(v: Values): Errors {
  const e: Errors = {}
  if (!v.firstName.trim()) e.firstName = "Enter your first name."
  if (!v.lastName.trim()) e.lastName = "Enter your last name."
  if (!v.email.trim()) e.email = "Enter your email address."
  else if (!/^\S+@\S+\.\S+$/.test(v.email.trim())) e.email = "Enter a valid email address, like name@university.edu."
  if (!v.universityId) e.universityId = "Choose your university."
  if (!v.password) e.password = "Choose a password."
  else if (v.password.length < 8) e.password = "Use a password of at least 8 characters."
  if (!v.confirm) e.confirm = "Type your password again to confirm it."
  else if (v.password && v.confirm !== v.password) e.confirm = "Passwords don't match."
  return e
}

export function SignupForm({ role }: { role: Role }) {
  const navigate = useNavigate()
  const { signUp, status, me } = useAuth()
  const formRef = useRef<HTMLFormElement>(null)
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [errors, setErrors] = useState<Errors>({})
  const [confirmEmail, setConfirmEmail] = useState(false)
  const [universities, setUniversities] = useState<{ id: string; name: string }[]>([])
  const [values, setValues] = useState<Values>({ firstName: "", lastName: "", email: "", universityId: "", password: "", confirm: "" })

  useEffect(() => {
    fetchUniversities().then((r) => setUniversities(r.universities)).catch(() => setFormError("We couldn't load the list of universities. Refresh to try again."))
  }, [])

  useEffect(() => {
    if (status === "ready" && me) navigate(homeFor(me.role), { replace: true })
  }, [status, me, navigate])

  function update(key: keyof Values) {
    return (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
      setValues((v) => ({ ...v, [key]: e.target.value }))
      if (errors[key]) setErrors((er) => ({ ...er, [key]: undefined }))   // clear a field's message as soon as it's being fixed
    }
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setFormError(null)
    const found = validate(values)
    setErrors(found)
    const firstBad = ORDER.find((k) => found[k])
    if (firstBad) {
      formRef.current?.querySelector<HTMLElement>(`#${role}-${firstBad}`)?.focus()
      return
    }
    setSubmitting(true)
    try {
      // Same contract as before: first/last name go to the API as separate fields.
      const outcome = await signUp(values.email.trim(), values.password, {
        firstName: values.firstName.trim(),
        lastName: values.lastName.trim(),
        role: role === "teacher" ? "PROFESSOR" : "STUDENT",
        universityId: values.universityId,
      })
      if (outcome === "confirm_email") setConfirmEmail(true)
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "We couldn't create your account.")
    } finally {
      setSubmitting(false)
    }
  }

  if (confirmEmail) {
    return (
      <AuthLayout>
        <div role="status" className="flex flex-col items-center py-2 text-center">
          <MailCheck className="h-9 w-9 text-[var(--color-teal-dark)]" aria-hidden="true" />
          <h1 className="mt-3 text-lg font-semibold text-[var(--color-ink)]">Confirm your email</h1>
          <p className="mt-1 text-sm text-[var(--color-ink-muted)]">
            We sent a link to <span className="font-medium text-[var(--color-ink)]">{values.email}</span>. Open it, then log in to finish setting up your account.
          </p>
          <ButtonLink to="/login" size="sm" className="mt-5">Go to log in</ButtonLink>
        </div>
      </AuthLayout>
    )
  }

  const id = (k: keyof Values) => `${role}-${k}`
  return (
    <AuthLayout wide>
      <h1 className="text-center text-lg font-semibold text-[var(--color-ink)]">Sign up as {role === "teacher" ? "a teacher" : "a student"}</h1>
      <form ref={formRef} className="mt-6" onSubmit={handleSubmit} noValidate>
        <fieldset disabled={submitting} className="space-y-4 disabled:opacity-80">
          <legend className="sr-only">Create your account</legend>

          {/* side by side from the sm breakpoint up, stacked on phones */}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id={id("firstName")} label="First name" error={errors.firstName}>
              <Input {...fieldProps(id("firstName"), errors.firstName)} autoComplete="given-name" value={values.firstName} onChange={update("firstName")} />
            </Field>
            <Field id={id("lastName")} label="Last name" error={errors.lastName}>
              <Input {...fieldProps(id("lastName"), errors.lastName)} autoComplete="family-name" value={values.lastName} onChange={update("lastName")} />
            </Field>
          </div>

          <Field id={id("email")} label="Email" error={errors.email}>
            <Input {...fieldProps(id("email"), errors.email)} type="email" autoComplete="email" value={values.email} onChange={update("email")} />
          </Field>

          <Field id={id("universityId")} label="University" error={errors.universityId}>
            <Select {...fieldProps(id("universityId"), errors.universityId)} value={values.universityId} onChange={update("universityId")}>
              <option value="">Select your university…</option>
              {universities.map((u) => (
                <option key={u.id} value={u.id}>{u.name}</option>
              ))}
            </Select>
          </Field>

          <Field id={id("password")} label="Password" error={errors.password} hint="At least 8 characters.">
            <PasswordInput {...fieldProps(id("password"), errors.password, true)} autoComplete="new-password" value={values.password} onChange={update("password")} />
          </Field>

          <Field id={id("confirm")} label="Confirm password" error={errors.confirm}>
            <PasswordInput {...fieldProps(id("confirm"), errors.confirm)} autoComplete="new-password" value={values.confirm} onChange={update("confirm")} />
          </Field>

        </fieldset>

        {formError && (
          <p role="alert" className="mt-4 rounded-[var(--radius-md)] bg-[var(--color-danger-light)] px-3 py-2 text-sm text-[var(--color-danger-ink)]">
            {formError}
          </p>
        )}

        <div className="mt-6 flex items-center justify-between gap-3">
          <Link to="/signup" className="inline-flex min-h-8 items-center text-sm font-medium text-[var(--color-ink-muted)] hover:text-[var(--color-ink)] hover:underline">
            Choose a different role
          </Link>
          <Button type="submit" disabled={submitting} aria-busy={submitting} className="min-w-36">
            {submitting ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Creating account…
              </>
            ) : (
              "Create account"
            )}
          </Button>
        </div>

        <p className="mt-5 text-center text-sm text-[var(--color-ink-muted)]">
          Already have an account?{" "}
          <Link to="/login" className="font-semibold text-[var(--color-ink)] underline-offset-4 hover:underline">Log in</Link>
        </p>
      </form>
    </AuthLayout>
  )
}
