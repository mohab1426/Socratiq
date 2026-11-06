// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { useVoice, voiceSupport } from "./voice"

/* A scriptable stand-in for the browser's SpeechRecognition / speechSynthesis. This verifies OUR state machine, not a real microphone. */
class FakeRec {
  static last: FakeRec | null = null
  lang = ""; interimResults = false; continuous = true
  onresult: ((e: unknown) => void) | null = null
  onerror: ((e: { error: string }) => void) | null = null
  onend: (() => void) | null = null
  started = false; aborted = false
  start() { this.started = true; FakeRec.last = this }
  stop() { this.onend?.() }
  abort() { this.aborted = true; this.onend?.() }
  say(text: string, final = true) { this.onresult?.({ resultIndex: 0, results: [{ isFinal: final, 0: { transcript: text } }] }) }
}
const speech = { speak: vi.fn(), cancel: vi.fn(), getVoices: vi.fn(() => [] as unknown[]) }
class FakeUtterance { text: string; lang = ""; voice: unknown = null; onend: (() => void) | null = null; onerror: (() => void) | null = null; constructor(t: string) { this.text = t } }

function install(withRecognition = true) {
  const w = window as unknown as Record<string, unknown>
  if (withRecognition) w.webkitSpeechRecognition = FakeRec; else delete w.webkitSpeechRecognition
  delete w.SpeechRecognition
  w.speechSynthesis = speech
  w.SpeechSynthesisUtterance = FakeUtterance
}

beforeEach(() => { FakeRec.last = null; speech.speak.mockClear(); speech.cancel.mockClear(); install() })
afterEach(() => vi.restoreAllMocks())

const setup = (lang: "en-US" | "ar-EG" = "en-US") => {
  const onTranscript = vi.fn()
  const hook = renderHook(({ l }) => useVoice({ lang: l, onTranscript }), { initialProps: { l: lang } })
  return { ...hook, onTranscript }
}

describe("useVoice state machine", () => {
  it("reports support honestly", () => {
    expect(voiceSupport()).toEqual({ listen: true, speak: true })
    install(false)
    expect(voiceSupport().listen).toBe(false)
  })

  it("unsupported browser: clear error, never leaves idle, no crash", () => {
    install(false)
    const { result } = setup()
    act(() => result.current.start())
    expect(result.current.state).toBe("idle")
    expect(result.current.error).toMatch(/isn't supported/)
  })

  it("listening -> thinking, delivering the trimmed transcript exactly once", () => {
    const { result, onTranscript } = setup()
    act(() => result.current.start())
    expect(result.current.state).toBe("listening")
    expect(FakeRec.last!.interimResults).toBe(true)
    act(() => FakeRec.last!.say("hel", false))
    expect(result.current.interim).toBe("hel")
    act(() => FakeRec.last!.say("  why subtract five?  "))
    act(() => result.current.stopListening())
    expect(result.current.state).toBe("thinking")
    expect(onTranscript).toHaveBeenCalledTimes(1)
    expect(onTranscript).toHaveBeenCalledWith("why subtract five?")
    act(() => FakeRec.last?.onend?.())                      // a duplicate end event must not submit again
    expect(onTranscript).toHaveBeenCalledTimes(1)
  })

  it("empty transcript: back to idle, nothing is sent", () => {
    const { result, onTranscript } = setup()
    act(() => result.current.start())
    act(() => result.current.stopListening())
    expect(result.current.state).toBe("idle")
    expect(onTranscript).not.toHaveBeenCalled()
  })

  it("permission denied: friendly message, nothing sent, idle", () => {
    const { result, onTranscript } = setup()
    act(() => result.current.start())
    act(() => { FakeRec.last!.onerror?.({ error: "not-allowed" }); FakeRec.last!.onend?.() })
    expect(result.current.error).toMatch(/Microphone access is blocked/)
    expect(result.current.state).toBe("idle")
    expect(onTranscript).not.toHaveBeenCalled()
  })

  it.each([["no-speech", /didn't hear/], ["audio-capture", /No microphone/], ["network", /internet connection/], ["weird", /Voice input failed/]])("recognition error %s maps to a readable message", (code, re) => {
    const { result } = setup()
    act(() => result.current.start())
    act(() => { FakeRec.last!.onerror?.({ error: code }); FakeRec.last!.onend?.() })
    expect(result.current.error).toMatch(re)
  })

  it("cancel aborts recognition and discards what was heard", () => {
    const { result, onTranscript } = setup()
    act(() => result.current.start())
    act(() => FakeRec.last!.say("never send this"))
    act(() => result.current.cancelListening())
    expect(FakeRec.last!.aborted).toBe(true)
    expect(result.current.state).toBe("idle")
    expect(onTranscript).not.toHaveBeenCalled()
  })

  it("language selection reaches the recogniser and the voice (Arabic / English)", () => {
    const { result, rerender } = setup("ar-EG")
    act(() => result.current.start())
    expect(FakeRec.last!.lang).toBe("ar-EG")
    act(() => result.current.cancelListening())
    rerender({ l: "en-US" })
    act(() => result.current.start())
    expect(FakeRec.last!.lang).toBe("en-US")
    act(() => result.current.speak("hello"))
    expect((speech.speak.mock.calls[0][0] as FakeUtterance).lang).toBe("en-US")
  })

  it("speaking: markdown is not read aloud, state follows the utterance, stop interrupts", () => {
    const { result } = setup()
    act(() => result.current.speak("**Why** did you subtract `5`?"))
    const u = speech.speak.mock.calls[0][0] as FakeUtterance
    expect(u.text).toBe("Why did you subtract 5?")
    expect(result.current.state).toBe("speaking")
    act(() => result.current.stopSpeaking())
    expect(speech.cancel).toHaveBeenCalled()
    expect(result.current.state).toBe("idle")
    act(() => result.current.speak("again"))
    act(() => (speech.speak.mock.calls[1][0] as FakeUtterance).onend?.())
    expect(result.current.state).toBe("idle")
  })

  it("starting to listen interrupts speech", () => {
    const { result } = setup()
    act(() => result.current.speak("long answer"))
    act(() => result.current.start())
    expect(speech.cancel).toHaveBeenCalled()
    expect(result.current.state).toBe("listening")
  })

  it("settle() leaves 'thinking' (the coach request finished or failed) but never interrupts other states", () => {
    const { result } = setup()
    act(() => result.current.start())
    act(() => FakeRec.last!.say("hi"))
    act(() => result.current.stopListening())
    expect(result.current.state).toBe("thinking")
    act(() => result.current.settle())
    expect(result.current.state).toBe("idle")
    act(() => result.current.speak("x"))
    act(() => result.current.settle())
    expect(result.current.state).toBe("speaking")
  })

  it("unmount cleans up: recognition aborted, speech cancelled", () => {
    const { result, unmount } = setup()
    act(() => result.current.start())
    const rec = FakeRec.last!
    unmount()
    expect(rec.aborted).toBe(true)
    expect(speech.cancel).toHaveBeenCalled()
  })

  it("a failing start() (e.g. mic busy) reports an error instead of throwing", () => {
    FakeRec.prototype.start = function () { throw new Error("InvalidStateError") }
    const { result } = setup()
    act(() => result.current.start())
    expect(result.current.state).toBe("idle")
    expect(result.current.error).toMatch(/Couldn't start the microphone/)
    FakeRec.prototype.start = function (this: FakeRec) { this.started = true; FakeRec.last = this }
  })
})
