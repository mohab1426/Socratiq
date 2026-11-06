import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createAutosaver, type SaveStatus } from "./autosave"

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_000_000) })
afterEach(() => vi.useRealTimers())

const make = (save: () => Promise<void>, extra: Partial<Parameters<typeof createAutosaver>[0]> = {}) => createAutosaver({ save, debounceMs: 1000, maxWaitMs: 5000, retryMs: [1000, 3000], ...extra })
const statuses = (a: ReturnType<typeof make>) => { const s: SaveStatus[] = []; a.subscribe((x) => { if (s[s.length - 1] !== x.status) s.push(x.status) }); return s }

describe("autosave: debounce", () => {
  it("many edits inside the window produce ONE save, after the quiet period", async () => {
    const save = vi.fn().mockResolvedValue(undefined)
    const a = make(save)
    for (let i = 0; i < 20; i++) { a.markDirty(); await vi.advanceTimersByTimeAsync(200) }
    expect(save).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1000)
    expect(save).toHaveBeenCalledTimes(1)
    expect(a.getState().status).toBe("saved")
  })
  it("continuous editing is never starved: a save happens within maxWait", async () => {
    const save = vi.fn().mockResolvedValue(undefined)
    const a = make(save)
    for (let t = 0; t < 7000; t += 400) { a.markDirty(); await vi.advanceTimersByTimeAsync(400) }
    expect(save.mock.calls.length).toBeGreaterThanOrEqual(1)
  })
  it("reports idle -> dirty -> saving -> saved", async () => {
    const a = make(vi.fn().mockResolvedValue(undefined))
    const s = statuses(a)
    a.markDirty()
    await vi.advanceTimersByTimeAsync(1100)
    expect(s).toEqual(["idle", "dirty", "saving", "saved"])
    expect(a.getState().savedAt).toBe(1_001_000)
  })
})

describe("autosave: no lost edits, no duplicate saves", () => {
  it("an edit made DURING a save triggers exactly one follow-up save", async () => {
    let release!: () => void
    const save = vi.fn().mockImplementationOnce(() => new Promise<void>((r) => { release = r })).mockResolvedValue(undefined)
    const a = make(save)
    a.markDirty()
    await vi.advanceTimersByTimeAsync(1100)
    expect(save).toHaveBeenCalledTimes(1)
    a.markDirty(); a.markDirty(); a.markDirty()                      // student keeps drawing while the first save is in flight
    release()
    await vi.advanceTimersByTimeAsync(10)
    expect(save).toHaveBeenCalledTimes(2)
    expect(a.getState().status).toBe("saved")
  })
  it("never runs two saves at once", async () => {
    let running = 0, peak = 0
    const save = vi.fn(async () => { running++; peak = Math.max(peak, running); await new Promise((r) => setTimeout(r, 300)); running-- })
    const a = make(save)
    a.markDirty()
    const f = [a.flush(), a.flush(), a.flush()]
    a.markDirty()
    await vi.advanceTimersByTimeAsync(2000)
    await Promise.all(f)
    expect(peak).toBe(1)
  })
  it("flush resolves true only when the latest edit is saved", async () => {
    const a = make(vi.fn().mockResolvedValue(undefined))
    expect(await a.flush()).toBe(true)                                // nothing to save
    a.markDirty()
    expect(await a.flush()).toBe(true)
    expect(a.getState().status).toBe("saved")
  })
})

describe("autosave: failures", () => {
  it("retries transient failures with backoff, then recovers", async () => {
    const save = vi.fn().mockRejectedValueOnce(new Error("net")).mockRejectedValueOnce(new Error("net")).mockResolvedValue(undefined)
    const a = make(save)
    const s = statuses(a)
    a.markDirty()
    await vi.advanceTimersByTimeAsync(1100)
    expect(a.getState()).toMatchObject({ status: "error", retryInMs: 1000, permanent: false, error: "net" })
    await vi.advanceTimersByTimeAsync(1000)
    expect(a.getState().retryInMs).toBe(3000)
    await vi.advanceTimersByTimeAsync(3000)
    expect(save).toHaveBeenCalledTimes(3)
    expect(a.getState().status).toBe("saved")
    expect(s).toContain("error")
  })
  it("reports offline when the browser is offline", async () => {
    const a = make(vi.fn().mockRejectedValue(new Error("x")), { isOffline: () => true })
    a.markDirty()
    await vi.advanceTimersByTimeAsync(1100)
    expect(a.getState().status).toBe("offline")
  })
  it("a permanent failure (too large / closed) stops retrying and explains why", async () => {
    const save = vi.fn().mockRejectedValue(Object.assign(new Error("Board too large"), { permanent: true }))
    const a = make(save, { isPermanent: (e) => !!(e as { permanent?: boolean }).permanent })
    a.markDirty()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(save).toHaveBeenCalledTimes(1)
    expect(a.getState()).toMatchObject({ status: "error", permanent: true, retryInMs: null, error: "Board too large" })
    expect(await a.flush()).toBe(false)
  })
  it("editing after a permanent failure clears the flag so a new save may succeed", async () => {
    const save = vi.fn().mockRejectedValueOnce(Object.assign(new Error("big"), { permanent: true })).mockResolvedValue(undefined)
    const a = make(save, { isPermanent: (e) => !!(e as { permanent?: boolean }).permanent })
    a.markDirty()
    await vi.advanceTimersByTimeAsync(1100)
    a.markDirty()
    await vi.advanceTimersByTimeAsync(1100)
    expect(a.getState().status).toBe("saved")
  })
  it("flush retries a failed save immediately and reports the result", async () => {
    const save = vi.fn().mockRejectedValueOnce(new Error("net")).mockResolvedValue(undefined)
    const a = make(save)
    a.markDirty()
    await vi.advanceTimersByTimeAsync(1100)
    expect(a.getState().status).toBe("error")
    expect(await a.flush()).toBe(true)
  })
  it("dispose stops everything", async () => {
    const save = vi.fn().mockResolvedValue(undefined)
    const a = make(save)
    a.markDirty()
    a.dispose()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(save).not.toHaveBeenCalled()
  })
})
