import { useState, type FormEvent } from "react"
import { useNavigate } from "react-router-dom"
import { AppShell } from "@/components/layout/AppShell"
import { Card, CardContent } from "@/components/ui/Card"
import { Input } from "@/components/ui/Input"
import { Button } from "@/components/ui/Button"
import { ApiError } from "@/lib/api"
import { useJoinCourse } from "@/lib/queries"

export default function JoinCourse() {
  const navigate = useNavigate()
  const join = useJoinCourse()
  const [code, setCode] = useState("")
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    if (!code.trim()) {
      setError("Enter the invite code your instructor shared.")
      return
    }
    try {
      const course = await join.mutateAsync(code)
      navigate(`/student/courses/${course.id}`)
    } catch (err) {
      setError(err instanceof ApiError ? (err.details?.[0]?.message ?? err.message) : "We couldn't join that course. Try again.")
    }
  }

  return (
    <AppShell role="student" crumbs={[{ label: "Home", to: "/student" }, { label: "Join a course" }]}>
      <h1 className="text-xl font-semibold text-[var(--color-ink)]">Join a course</h1>
      <p className="mt-1 text-sm text-[var(--color-ink-soft)]">Enter the invite code your instructor shared to add their course to your list.</p>

      <Card className="mt-6 max-w-md">
        <CardContent>
          <form className="space-y-4" onSubmit={handleSubmit} noValidate>
            <div>
              <label htmlFor="invite" className="mb-1 block text-sm font-medium text-[var(--color-ink-soft)]">Invite code</label>
              <Input id="invite" placeholder="e.g. K7M4-9QXA" autoComplete="off" spellCheck={false} value={code} onChange={(e) => setCode(e.target.value)} className="uppercase" />
            </div>

            {error && (
              <p role="alert" className="text-sm text-[var(--color-danger-ink)]">
                {error}
              </p>
            )}

            <div className="flex items-center justify-between pt-1">
              <Button type="button" variant="outline" onClick={() => navigate(-1)}>
                Cancel
              </Button>
              <Button type="submit" disabled={join.isPending}>
                {join.isPending ? "Joining…" : "Join course"}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </AppShell>
  )
}
