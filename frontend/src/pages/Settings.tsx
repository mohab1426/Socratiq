import { AppShell } from "@/components/layout/AppShell"
import { Card, CardContent } from "@/components/ui/Card"
import { Input } from "@/components/ui/Input"
import { Field } from "@/components/ui/Field"
import { Button } from "@/components/ui/Button"
import { useAuth } from "@/lib/auth"
import type { Role } from "@/types"

export default function Settings({ role }: { role: Role }) {
  const { me, signOut } = useAuth()

  return (
    <AppShell role={role} crumbs={[{ label: role === "student" ? "Home" : "Dashboard", to: role === "student" ? "/student" : "/teacher" }, { label: "Settings" }]}>
      <Card className="max-w-lg">
        <CardContent className="space-y-4">
          <h1 className="text-lg font-semibold text-[var(--color-ink)]">Account</h1>
          <Field id="account-name" label="Name">
            <Input id="account-name" value={me?.name ?? ""} readOnly />
          </Field>
          <Field id="account-email" label="Email">
            <Input id="account-email" value={me?.email ?? ""} readOnly type="email" />
          </Field>
          <p className="text-xs text-[var(--color-ink-muted)]">Your name and email come from your account. Ask your institution's administrator to change them.</p>
          <Button variant="outline" onClick={signOut}>Log out</Button>
        </CardContent>
      </Card>
    </AppShell>
  )
}
