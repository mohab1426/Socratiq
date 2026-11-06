import { supabase } from "./supabase"

const resolveApiBase = () => {
  const envUrl = import.meta.env.VITE_API_URL
  if (typeof window !== "undefined") {
    const isLocalhost = window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1"
    if (!isLocalhost || !envUrl) {
      return "/api/v1"
    }
  }
  return `${(envUrl ?? "http://localhost:8000").replace(/\/$/, "")}/api/v1`
}

const BASE = resolveApiBase()

export class ApiError extends Error {
  status: number
  code?: string
  requestId?: string
  details?: { field: string; message: string }[]
  constructor(status: number, message: string, code?: string, requestId?: string, details?: ApiError["details"]) {
    super(message)
    this.status = status
    this.code = code
    this.requestId = requestId
    this.details = details
  }
}

/** snake_case -> camelCase for KEYS only (ids and values are never touched), so responses match the frontend types directly. */
const camel = (s: string) => s.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase())
/** Keys whose value is an opaque document owned by another library (the native board scene). Its keys are never rewritten. */
const OPAQUE_KEYS = new Set(["scene"])
export function camelize<T>(value: unknown): T {
  if (Array.isArray(value)) return value.map((v) => camelize(v)) as T
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [camel(k), OPAQUE_KEYS.has(k) ? v : camelize(v)])) as T
  }
  return value as T
}

export async function accessToken(): Promise<string | null> {
  const { data } = await supabase.auth.getSession()
  return data.session?.access_token ?? null
}

async function toError(status: number, body: string): Promise<ApiError> {
  try {
    const e = JSON.parse(body)?.error
    if (e) return new ApiError(status, e.message ?? "Request failed", e.code, e.request_id, e.details)
  } catch {
    /* not JSON */
  }
  return new ApiError(status, status >= 500 ? "Something went wrong on our side. Please try again." : "Request failed")
}

export async function api<T>(path: string, opts: { method?: string; body?: unknown; signal?: AbortSignal; auth?: boolean } = {}): Promise<T> {
  const headers: Record<string, string> = {}
  if (opts.body !== undefined) headers["Content-Type"] = "application/json"
  if (opts.auth !== false) {
    const t = await accessToken()
    if (t) headers.Authorization = `Bearer ${t}`
  }
  let res: Response
  try {
    res = await fetch(`${BASE}${path}`, { method: opts.method ?? "GET", headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined, signal: opts.signal })
  } catch {
    throw new ApiError(0, "Can't reach the server. Check your connection and try again.", "network")
  }
  if (res.status === 204) return undefined as T
  const text = await res.text()
  if (!res.ok) throw await toError(res.status, text)
  return camelize<T>(text ? JSON.parse(text) : undefined)
}

/** multipart upload with progress (fetch cannot report upload progress). */
export async function upload<T>(path: string, form: FormData, onProgress?: (pct: number) => void): Promise<T> {
  const token = await accessToken()
  return new Promise<T>((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open("POST", `${BASE}${path}`)
    if (token) xhr.setRequestHeader("Authorization", `Bearer ${token}`)
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.((e.loaded / e.total) * 100)
    xhr.onerror = () => reject(new ApiError(0, "Can't reach the server. Check your connection and try again.", "network"))
    xhr.onload = async () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve(camelize<T>(xhr.responseText ? JSON.parse(xhr.responseText) : undefined))
      else reject(await toError(xhr.status, xhr.responseText))
    }
    xhr.send(form)
  })
}

export function apiBase() {
  return BASE
}

export type StreamEvent<T> =
  | { type: "stage"; stage: string; label: string }
  | { type: "final"; data: T }

/**
 * POST + Server-Sent Events (EventSource cannot POST or send an Authorization header).
 * Resolves with the `final` payload; an `error` event or a dropped connection rejects with ApiError.
 * Aborting via `signal` closes the connection, which makes the server abandon the turn without saving it.
 */
export async function apiStream<T>(path: string, body: unknown, onStage: (label: string, stage: string) => void, signal?: AbortSignal): Promise<T> {
  const t = await accessToken()
  let res: Response
  try {
    res = await fetch(`${BASE}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream", ...(t ? { Authorization: `Bearer ${t}` } : {}) },
      body: JSON.stringify(body),
      signal,
    })
  } catch (e) {
    if (signal?.aborted) throw e
    throw new ApiError(0, "Can't reach the server. Check your connection and try again.", "network")
  }
  if (!res.ok || !res.body) throw await toError(res.status, await res.text())

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ""
  let final: T | undefined
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      let i: number
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, i)
        buf = buf.slice(i + 2)
        const ev = /^event: (.+)$/m.exec(block)?.[1]
        const raw = /^data: (.+)$/m.exec(block)?.[1]
        if (!ev || !raw) continue
        const data = JSON.parse(raw)
        if (ev === "stage") onStage(data.label, data.stage)
        else if (ev === "final") final = camelize<T>(data)
        else if (ev === "error") throw new ApiError(data.status ?? 500, data.message ?? "Request failed", data.code)
      }
    }
  } catch (e) {
    if (e instanceof ApiError || signal?.aborted) throw e
    throw new ApiError(0, "The connection dropped before the Coach finished. Your message wasn't saved. Please send it again.", "network")
  }
  if (!final) throw new ApiError(0, "The connection dropped before the Coach finished. Your message wasn't saved. Please send it again.", "network")
  return final
}
