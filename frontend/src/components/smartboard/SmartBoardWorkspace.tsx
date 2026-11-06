import "./assetPath"
import "@excalidraw/excalidraw/index.css";
import { CaptureUpdateAction, Excalidraw, WelcomeScreen } from "@excalidraw/excalidraw"
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types"
import type { AppState, BinaryFileData, ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types"
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react"
import { generateDiagram, saveScene } from "@/lib/queries"
import { createAutosaver, type SaveState } from "@/lib/smartboard/autosave"
import { planCoachInsertion } from "@/lib/smartboard/coachInsert"
import { parseDiagramSpec } from "@/lib/smartboard/diagramSpec"
import { boardDigest, describeAiError, describeSaveError, isPermanentSaveError, sceneSignature, selectedLegacyId } from "@/lib/smartboard/glue"
import { planAiInsertion } from "@/lib/smartboard/insertAi"
import { legacyBoardToNative, unmirroredCoachElements, type MigrationReport } from "@/lib/smartboard/legacy"
import { readMeta, withMeta } from "@/lib/smartboard/meta"
import { viewportRect } from "@/lib/smartboard/placement"
import { browserImageCompressor, buildStoredScene, compressSceneFiles, isStoredScene, restoreStoredScene, sceneBytes, SCENE_MAX_BYTES } from "@/lib/smartboard/scene"
import type { Rect, SceneEl } from "@/lib/smartboard/types"
import { ASK_ACTIONS, type BoardIntent } from "@/lib/boardAsk"
import { fromServer, type Board } from "@/lib/whiteboard"

/** Same contract as the legacy BoardWorkspace, so the Coach page can use either engine. */
export interface BoardApi {
  flush: () => Promise<boolean>
  applyServer: (b: Partial<Board>) => number
  selectedId: () => string | null
}
interface Props {
  assignmentId: string
  courseId?: string
  initial: Board
  readOnly?: boolean
  busy: boolean
  onAsk: (intent: BoardIntent, message: string) => void
  /** Where the scene is saved. Defaults to the assignment's whiteboard endpoint; the public demo page overrides it. */
  onPersist?: (scene: unknown) => Promise<unknown>
}

type Els = readonly ExcalidrawElement[]
type AiState = { phase: "idle" } | { phase: "working"; step: string } | { phase: "done"; message: string; groupId: string; rect: Rect } | { phase: "error"; message: string; detail?: string }

function buildInit(initial: Board) {
  if (initial.scene && isStoredScene(initial.scene)) {
    const r = restoreStoredScene(initial.scene)
    let elements: Els = r.elements, files = r.files as Record<string, BinaryFileData>, dirty = false
    const missing = unmirroredCoachElements(initial, elements)          // the Coach writes server-side: bring anything it wrote since the last save onto the canvas
    if (missing.length) {
      const p = planCoachInsertion({ existing: elements, coach: missing, viewport: null, opId: `load-${initial.nextSeq}` })
      if (p.ok && p.added.length) { elements = p.all; files = { ...files, ...(p.files as Record<string, BinaryFileData>) }; dirty = true }
    }
    return { elements, appState: r.appState, files, dirty, report: null as MigrationReport | null }
  }
  const m = legacyBoardToNative(initial)                                  // existing board: deterministic, non-destructive upgrade (legacy data stays on the server)
  const empty = m.elements.length === 0
  return { elements: m.elements as Els, appState: { viewBackgroundColor: "#ffffff" } as Partial<AppState>, files: m.files as unknown as Record<string, BinaryFileData>, dirty: !empty, report: empty ? null : m.report }
}

const bump = (e: ExcalidrawElement, patch: Partial<ExcalidrawElement>): ExcalidrawElement => ({ ...e, ...patch, version: e.version + 1, versionNonce: Math.floor(Math.random() * 2 ** 31), updated: Date.now() }) as ExcalidrawElement

const SaveBadge = ({ s, onRetry }: { s: SaveState; onRetry: () => void }) => {
  const label = s.status === "saving" ? "Saving…" : s.status === "dirty" ? "Unsaved changes" : s.status === "saved" ? (s.savedAt ? `Saved ${new Date(s.savedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : "Saved") : s.status === "offline" ? "Offline: will retry" : s.status === "error" ? (s.permanent ? "Not saved" : "Save failed: retrying") : ""
  if (!label) return null
  const bad = s.status === "error" || s.status === "offline"
  return (
    <div role="status" aria-live="polite" title={s.error ?? undefined} className={`flex items-center gap-2 rounded-lg border px-2.5 py-1 text-xs ${bad ? "border-[var(--color-danger-ink)] text-[var(--color-danger-ink)]" : "border-[var(--color-line)] text-[var(--color-ink-muted)]"} bg-white/90`}>
      <span aria-hidden className={`inline-block size-2 rounded-full ${s.status === "saved" ? "bg-emerald-500" : bad ? "bg-red-500" : "bg-amber-400"}`} />
      <span>{label}</span>
      {bad && <button type="button" onClick={onRetry} className="underline">Retry now</button>}
    </div>
  )
}

export const SmartBoardWorkspace = forwardRef<BoardApi, Props>(function SmartBoardWorkspace({ assignmentId, initial, readOnly, busy, onAsk, onPersist }, ref) {
  const [init] = useState(() => buildInit(initial))
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null)
  const [ready, setReady] = useState(false)
  const lastSig = useRef<string | null>(null)
  const coachText = useRef(new Map<string, string>())
  const [compressCache] = useState(() => new Map<string, string>())
  const latest = useRef({ assignmentId, onPersist })
  useEffect(() => { latest.current = { assignmentId, onPersist } })
  const [save, setSave] = useState<SaveState>({ status: "idle", savedAt: null, error: null, permanent: false, retryInMs: null })
  const [hasContent, setHasContent] = useState(init.elements.some((e) => !e.isDeleted))
  const [ai, setAi] = useState<AiState>({ phase: "idle" })
  const [prompt, setPrompt] = useState("")
  const [notice, setNotice] = useState<string | null>(init.report?.warnings.length ? `Your board was upgraded to the new whiteboard. ${init.report.warnings.slice(0, 2).join(" ")}` : null)
  const aiBusy = useRef(false)

  const [saver] = useState(() => createAutosaver({
    save: async () => {
      const api = apiRef.current
      if (!api) return
      const stored = buildStoredScene(api.getSceneElementsIncludingDeleted(), api.getAppState(), api.getFiles())
      const small = await compressSceneFiles(stored, browserImageCompressor, compressCache)
      if (sceneBytes(small) > SCENE_MAX_BYTES) throw Object.assign(new Error("The board is too large to save. Remove some images or very large drawings."), { permanent: true })
      const { assignmentId: id, onPersist: persist } = latest.current
      await (persist ? persist(small) : saveScene(id, small))
    },
    isOffline: () => typeof navigator !== "undefined" && !navigator.onLine,
    isPermanent: (e) => isPermanentSaveError(e) || !!(e as { permanent?: boolean }).permanent,
    describe: (e) => ((e as { permanent?: boolean }).permanent ? (e as Error).message : describeSaveError(e)),
  }))
  useEffect(() => saver.subscribe(setSave), [saver])
  useEffect(() => () => { void saver.flush().finally(() => saver.dispose()) }, [saver])
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => { const s = saver.getState().status; if (s === "dirty" || s === "saving" || s === "error" || s === "offline") { e.preventDefault(); e.returnValue = "" } }
    const hide = () => { if (document.visibilityState === "hidden") void saver.flush() }
    window.addEventListener("beforeunload", warn); document.addEventListener("visibilitychange", hide)
    return () => { window.removeEventListener("beforeunload", warn); document.removeEventListener("visibilitychange", hide) }
  }, [saver])

  const scrollTo = useCallback((els: Els) => { apiRef.current?.scrollToContent(els, { fitToViewport: true, viewportZoomFactor: 0.8, animate: true, duration: 450, maxZoom: 1 }) }, [])
  const currentViewport = () => { const a = apiRef.current!.getAppState(); return viewportRect(a) }

  useImperativeHandle(ref, () => ({
    flush: () => saver.flush(),
    selectedId: () => { const api = apiRef.current; return api ? selectedLegacyId(api.getSceneElementsIncludingDeleted() as readonly SceneEl[], api.getAppState().selectedElementIds) : null },
    applyServer: (b) => {
      const api = apiRef.current
      if (!api) return 0
      const els = api.getSceneElementsIncludingDeleted()
      const missing = unmirroredCoachElements(fromServer(b), els)
      if (!missing.length) return 0
      const p = planCoachInsertion({ existing: els, coach: missing, viewport: currentViewport(), opId: `coach-${Date.now()}` })
      if (!p.ok) { console.warn("[smartboard] could not place the Coach's drawing safely:", p.reason, p.diagnostics); return 0 }
      const files = Object.values(p.files) as BinaryFileData[]
      if (files.length) api.addFiles(files)
      api.updateScene({ elements: p.all, appState: { selectedElementIds: {}, selectedGroupIds: { [p.groupId]: true } } as never, captureUpdate: CaptureUpdateAction.IMMEDIATELY })
      const vp = currentViewport()
      if (p.rect.x < vp.x || p.rect.y < vp.y || p.rect.x + p.rect.w > vp.x + vp.w || p.rect.y + p.rect.h > vp.y + vp.h) scrollTo(p.added)
      return missing.length
    },
  }), [saver, scrollTo])

  const onChange = useCallback((elements: Els) => {
    setHasContent(elements.some((e) => !e.isDeleted))
    if (readOnly) return
    const sig = sceneSignature(elements)
    if (lastSig.current === null) { lastSig.current = sig; for (const e of elements) if (e.type === "text" && readMeta(e)?.author === "coach") coachText.current.set(e.id, e.text); return }
    if (sig === lastSig.current) return
    lastSig.current = sig
    // If the student edits what the Coach wrote, it becomes the student's content (with provenance), mirroring the legacy board's rule.
    const edited = elements.filter((e) => e.type === "text" && !e.isDeleted && readMeta(e)?.author === "coach" && coachText.current.has(e.id) && coachText.current.get(e.id) !== e.text)
    if (edited.length && apiRef.current) {
      const ids = new Set(edited.map((e) => e.id))
      edited.forEach((e) => coachText.current.delete(e.id))
      apiRef.current.updateScene({ elements: elements.map((e) => (ids.has(e.id) ? bump(e, { customData: withMeta(e.customData, { author: "student", originalAuthor: "coach", legacyId: readMeta(e)?.legacyId, role: readMeta(e)?.role }) }) : e)), captureUpdate: CaptureUpdateAction.NEVER })
    }
    saver.markDirty()
  }, [readOnly, saver])

  useEffect(() => { if (ready && init.dirty && !readOnly) saver.markDirty() }, [ready, init.dirty, readOnly, saver])

  const runAi = useCallback(async (text: string) => {
    const api = apiRef.current
    const request = text.trim()
    if (!api || !request || aiBusy.current || readOnly) return
    aiBusy.current = true
    setNotice(null)
    setAi({ phase: "working", step: "Understanding your request…" })
    const opId = crypto.randomUUID()                                     // one id per request: a retry can never add the drawing twice
    try {
      const before = api.getSceneElementsIncludingDeleted()
      const selected = Object.keys(api.getAppState().selectedElementIds)
      const { spec } = await generateDiagram({ request, board: boardDigest(before as readonly SceneEl[]), selectedId: selected[0] ?? null })
      setAi({ phase: "working", step: "Finding space on your board…" })
      const parsed = parseDiagramSpec(spec)
      if (!parsed.ok) throw new Error("The drawing plan was incomplete.")
      // Plan against the board AS IT IS NOW: the student may have kept drawing while the model was thinking.
      const els = api.getSceneElementsIncludingDeleted()
      const plan = planAiInsertion({ spec: parsed.spec, request, elements: els, viewport: currentViewport(), selectedIds: Object.keys(api.getAppState().selectedElementIds), opId })
      if (!plan.ok) { console.warn("[smartboard] AI drawing rejected:", plan.reason, plan.diagnostics); setAi({ phase: "error", message: plan.message, detail: plan.diagnostics.slice(-4).join("\n") }); return }
      if (plan.duplicate) { setAi({ phase: "idle" }); return }
      api.updateScene({ elements: plan.all, appState: { selectedElementIds: {}, selectedGroupIds: { [plan.groupId]: true } } as never, captureUpdate: CaptureUpdateAction.IMMEDIATELY })   // one history entry = one Undo
      if (!plan.visible) scrollTo(plan.added)
      const where = plan.placement.strategy === "anchor" ? "next to your content" : plan.placement.strategy === "empty-board" ? "on your board" : plan.placement.strategy === "extend" ? "in free space beyond your content" : "in free space"
      console.debug("[smartboard] AI drawing placed", { strategy: plan.placement.strategy, layout: plan.layoutStrategy, diagnostics: plan.diagnostics })
      setAi({ phase: "done", message: `Added “${parsed.spec.title ?? parsed.spec.topic}” ${where}. Ctrl+Z removes it in one step.`, groupId: plan.groupId, rect: plan.rect })
      setPrompt("")
    } catch (e) {
      setAi({ phase: "error", message: describeAiError(e) })
    } finally { aiBusy.current = false }
  }, [readOnly, scrollTo])

  const removeAiGroup = (groupId: string) => {
    const api = apiRef.current
    if (!api) return
    api.updateScene({ elements: api.getSceneElementsIncludingDeleted().map((e) => (e.groupIds.includes(groupId) && !e.isDeleted ? bump(e, { isDeleted: true }) : e)), captureUpdate: CaptureUpdateAction.IMMEDIATELY })
    setAi({ phase: "idle" })
  }
  const fit = () => apiRef.current?.scrollToContent(undefined, { fitToContent: true, animate: true, duration: 400, maxZoom: 1 })
  const resetView = () => apiRef.current?.updateScene({ appState: { scrollX: 0, scrollY: 0, zoom: { value: 1 } } as never })
  const working = ai.phase === "working"
  const locked = !!readOnly || busy                       // while the Coach is writing, the board is read-only so nothing it writes can collide with an edit
  // Excalidraw hides its top-right UI in view mode, so while the board is locked (Coach writing, or read-only) the status moves to our own overlay.
  const status = (
    <>
      {busy && <span role="status" className="rounded-lg border border-[var(--color-line)] bg-white/90 px-2.5 py-1 text-xs">SocratiQ is writing on the board…</span>}
      {!readOnly && <SaveBadge s={save} onRetry={() => void saver.flush()} />}
    </>
  )
  const lang = typeof document !== "undefined" && document.documentElement.lang.startsWith("ar") ? "ar-SA" : "en"

  return (
    <div className="relative h-full min-h-[320px] w-full" data-testid="smartboard">
      <Excalidraw
        excalidrawAPI={(a) => { apiRef.current = a; setReady(true) }}
        initialData={{ elements: init.elements as ExcalidrawElement[], appState: init.appState, files: init.files, scrollToContent: true }}
        onChange={onChange}
        viewModeEnabled={locked}
        langCode={lang}
        handleKeyboardGlobally={false}
        UIOptions={{ canvasActions: { loadScene: false, saveToActiveFile: false, export: { saveFileToDisk: true }, toggleTheme: true } }}
        renderTopRightUI={() => (
          <div className="flex items-center gap-2">
            {status}
            <button type="button" onClick={fit} className="rounded-lg border border-[var(--color-line)] bg-white/90 px-2.5 py-1 text-xs hover:bg-white" title="Zoom to fit everything on the board">Fit to content</button>
            <button type="button" onClick={resetView} className="rounded-lg border border-[var(--color-line)] bg-white/90 px-2.5 py-1 text-xs hover:bg-white" title="Back to 100% at the origin">Reset view</button>
          </div>
        )}
      >
        {!hasContent && (
          <WelcomeScreen>
            <WelcomeScreen.Center>
              <WelcomeScreen.Center.Heading>Your thinking space</WelcomeScreen.Center.Heading>
              <p className="max-w-sm text-center text-sm text-[var(--color-ink-muted)]">Draw, write and sketch freely. Ask the AI to draw a diagram or explain something, and it will add its own group without touching your work.</p>
            </WelcomeScreen.Center>
          </WelcomeScreen>
        )}
      </Excalidraw>

      {locked && <div className="pointer-events-auto absolute right-3 top-3 z-10 flex items-center gap-2">{status}</div>}

      {notice && (
        <div role="status" className="absolute left-1/2 top-16 z-10 w-[min(560px,calc(100%-2rem))] -translate-x-1/2 rounded-lg border border-[var(--color-line)] bg-white px-3 py-2 text-xs shadow">
          {notice} <button type="button" onClick={() => setNotice(null)} className="ml-2 underline">Dismiss</button>
        </div>
      )}

      {!readOnly && (
        <div className="pointer-events-none absolute bottom-16 left-1/2 z-10 flex w-[min(640px,calc(100%-2rem))] -translate-x-1/2 flex-col gap-2 md:bottom-3">
          {(ai.phase !== "idle") && (
            <div role={ai.phase === "error" ? "alert" : "status"} aria-live="polite" className={`pointer-events-auto rounded-lg border px-3 py-2 text-xs shadow ${ai.phase === "error" ? "border-[var(--color-danger-ink)] bg-white text-[var(--color-danger-ink)]" : "border-[var(--color-line)] bg-white"}`}>
              {ai.phase === "working" && <span>{ai.step}</span>}
              {ai.phase === "done" && (
                <span className="flex flex-wrap items-center gap-2">
                  <span>{ai.message}</span>
                  <button type="button" className="underline" onClick={() => { const api = apiRef.current; if (api) scrollTo(api.getSceneElementsIncludingDeleted().filter((e) => e.groupIds.includes(ai.groupId))) }}>Show</button>
                  <button type="button" className="underline" onClick={() => removeAiGroup(ai.groupId)}>Remove</button>
                </span>
              )}
              {ai.phase === "error" && <span>{ai.message}{ai.detail && <details className="mt-1 text-[var(--color-ink-muted)]"><summary className="cursor-pointer">Details</summary><pre className="whitespace-pre-wrap">{ai.detail}</pre></details>}</span>}
            </div>
          )}
          <div className="pointer-events-auto flex items-center gap-2 rounded-xl border border-[var(--color-line)] bg-white p-2 shadow-lg">
            <label className="sr-only" htmlFor="smartboard-ai">Ask the AI to draw or explain on your board</label>
            <input
              id="smartboard-ai" value={prompt} onChange={(e) => setPrompt(e.target.value)} disabled={working} maxLength={1000}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing) { e.preventDefault(); void runAi(prompt) } }}
              placeholder="Ask AI to draw or explain… (uses what you've selected)" dir="auto"
              className="min-w-0 flex-1 rounded-lg border border-[var(--color-line)] px-3 py-2 text-sm outline-none focus:border-[var(--color-brand,#0f766e)]"
            />
            <button type="button" disabled={working || !prompt.trim()} onClick={() => void runAi(prompt)} className="rounded-lg bg-[var(--color-brand,#0f766e)] px-3 py-2 text-sm font-medium text-white disabled:opacity-50">{working ? "Drawing…" : "Draw"}</button>
            <button type="button" disabled={busy || !prompt.trim()} onClick={() => { onAsk("explain", prompt.trim()); setPrompt("") }} className="rounded-lg border border-[var(--color-line)] px-3 py-2 text-sm disabled:opacity-50" title="Ask the Socratic Coach instead; it guides you with questions">Ask Coach</button>
            <details className="relative">
              <summary className="cursor-pointer list-none rounded-lg border border-[var(--color-line)] px-3 py-2 text-sm" aria-label="Ask SocratiQ about the board">Ask SocratiQ ▾</summary>
              <div role="menu" className="absolute bottom-full right-0 mb-2 w-56 rounded-lg border border-[var(--color-line)] bg-white p-1 shadow-lg">
                {ASK_ACTIONS.map((a) => (
                  <button key={a.intent} type="button" role="menuitem" disabled={busy} className="block w-full rounded px-3 py-1.5 text-left text-sm hover:bg-slate-100 disabled:opacity-50"
                    onClick={(e) => { const hasSel = Object.keys(apiRef.current?.getAppState().selectedElementIds ?? {}).length > 0; e.currentTarget.closest("details")?.removeAttribute("open"); onAsk(a.intent, a.message(hasSel)) }}>{a.label}</button>
                ))}
              </div>
            </details>
          </div>
        </div>
      )}
    </div>
  )
})

export default SmartBoardWorkspace
