import { useEffect, useState, type FormEvent } from "react"
import { useNavigate } from "react-router-dom"
import { AuthLayout } from "@/components/layout/AuthLayout"
import { Input, Select } from "@/components/ui/Input"
import { Button } from "@/components/ui/Button"
import { homeFor, useAuth } from "@/lib/auth"
import { fetchUniversities } from "@/lib/queries"
import { ApiError } from "@/lib/api"
import { Field } from "@/components/ui/Field"
import { fieldProps } from "@/components/ui/fieldProps"

/** Shown when someone is signed in (e.g. after confirming their email) but has no application profile yet. */
export default function CompleteProfile() {
  const navigate = useNavigate()
  const { status, me, completeProfile, signOut } = useAuth()
  const [universities, setUniversities] = useState<{ id: string; name: string }[]>([])
  const [v, setV] = useState({ firstName: "", lastName: "", role: "STUDENT", universityId: "" })
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    fetchUniversities().then((r) => setUniversities(r.universities)).catch(() => undefined)
  }, [])
  useEffect(() => {
    if (status === "ready" && me) navigate(homeFor(me.role), { replace: true })
    if (status === "signed_out") navigate("/login", { replace: true })
  }, [status, me, navigate])

  async function submit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    if (!v.firstName.trim() || !v.lastName.trim()) return setError("Enter your first and last name.")
    if (!v.universityId) return setError("Choose your university.")
    setBusy(true)
    try {
      await completeProfile({ firstName: v.firstName.trim(), lastName: v.lastName.trim(), role: v.role as "STUDENT" | "PROFESSOR", universityId: v.universityId })
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "We couldn't finish setting up your account.")
      setBusy(false)
    }
  }

  return (
    <AuthLayout wide>
      <h1 className="text-center text-lg font-semibold text-[var(--color-ink)]">Finish setting up your account</h1>
      <form className="mt-6 space-y-4" onSubmit={submit} noValidate>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field id="cp-first" label="First name">
            <Input {...fieldProps("cp-first")} autoComplete="given-name" value={v.firstName} onChange={(e) => setV({ ...v, firstName: e.target.value })} />
          </Field>
          <Field id="cp-last" label="Last name">
            <Input {...fieldProps("cp-last")} autoComplete="family-name" value={v.lastName} onChange={(e) => setV({ ...v, lastName: e.target.value })} />
          </Field>
        </div>
        <Field id="cp-role" label="I am a">
          <Select {...fieldProps("cp-role")} value={v.role} onChange={(e) => setV({ ...v, role: e.target.value })}>
            <option value="STUDENT">Student</option>
            <option value="PROFESSOR">Instructor</option>
          </Select>
        </Field>
        <Field id="cp-uni" label="University">
          <Select {...fieldProps("cp-uni")} value={v.universityId} onChange={(e) => setV({ ...v, universityId: e.target.value })}>
            <option value="">Select your university…</option>
            {universities.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </Select>
        </Field>
        {error && (
          <p role="alert" className="rounded-[var(--radius-md)] bg-[var(--color-danger-light)] px-3 py-2 text-sm text-[var(--color-danger-ink)]">
            {error}
          </p>
        )}
        <div className="flex items-center justify-between pt-1">
          <button type="button" onClick={signOut} className="text-sm font-medium text-[var(--color-ink-muted)] hover:text-[var(--color-ink)] hover:underline">
            Log out
          </button>
          <Button type="submit" disabled={busy}>
            {busy ? "Saving…" : "Continue"}
          </Button>
        </div>
      </form>
    </AuthLayout>
  )
}
