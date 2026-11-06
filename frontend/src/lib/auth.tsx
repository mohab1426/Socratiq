import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { Navigate, useLocation } from "react-router-dom"
import type { Session } from "@supabase/supabase-js"
import { supabase, isConfigured } from "./supabase"
import { api, ApiError } from "./api"
import type { Role } from "@/types"

export interface Me {
  id: string
  name: string
  email: string
  role: Role
  universityId: string
  firstName?: string | null
  lastName?: string | null
}

export interface PendingProfile {
  firstName: string
  lastName: string
  role: "STUDENT" | "PROFESSOR"
  universityId: string
}

type Status = "loading" | "signed_out" | "needs_profile" | "ready" | "error"

interface AuthValue {
  status: Status
  me: Me | null
  error: string | null
  signIn: (email: string, password: string) => Promise<void>
  /** Returns "signed_in" or "confirm_email" (project requires email confirmation before a session exists). */
  signUp: (email: string, password: string, profile: PendingProfile) => Promise<"signed_in" | "confirm_email">
  completeProfile: (p: PendingProfile) => Promise<void>
  signOut: () => Promise<void>
  resetPassword: (email: string) => Promise<void>
}

const AuthContext = createContext<AuthValue | null>(null)
const PENDING_KEY = "socratiq.pendingProfile"   // profile fields only; the password is never stored

export function homeFor(role: Role) {
  return role === "teacher" ? "/teacher" : "/student"
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>(isConfigured ? "loading" : "error")
  const [me, setMe] = useState<Me | null>(null)
  const [error, setError] = useState<string | null>(isConfigured ? null : "This deployment is missing its Supabase settings (VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY).")
  const loading = useRef(false)

  const load = useCallback(async (session: Session | null) => {
    if (!session) {
      setMe(null)
      setStatus("signed_out")
      return
    }
    if (loading.current) return
    loading.current = true
    try {
      setMe(await api<Me>("/me"))
      setStatus("ready")
    } catch (e) {
      if (e instanceof ApiError && e.code === "profile_required") {
        const pending = localStorage.getItem(PENDING_KEY)
        if (pending) {
          try {
            await createProfile(JSON.parse(pending) as PendingProfile)
            localStorage.removeItem(PENDING_KEY)
            setMe(await api<Me>("/me"))
            setStatus("ready")
            return
          } catch (err) {
            setError(err instanceof ApiError ? err.message : "We couldn't finish setting up your account.")
          }
        }
        setMe(null)
        setStatus("needs_profile")
      } else if (e instanceof ApiError && e.status === 401) {
        await supabase.auth.signOut()
        setMe(null)
        setStatus("signed_out")
      } else {
        setError(e instanceof ApiError ? e.message : "Something went wrong.")
        setStatus("error")
      }
    } finally {
      loading.current = false
    }
  }, [])

  useEffect(() => {
    if (!isConfigured) return
    supabase.auth.getSession().then(({ data }) => load(data.session))
    const { data: sub } = supabase.auth.onAuthStateChange((_evt, session) => {
      void load(session)
    })
    return () => sub.subscription.unsubscribe()
  }, [load])

  const value = useMemo<AuthValue>(() => ({
    status, me, error,
    async signIn(email, password) {
      const { error: err } = await supabase.auth.signInWithPassword({ email, password })
      if (err) throw new Error(err.message === "Invalid login credentials" ? "That email and password don't match." : err.message)
    },
    async signUp(email, password, profile) {
      const { data, error: err } = await supabase.auth.signUp({ email, password })
      if (err) throw new Error(err.message)
      localStorage.setItem(PENDING_KEY, JSON.stringify(profile))
      return data.session ? "signed_in" : "confirm_email"
    },
    async completeProfile(p) {
      await createProfile(p)
      localStorage.removeItem(PENDING_KEY)
      setMe(await api<Me>("/me"))
      setStatus("ready")
    },
    async signOut() {
      await supabase.auth.signOut()
      setMe(null)
      setStatus("signed_out")
    },
    async resetPassword(email) {
      const { error: err } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: `${window.location.origin}/login` })
      if (err) throw new Error(err.message)
    },
  }), [status, me, error])

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

async function createProfile(p: PendingProfile) {
  await api("/auth/profile", {
    method: "POST",
    body: { first_name: p.firstName, last_name: p.lastName, role: p.role, university_id: p.universityId },
  })
}

export function useAuth(): AuthValue {
  const v = useContext(AuthContext)
  if (!v) throw new Error("useAuth must be used inside <AuthProvider>")
  return v
}

/** Route guard. Role is enforced by the backend as well; this only decides which UI to show. */
export function RequireAuth({ role, children }: { role: Role; children: ReactNode }) {
  const { status, me, error } = useAuth()
  const loc = useLocation()
  if (status === "loading") return <div className="flex min-h-screen items-center justify-center text-sm text-[var(--color-ink-soft)]">Loading…</div>
  if (status === "error") return <div className="flex min-h-screen items-center justify-center p-6 text-center text-sm text-[var(--color-danger-ink)]">{error}</div>
  if (status === "signed_out") return <Navigate to="/login" replace state={{ from: loc.pathname }} />
  if (status === "needs_profile") return <Navigate to="/complete-profile" replace />
  if (me && me.role !== role) return <Navigate to={homeFor(me.role)} replace />
  return <>{children}</>
}
