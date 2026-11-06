/**
 * Autosave state machine for the board. Pure (timers are injectable) so every transition is unit-tested without a browser.
 *
 * Guarantees:
 *  - edits are debounced, but never starved: a save happens within `maxWaitMs` of the first unsaved edit;
 *  - at most ONE save is in flight; an edit made while saving triggers exactly one follow-up save (nothing is lost, nothing is duplicated);
 *  - transient failures (network, 5xx) retry with backoff; permanent ones (413 too large, 422 invalid, 403/409 closed) stop and say why;
 *  - `flush()` resolves true only if the latest edit is really on the server.
 */
export type SaveStatus = "idle" | "dirty" | "saving" | "saved" | "error" | "offline"
export interface SaveState { status: SaveStatus; savedAt: number | null; error: string | null; permanent: boolean; retryInMs: number | null }

export interface AutosaveOptions {
  save: () => Promise<void>
  debounceMs?: number
  maxWaitMs?: number
  retryMs?: number[]
  isOffline?: () => boolean
  isPermanent?: (e: unknown) => boolean
  describe?: (e: unknown) => string
  now?: () => number
}

export interface Autosaver {
  markDirty(): void
  flush(): Promise<boolean>
  getState(): SaveState
  subscribe(fn: (s: SaveState) => void): () => void
  dispose(): void
}

export function createAutosaver(o: AutosaveOptions): Autosaver {
  const debounceMs = o.debounceMs ?? 1500
  const maxWaitMs = o.maxWaitMs ?? 10_000
  const retry = o.retryMs ?? [2000, 5000, 15_000]
  const now = o.now ?? Date.now
  let state: SaveState = { status: "idle", savedAt: null, error: null, permanent: false, retryInMs: null }
  const subs = new Set<(s: SaveState) => void>()
  let version = 0, savedVersion = 0, firstDirtyAt = 0, failures = 0, disposed = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let inflight: Promise<boolean> | null = null

  const set = (p: Partial<SaveState>) => { state = { ...state, ...p }; subs.forEach((f) => f(state)) }
  const clear = () => { if (timer) { clearTimeout(timer); timer = null } }
  const schedule = (ms: number) => { clear(); if (!disposed) timer = setTimeout(() => void run(), Math.max(0, ms)) }

  async function run(): Promise<boolean> {
    if (disposed) return false
    if (inflight) return inflight
    clear()
    inflight = (async () => {
      let ok = true
      while (version !== savedVersion && !disposed) {
        const startVersion = version
        set({ status: "saving", error: null, retryInMs: null })
        try {
          await o.save()
          savedVersion = startVersion
          failures = 0
          if (version === savedVersion) { firstDirtyAt = 0; set({ status: "saved", savedAt: now(), error: null, permanent: false, retryInMs: null }) }
          // else: edited while saving -> loop once more with the newest state
        } catch (e) {
          ok = false
          const permanent = o.isPermanent?.(e) ?? false
          const wait = permanent ? null : retry[Math.min(failures, retry.length - 1)]
          failures++
          set({ status: !permanent && o.isOffline?.() ? "offline" : "error", error: o.describe?.(e) ?? (e instanceof Error ? e.message : "Could not save"), permanent, retryInMs: wait })
          if (wait !== null) schedule(wait)
          break
        }
      }
      return ok
    })().finally(() => { inflight = null })
    return inflight
  }

  return {
    markDirty() {
      if (disposed) return
      version++
      if (!firstDirtyAt) firstDirtyAt = now()
      if (state.permanent) set({ permanent: false })                       // the student changed something: a new save may succeed now
      if (inflight) return                                                 // the running save loop will pick this edit up
      if (state.status !== "error" && state.status !== "offline") set({ status: "dirty" })
      schedule(Math.min(debounceMs, Math.max(0, firstDirtyAt + maxWaitMs - now())))
    },
    async flush() {
      if (disposed) return false
      clear()
      if (inflight) await inflight
      if (version === savedVersion) return true
      failures = 0
      return run()
    },
    getState: () => state,
    subscribe(fn) { subs.add(fn); fn(state); return () => { subs.delete(fn) } },
    dispose() { disposed = true; clear(); subs.clear() },
  }
}
