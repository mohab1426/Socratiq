import { describe, expect, it, vi, beforeEach } from "vitest"

vi.mock("./supabase", () => ({ supabase: { auth: { getSession: async () => ({ data: { session: { access_token: "tok" } } }) } } }))

import { ApiError, apiStream } from "./api"

const sse = (...blocks: string[]) => blocks.join("")
const ev = (name: string, data: unknown) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`

function respond(body: string, chunk = 7, status = 200) {
  const enc = new TextEncoder().encode(body)
  const stream = new ReadableStream({
    start(c) {
      for (let i = 0; i < enc.length; i += chunk) c.enqueue(enc.slice(i, i + chunk))     // tiny chunks: events split across reads
      c.close()
    },
  })
  return new Response(status === 200 ? stream : body, { status, headers: { "content-type": status === 200 ? "text/event-stream" : "application/json" } })
}

beforeEach(() => vi.restoreAllMocks())

describe("apiStream", () => {
  it("reports stages in order and resolves with the camelized final payload, even when events are split across chunks", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(respond(sse(ev("stage", { stage: "start", label: "Starting" }), ev("stage", { stage: "diagnose", label: "Working out where you are" }), ev("final", { interaction_id: "i1", turn: 1, message: { id: "m", role: "coach", content: "Why?" }, sources: [] }))))
    const labels: string[] = []
    const r = await apiStream<{ interactionId: string; turn: number }>("/ai/coach/stream", { x: 1 }, (l) => labels.push(l))
    expect(labels).toEqual(["Starting", "Working out where you are"])
    expect(r.interactionId).toBe("i1")
    const call = vi.mocked(fetch).mock.calls[0]
    expect((call[1]!.headers as Record<string, string>).Authorization).toBe("Bearer tok")
  })

  it("turns an error event into an ApiError with the server's code", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(respond(sse(ev("stage", { stage: "start", label: "s" }), ev("error", { code: "ai_unavailable", message: "AI down", status: 503 }))))
    await expect(apiStream("/p", {}, () => {})).rejects.toMatchObject({ code: "ai_unavailable", status: 503, message: "AI down" })
  })

  it("rejects when the connection ends before a final event (nothing was saved)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(respond(ev("stage", { stage: "start", label: "s" })))
    await expect(apiStream("/p", {}, () => {})).rejects.toMatchObject({ code: "network" })
  })

  it("surfaces pre-stream HTTP errors (auth, state) as ApiError", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(respond(JSON.stringify({ error: { message: "Start an attempt first", code: "no_open_attempt" } }), 7, 409))
    const e = await apiStream("/p", {}, () => {}).catch((x) => x)
    expect(e).toBeInstanceOf(ApiError)
    expect(e).toMatchObject({ status: 409, code: "no_open_attempt" })
  })

  it("propagates aborts untouched so the UI can tell cancel from failure", async () => {
    const ctl = new AbortController()
    vi.spyOn(globalThis, "fetch").mockImplementation(() => { ctl.abort(); return Promise.reject(new DOMException("aborted", "AbortError")) })
    await expect(apiStream("/p", {}, () => {}, ctl.signal)).rejects.toMatchObject({ name: "AbortError" })
  })
})
