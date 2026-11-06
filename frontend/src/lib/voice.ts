/**
 * Voice is only another interface to the SAME Coach: speech -> text -> the normal coach request -> reply text -> speech.
 * Uses the browser's Web Speech API, so no audio ever leaves the device through our servers, and nothing is stored.
 * Support varies (SpeechRecognition: Chrome/Edge/Safari; not Firefox), so every caller must check `voiceSupport()`.
 */
import { useCallback, useEffect, useRef, useState } from "react"

/* Minimal typings: the Web Speech API is not in lib.dom for all TS versions. */
interface RecResult { isFinal: boolean; 0: { transcript: string } }
interface RecEvent { resultIndex: number; results: ArrayLike<RecResult> }
interface Recognition {
  lang: string; interimResults: boolean; continuous: boolean
  onresult: ((e: RecEvent) => void) | null
  onerror: ((e: { error: string }) => void) | null
  onend: (() => void) | null
  start(): void; stop(): void; abort(): void
}
type RecCtor = new () => Recognition

function recCtor(): RecCtor | null {
  const w = window as unknown as { SpeechRecognition?: RecCtor; webkitSpeechRecognition?: RecCtor }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null
}

export function voiceSupport() {
  return { listen: typeof window !== "undefined" && recCtor() !== null, speak: typeof window !== "undefined" && "speechSynthesis" in window }
}

export type VoiceLang = "en-US" | "ar-EG"
export type VoiceState = "idle" | "listening" | "thinking" | "speaking"

/**
 * What the browser can tell us about WHY recognition failed. The Web Speech API does not recognise speech on the device: Chrome and Edge stream the
 * audio to their vendor's cloud service, so "network" means that service could not be reached (offline, VPN/firewall, blocked), and Brave ships
 * the API without any speech service, so it always ends in "network". The raw code is kept in the message so the real cause is never hidden.
 */
export interface VoiceEnv { brave: boolean; online: boolean; secure: boolean }

export function describeVoiceError(code: string, env: VoiceEnv): string {
  switch (code) {
    case "not-allowed":
    case "service-not-allowed":
      return env.secure
        ? `Microphone access is blocked (${code}). Allow it in your browser's site settings, or type your message instead.`
        : `The browser only allows the microphone on secure (https) pages (${code}). Open the https address, or type your message.`
    case "no-speech": return "I didn't hear anything. Tap the microphone and try again."
    case "audio-capture": return "No microphone was found. Check that one is connected."
    case "language-not-supported": return "This browser can't recognise the selected voice language (language-not-supported). Switch the language or type your message."
    case "network":
      if (env.brave) return "Brave doesn't include the online speech service this feature needs (network). Use Chrome, Edge or Safari for voice, or type your message."
      if (!env.online) return "You appear to be offline (network). Speech recognition needs an internet connection. Reconnect, or type your message."
      return "Your browser couldn't reach its online speech service (network). Speech recognition needs an internet connection that isn't blocked by a VPN or firewall. Try again, or type your message."
    default: return `Voice input failed (${code}). Please try again or type your message.`
  }
}

/** Brave identifies itself only through an async API; cached after the first answer. */
let braveCache: boolean | null = null
async function detectBrave(): Promise<boolean> {
  if (braveCache !== null) return braveCache
  try {
    const b = (navigator as unknown as { brave?: { isBrave?: () => Promise<boolean> } }).brave
    braveCache = !!(b?.isBrave && (await b.isBrave()))
  } catch { braveCache = false }
  return braveCache
}

/** Strip markdown the voice would read aloud ("star star"), keep the words. */
export function speakable(text: string) {
  return text.replace(/```[\s\S]*?```/g, " (code omitted) ").replace(/[*_`#>]+/g, "").replace(/\s+/g, " ").trim()
}

export function useVoice(opts: { lang: VoiceLang; onTranscript: (text: string) => void }) {
  const [state, setState] = useState<VoiceState>("idle")
  const [interim, setInterim] = useState("")
  const [error, setError] = useState<string | null>(null)
  const rec = useRef<Recognition | null>(null)
  const heard = useRef("")
  const cb = useRef(opts.onTranscript)
  const brave = useRef(false)
  useEffect(() => { void detectBrave().then((v) => { brave.current = v }) }, [])
  useEffect(() => { cb.current = opts.onTranscript }, [opts.onTranscript])

  const stopSpeaking = useCallback(() => {
    if (typeof window !== "undefined" && "speechSynthesis" in window) window.speechSynthesis.cancel()
    setState((s) => (s === "speaking" ? "idle" : s))
  }, [])

  const start = useCallback(() => {
    const Ctor = recCtor()
    if (!Ctor) { setError("Voice input isn't supported in this browser. Please type your message."); return }
    stopSpeaking()
    setError(null); setInterim(""); heard.current = ""
    const r = new Ctor()
    r.lang = opts.lang; r.interimResults = true; r.continuous = false
    r.onresult = (e) => {
      let finalText = "", live = ""
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) finalText += e.results[i][0].transcript
        else live += e.results[i][0].transcript
      }
      if (finalText) heard.current += finalText
      setInterim(live)
    }
    r.onerror = (e) => {
      if (e.error !== "aborted") {
        setError(describeVoiceError(e.error, { brave: brave.current, online: typeof navigator === "undefined" || navigator.onLine !== false, secure: typeof window === "undefined" || window.isSecureContext !== false || ["localhost", "127.0.0.1"].includes(window.location.hostname) }))
      }
      heard.current = ""
    }
    r.onend = () => {
      rec.current = null; setInterim("")
      const text = heard.current.trim(); heard.current = ""
      if (text) { setState("thinking"); cb.current(text) } else setState("idle")
    }
    rec.current = r
    try { r.start(); setState("listening") } catch { setError("Couldn't start the microphone. Please try again."); setState("idle") }
  }, [opts.lang, stopSpeaking])

  const stopListening = useCallback(() => rec.current?.stop(), [])          // delivers what was heard so far
  const cancelListening = useCallback(() => { heard.current = ""; rec.current?.abort(); setState("idle") }, [])

  const speak = useCallback((text: string) => {
    if (!voiceSupport().speak) { setState("idle"); return }
    window.speechSynthesis.cancel()
    const u = new SpeechSynthesisUtterance(speakable(text))
    u.lang = opts.lang
    const v = window.speechSynthesis.getVoices().find((x) => x.lang.toLowerCase().startsWith(opts.lang.slice(0, 2)))
    if (v) u.voice = v
    u.onend = () => setState("idle")
    u.onerror = () => setState("idle")
    setState("speaking")
    window.speechSynthesis.speak(u)
  }, [opts.lang])

  /** the Coach request finished (or failed): leave the 'thinking' state */
  const settle = useCallback(() => setState((s) => (s === "thinking" ? "idle" : s)), [])

  useEffect(() => () => { rec.current?.abort(); if (typeof window !== "undefined" && "speechSynthesis" in window) window.speechSynthesis.cancel() }, [])

  return { state, interim, error, clearError: () => setError(null), start, stopListening, cancelListening, speak, stopSpeaking, settle }
}
