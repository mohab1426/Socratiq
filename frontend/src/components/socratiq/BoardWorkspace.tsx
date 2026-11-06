import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from "react"
import ReactMarkdown from "react-markdown"
import { ChevronDown, Sparkles, MessageSquare, Mic, Send, Square, X, Loader2 } from "lucide-react"
import { MathView } from "@/components/socratiq/MathView"
import { SmartBoard, type Tool, type ViewState, type SmartBoardHandle } from "@/components/socratiq/SmartBoard"
import { SmartBoardToolbar, type AIState } from "@/components/socratiq/SmartBoardToolbar"
import { Button } from "@/components/ui/Button"
import { ASK_ACTIONS, type BoardIntent } from "@/lib/boardAsk"
import { saveWhiteboard } from "@/lib/queries"
import { DEFAULT_TOOL_SETTINGS, applyExplicitColor, settingsFamily, updateToolSetting, type ToolSettings } from "@/lib/toolSettings"
import {
  BOARD_W, BOARD_H, LIMITS, addElement, commit, fromLegacy, fromServer, nextSeq, redo, removeElement, removeElements, startHistory, toWire, undo, updateElement,
  type Board, type History, type BoardElement, type Stroke,
} from "@/lib/whiteboard"
import {
  generateImageContent,
  generateSimulationCode,
  generateVectorDrawing,
  sendChatProxy,
  retrieveCourseMaterials,
  getLiveWebSocketUrl
} from "@/lib/geminiSmartBoardService"
import { accessToken } from "@/lib/api"
import {
  MODEL_NAMES,
  whiteboardTools,
  SMARTBOARD_SYSTEM_INSTRUCTION
} from "@/lib/smartboardConstants"
import { getSmartPlacement } from "@/lib/smartPlacement"
import {
  computeUnobstructedVisibleViewport,
  estimateContentDimensions,
  findCollisionFreePosition,
  isPlacementVisible,
  getOccupiedBoxes,
  computeArrowEndpoints,
  getElementBoundingBox,
  readBoardState,
  verifyAndReflowLayout,
  planBatchLayout,
  type ContainerDimensions,
  type LayoutItem,
  type UiOcclusion,
} from "@/lib/boardLayoutEngine"
import {
  arrowElementGeometry,
  finiteNumber,
  lineElementGeometry,
  readSegment,
  resolvePathIntent,
  type Segment,
} from "@/lib/aiGeometry"
import {
  BoardInteractionTracker,
  type StrokeInteraction,
} from "@/lib/interactionUnderstanding"
import {
  MAX_FIT_SCALE_CONTENT,
  MAX_FIT_SCALE_EMPTY,
  computeFitView, computeRevealView,
  contentFitBox,
  isUsableSize,
  measureOcclusion,
  zoomAtPoint,
  type Occlusion,
} from "@/lib/boardViewport"
import { cn } from "@/lib/utils"

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
}

const encodeAudio = (bytes: Uint8Array): string => {
  let binary = ""
  const len = bytes.byteLength
  for (let i = 0; i < len; i += 8192) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + 8192, len)) as any)
  }
  return btoa(binary)
}
const decodeAudio = (base64: string) => Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))

const decodeAudioData = async (data: Uint8Array, ctx: AudioContext) => {
  try {
    const sampleCount = Math.floor(data.byteLength / 2)
    if (sampleCount === 0) return null
    const dataView = new DataView(data.buffer, data.byteOffset, sampleCount * 2)
    const buffer = ctx.createBuffer(1, sampleCount, 24000)
    const channelData = buffer.getChannelData(0)
    for (let i = 0; i < sampleCount; i++) {
      channelData[i] = dataView.getInt16(i * 2, true) / 32768.0
    }
    return buffer
  } catch (e) {
    console.error("Audio decode error", e)
    return null
  }
}

const playAudio = async (
  base64: string,
  audioContext: AudioContext,
  nextStartTime: React.MutableRefObject<number>,
  activeSourcesRef?: React.MutableRefObject<AudioBufferSourceNode[]>,
  onAllSourcesEnded?: () => void
) => {
  if (!audioContext) return
  if (audioContext.state === "suspended") {
    try {
      await audioContext.resume()
    } catch {}
  }
  try {
    const arrayBuffer = decodeAudio(base64)
    const audioBuffer = await decodeAudioData(arrayBuffer, audioContext)
    if (!audioBuffer) return
    const source = audioContext.createBufferSource()
    source.buffer = audioBuffer
    source.connect(audioContext.destination)
    const startTime = Math.max(audioContext.currentTime, nextStartTime.current)
    source.start(startTime)
    nextStartTime.current = startTime + audioBuffer.duration

    if (activeSourcesRef) {
      activeSourcesRef.current.push(source)
      source.onended = () => {
        if (activeSourcesRef) {
          activeSourcesRef.current = activeSourcesRef.current.filter((s) => s !== source)
          if (activeSourcesRef.current.length === 0) {
            onAllSourcesEnded?.()
          }
        }
      }
    }
  } catch (e) {
    console.error("Playback error", e)
  }
}

function createBlob(data: Float32Array): { data: string; mimeType: string } {
  const l = data.length
  const int16 = new Int16Array(l)
  for (let i = 0; i < l; i++) {
    const s = Math.max(-1, Math.min(1, data[i]))
    int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff
  }
  return {
    data: encodeAudio(new Uint8Array(int16.buffer)),
    mimeType: "audio/pcm;rate=16000",
  }
}

export const BoardWorkspace = forwardRef<BoardApi, Props>(function BoardWorkspace({ assignmentId, courseId, initial, readOnly = false, busy, onAsk }, ref) {
  const [seed] = useState(() => fromLegacy(initial))
  const [hist, setHist] = useState<History>(() => startHistory(seed))
  const [tool, setTool] = useState<Tool>("select")
  const [grid, setGrid] = useState(false)
  const [theme, setTheme] = useState<"light" | "dark">("light")
  // Colour/width are kept per tool family (pen, highlighter, shapes) so switching tools never
  // overwrites another tool's settings. See lib/toolSettings.ts.
  const [toolSettings, setToolSettings] = useState<ToolSettings>(DEFAULT_TOOL_SETTINGS)
  const toolRef = useRef<Tool>(tool)
  toolRef.current = tool
  const activeSetting = toolSettings[settingsFamily(tool)]
  const currentColor = activeSetting.color
  const strokeWidth = activeSetting.width
  const setCurrentColor = useCallback((color: string) => {
    setToolSettings((s) => applyExplicitColor(s, toolRef.current, color))
  }, [])
  /** Mirror a selected element's colour in the toolbar WITHOUT changing the pen/highlighter defaults. */
  const showColor = useCallback((color: string) => {
    setToolSettings((s) => updateToolSetting(s, "select", { color }))
  }, [])
  const setStrokeWidth = useCallback((width: number) => {
    setToolSettings((s) => updateToolSetting(s, toolRef.current, { width }))
  }, [])
  const [filled, setFilled] = useState(false)
  const [fontSize, setFontSize] = useState(24)
  const [viewState, setViewState] = useState<ViewState>({ x: 0, y: 0, scale: 0.4 })
  const clipboardRef = useRef<BoardElement[]>([])

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [fresh, setFresh] = useState<Map<string, number>>(new Map())
  const [eq, setEq] = useState<{ x: number; y: number; editId?: string; value: string } | null>(null)
  const [eqOk, setEqOk] = useState(true)
  const [confirmClear, setConfirmClear] = useState(false)
  const [askOpen, setAskOpen] = useState(false)
  const [status, setStatus] = useState("")

  // AI & Voice State
  const [aiState, setAiState] = useState<AIState>({ isConnected: false, isListening: false, modelState: "idle" })
  const [isAIProcessing, setIsAIProcessing] = useState(false)

  // Floating SmartBoard AI Chat State
  const [chatMessages, setChatMessages] = useState<Array<{ id: string; role: "user" | "model"; text: string; audio?: string; mimeType?: string; sources?: Array<{ source?: string; title?: string; page?: number; score?: number }> }>>([])
  const [chatInputText, setChatInputText] = useState("")
  const [isChatProcessing, setIsChatProcessing] = useState(false)
  const [showChat, setShowChat] = useState(false)
  const [isRecordingChat, setIsRecordingChat] = useState(false)
  const chatMediaRecorderRef = useRef<MediaRecorder | null>(null)
  const chatAudioChunksRef = useRef<Blob[]>([])
  const chatEndRef = useRef<HTMLDivElement>(null)
  const smartBoardRef = useRef<SmartBoardHandle | null>(null)

  const board = hist.present
  const latest = useRef<Board>(seed)
  const dirty = useRef(seed.steps.length !== initial.steps.length || initial.steps.some((s) => s.trim()))
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const sel = useRef<string | null>(null)
  const selIds = useRef<string[]>([])
  const root = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Live WebSocket Audio & Capture Refs
  const liveWsRef = useRef<WebSocket | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const inputContextRef = useRef<AudioContext | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const nextStartTime = useRef<number>(0)
  const activeAudioSourcesRef = useRef<AudioBufferSourceNode[]>([])
  const captureIntervalRef = useRef<number | undefined>(undefined)
  const interactionTracker = useRef<BoardInteractionTracker>(new BoardInteractionTracker())

  const flushRef = useRef<() => Promise<boolean>>(async () => true)
  const flush = useCallback(async (): Promise<boolean> => {
    if (timer.current) {
      clearTimeout(timer.current)
      timer.current = null
    }
    if (!dirty.current || readOnly) return true
    const snapshot = latest.current
    setStatus("Saving…")
    try {
      await saveWhiteboard(assignmentId, toWire(snapshot))
      if (latest.current === snapshot) dirty.current = false
      setStatus("Saved")
      return true
    } catch (e: any) {
      if (e?.status === 413 || e?.code === "board_too_large" || (e?.message && e.message.includes("413"))) {
        setStatus("Board exceeds storage limit (400KB). Please remove some strokes or images.")
      } else {
        setStatus("Couldn't save. Will retry.")
        timer.current = setTimeout(() => void flushRef.current(), 4000)
      }
      return false
    }
  }, [assignmentId, readOnly])

  useEffect(() => {
    flushRef.current = flush
  }, [flush])

  const schedule = useCallback(() => {
    dirty.current = true
    setStatus("Unsaved changes")
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => void flush(), 1200)
  }, [flush])

  const change = useCallback(
    (b: Board, opts?: { coalesce?: string }) => {
      latest.current = b
      setHist((h) => commit(h, b, opts?.coalesce))
      schedule()
    },
    [schedule]
  )

  const handleColorChange = useCallback((newColor: string) => {
    setCurrentColor(newColor)
    const targetIds = new Set(selIds.current.length > 0 ? selIds.current : sel.current ? [sel.current] : [])
    if (targetIds.size > 0) {
      const updated = latest.current.elements.map((el) =>
        targetIds.has(el.id) ? { ...el, color: newColor } : el
      )
      change({ ...latest.current, elements: updated })
    }
  }, [change])

  const handleStrokeWidthChange = useCallback((newWidth: number) => {
    setStrokeWidth(newWidth)
    const targetIds = new Set(selIds.current.length > 0 ? selIds.current : sel.current ? [sel.current] : [])
    if (targetIds.size > 0) {
      const updated = latest.current.elements.map((el) =>
        targetIds.has(el.id) ? { ...el, strokeWidth: newWidth } : el
      )
      change({ ...latest.current, elements: updated })
    }
  }, [change])

  const handleFillToggle = useCallback(() => {
    const nextFilled = !filled
    setFilled(nextFilled)
    const targetIds = new Set(selIds.current.length > 0 ? selIds.current : sel.current ? [sel.current] : [])
    if (targetIds.size > 0) {
      const updated = latest.current.elements.map((el) =>
        targetIds.has(el.id) ? { ...el, filled: nextFilled } : el
      )
      change({ ...latest.current, elements: updated })
    }
  }, [filled, change])

  const handleFontSizeChange = useCallback((newSize: number) => {
    setFontSize(newSize)
    const targetIds = new Set(selIds.current.length > 0 ? selIds.current : sel.current ? [sel.current] : [])
    if (targetIds.size > 0) {
      const updated = latest.current.elements.map((el) =>
        targetIds.has(el.id) ? { ...el, fontSize: newSize } : el
      )
      change({ ...latest.current, elements: updated })
    }
  }, [change])

  const handleToolChange = useCallback((nextTool: Tool) => {
    setTool(nextTool)
  }, [])

  const syncToolbarToElement = useCallback((targetEl: BoardElement) => {
    if (targetEl.color) showColor(targetEl.color)
    if (targetEl.strokeWidth) setStrokeWidth(targetEl.strokeWidth)
    if (targetEl.filled !== undefined) setFilled(targetEl.filled)
    if (targetEl.fontSize) setFontSize(targetEl.fontSize)
  }, [])

  const handleStrokeCompleted = useCallback((stroke: Stroke, nextBoard: Board) => {
    const interaction = interactionTracker.current.recordStroke(stroke, nextBoard)
    if (liveWsRef.current && liveWsRef.current.readyState === WebSocket.OPEN) {
      liveWsRef.current.send(JSON.stringify({
        realtimeInput: {
          text: `[BOARD UPDATE]: ${interaction.summary}`
        }
      }))
      // If student performed a selection, underline, or circle, send fresh JPEG frame immediately
      if (interaction.type === "circle" || interaction.type === "underline" || interaction.type === "cross_out" || interaction.target) {
        smartBoardRef.current?.getScreenCapture().then((b64) => {
          if (b64 && liveWsRef.current && liveWsRef.current.readyState === WebSocket.OPEN) {
            const cleanB64 = b64.includes(",") ? b64.split(",")[1] : b64
            liveWsRef.current.send(JSON.stringify({
              realtimeInput: {
                video: {
                  data: cleanB64,
                  mimeType: "image/jpeg",
                },
              },
            }))
          }
        })
      }
    }
  }, [])

  const handleElementMoved = useCallback((id: string, newBox: { x: number; y: number; w: number; h: number }) => {
    interactionTracker.current.recordElementMoved(id, newBox)
  }, [])

  const doUndo = useCallback(() => {
    interactionTracker.current.recordUndo()
    if (liveWsRef.current && liveWsRef.current.readyState === WebSocket.OPEN) {
      try {
        liveWsRef.current.send(JSON.stringify({
          realtimeInput: {
            text: "[BOARD UPDATE]: Student undid their last action."
          }
        }))
      } catch {}
    }
    setHist((h) => {
      const n = undo(h)
      latest.current = n.present
      if (n !== h) schedule()
      return n
    })
  }, [schedule])

  const doRedo = useCallback(() => {
    interactionTracker.current.recordRedo()
    if (liveWsRef.current && liveWsRef.current.readyState === WebSocket.OPEN) {
      try {
        liveWsRef.current.send(JSON.stringify({
          realtimeInput: {
            text: "[BOARD UPDATE]: Student redid their last action."
          }
        }))
      } catch {}
    }
    setHist((h) => {
      const n = redo(h)
      latest.current = n.present
      if (n !== h) schedule()
      return n
    })
  }, [schedule])

  const select = useCallback((id: string | null) => {
    sel.current = id
    setSelectedId(id)
    const nextArr = id ? [id] : []
    selIds.current = nextArr
    setSelectedIds(nextArr)
    if (id) {
      const targetEl = latest.current.elements.find((e) => e.id === id)
      if (targetEl) syncToolbarToElement(targetEl)
    }
  }, [syncToolbarToElement])

  const selectMultiple = useCallback((ids: string[]) => {
    selIds.current = ids
    setSelectedIds(ids)
    const single = ids.length === 1 ? ids[0] : null
    sel.current = single
    setSelectedId(single)
    if (single) {
      const targetEl = latest.current.elements.find((e) => e.id === single)
      if (targetEl) syncToolbarToElement(targetEl)
    }
  }, [syncToolbarToElement])

  const handleCopy = useCallback(() => {
    const targetIds = new Set(selIds.current.length > 0 ? selIds.current : sel.current ? [sel.current] : [])
    if (targetIds.size === 0) return
    const selectedEls = latest.current.elements.filter((el) => targetIds.has(el.id))
    clipboardRef.current = selectedEls
  }, [])

  const handlePaste = useCallback(() => {
    if (!clipboardRef.current || clipboardRef.current.length === 0) return
    const current = latest.current
    const newSelectedIds: string[] = []
    const pasted: BoardElement[] = []
    clipboardRef.current.forEach((el) => {
      const clonedId = "u_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
      const clone: BoardElement = {
        ...el,
        id: clonedId,
        seq: nextSeq(current),
        x: Math.min(BOARD_W - 40, el.x + 30),
        y: Math.min(BOARD_H - 40, el.y + 30),
      }
      if (el.kind === "line" && el.x2 !== undefined && el.y2 !== undefined) {
        clone.x2 = Math.min(BOARD_W, el.x2 + 30)
        clone.y2 = Math.min(BOARD_H, el.y2 + 30)
      }
      pasted.push(clone)
      newSelectedIds.push(clonedId)
    })
    change({ ...current, elements: [...current.elements, ...pasted] })
    selectMultiple(newSelectedIds)
  }, [change, selectMultiple])

  const handleScaleSelected = useCallback((factor: number) => {
    const targetIds = new Set(selIds.current.length > 0 ? selIds.current : sel.current ? [sel.current] : [])
    if (targetIds.size === 0) return
    const updated = latest.current.elements.map((el) => {
      if (targetIds.has(el.id)) {
        const newW = Math.max(20, Math.round(el.w * factor))
        const newH = Math.max(20, Math.round(el.h * factor))
        const next: BoardElement = { ...el, w: newW, h: newH }
        if (el.kind === "line" && el.x2 !== undefined && el.y2 !== undefined) {
          next.x2 = el.x + Math.round((el.x2 - el.x) * factor)
          next.y2 = el.y + Math.round((el.y2 - el.y) * factor)
        }
        return next
      }
      return el
    })
    change({ ...latest.current, elements: updated })
  }, [change])

  const handleSetSizePreset = useCallback((preset: "small" | "medium" | "large") => {
    const targetIds = new Set(selIds.current.length > 0 ? selIds.current : sel.current ? [sel.current] : [])
    if (targetIds.size === 0) return

    const baseSizes: Record<"small" | "medium" | "large", number> = {
      small: 180,
      medium: 320,
      large: 520,
    }
    const targetDim = baseSizes[preset]

    const updated = latest.current.elements.map((el) => {
      if (targetIds.has(el.id)) {
        const ratio = el.w / Math.max(1, el.h)
        let newW = targetDim
        let newH = Math.round(targetDim / ratio)
        if (el.kind === "circle" || el.shape === "circle") {
          newW = targetDim
          newH = targetDim
        } else if (el.kind === "text") {
          const fontSizes = { small: 20, medium: 32, large: 52 }
          return { ...el, fontSize: fontSizes[preset], w: Math.max(120, targetDim) }
        }
        return { ...el, w: newW, h: newH }
      }
      return el
    })
    change({ ...latest.current, elements: updated })
  }, [change])

  const handleDuplicate = useCallback(() => {
    const targetIds = new Set(selIds.current.length > 0 ? selIds.current : sel.current ? [sel.current] : [])
    if (targetIds.size === 0) return
    const current = latest.current
    const clones: BoardElement[] = []
    const newSelectedIds: string[] = []

    current.elements.forEach((el) => {
      if (targetIds.has(el.id)) {
        const newId = "dup_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
        const clone: BoardElement = {
          ...el,
          id: newId,
          x: Math.min(BOARD_W - 40, el.x + 30),
          y: Math.min(BOARD_H - 40, el.y + 30),
        }
        if (el.kind === "line" && el.x2 !== undefined && el.y2 !== undefined) {
          clone.x2 = Math.min(BOARD_W, el.x2 + 30)
          clone.y2 = Math.min(BOARD_H, el.y2 + 30)
        }
        clones.push(clone)
        newSelectedIds.push(newId)
      }
    })

    if (clones.length > 0) {
      change({ ...current, elements: [...current.elements, ...clones] })
      selectMultiple(newSelectedIds)
    }
  }, [change, selectMultiple])

  const handleReorder = useCallback((direction: "front" | "back") => {
    const targetIds = new Set(selIds.current.length > 0 ? selIds.current : sel.current ? [sel.current] : [])
    if (targetIds.size === 0) return
    const current = latest.current
    const selectedEls = current.elements.filter((el) => targetIds.has(el.id))
    const nonSelectedEls = current.elements.filter((el) => !targetIds.has(el.id))

    const reordered = direction === "front"
      ? [...nonSelectedEls, ...selectedEls]
      : [...selectedEls, ...nonSelectedEls]

    change({ ...current, elements: reordered })
  }, [change])

  // ---- Viewport: fit, resize and fullscreen -------------------------------------------------
  // The canvas area is the real parent container of the drawing surface (the surface is full-bleed
  // inside it), so it is what we measure. Floating UI is measured from the DOM, not guessed.
  const areaRef = useRef<HTMLDivElement>(null)
  const initialFitDoneRef = useRef(false)
  /** True once the user (or an AI view command) has taken control of pan/zoom; resizes then leave the view alone. */
  const userAdjustedRef = useRef(false)
  const fittedSizeRef = useRef<{ w: number; h: number } | null>(null)

  const getOcclusion = useCallback((): Occlusion => {
    const measured = measureOcclusion(areaRef.current)
    if (measured) return measured
    // Nothing measurable (e.g. no layout engine): conservative defaults matching the dock sizes.
    const mobile = (areaRef.current?.clientWidth ?? 0) < 640
    return {
      top: mobile ? 110 : 72,
      bottom: showChat ? (mobile ? 360 : 320) : (mobile ? 64 : 56),
      left: 0,
      right: 0,
    }
  }, [showChat])

  /** The drawing surface in CSS px, as the placement engine sees it (same source for placement and reveal). */
  const getContainerDims = useCallback((): ContainerDimensions => {
    const fromBoard = smartBoardRef.current?.getContainerDimensions?.()
    if (fromBoard && isUsableSize(fromBoard.width, fromBoard.height)) return fromBoard
    const a = areaRef.current
    if (a && isUsableSize(a.clientWidth, a.clientHeight)) return { width: a.clientWidth, height: a.clientHeight }
    return {
      width: typeof window !== "undefined" ? window.innerWidth : 1000,
      height: typeof window !== "undefined" ? window.innerHeight : 700,
    }
  }, [])

  /** Programmatic or user view change that should stop automatic re-fitting. */
  const setViewByUser = useCallback((next: ViewState | ((v: ViewState) => ViewState)) => {
    userAdjustedRef.current = true
    setViewState(next)
  }, [])

  /**
   * Zoom-button handler. Zooms about the centre of the visible, unobstructed workspace so the content you are
   * looking at stays put (the buttons used to change only the scale, i.e. zoom about the board's top-left
   * corner, which slid the content away and could leave the visible region off the board altogether).
   */
  const zoomAroundCentre = useCallback((factor: number) => {
    const dims = getContainerDims()
    const occ = getOcclusion()
    const cx = (occ.left + (dims.width - occ.right)) / 2
    const cy = (occ.top + (dims.height - occ.bottom)) / 2
    setViewByUser((v) => zoomAtPoint(v, cx, cy, v.scale * factor))
  }, [getContainerDims, getOcclusion, setViewByUser])

  /** Ids of freshly added elements that could not be placed fully in view ("Show new content" button). */
  const [revealIds, setRevealIds] = useState<string[]>([])

  const handleFitView = useCallback((): boolean => {
    const area = areaRef.current
    if (!area) return false
    const w = area.clientWidth
    const h = area.clientHeight
    // Frame everything the student can see: elements (rotation/line aware) AND freehand ink, so a board
    // that is only handwriting still fits its content instead of the whole empty page.
    const boxes = getOccupiedBoxes(latest.current)
    const view = computeFitView(
      { width: w, height: h },
      contentFitBox(boxes),
      getOcclusion(),
      { maxScale: boxes.length > 0 ? MAX_FIT_SCALE_CONTENT : MAX_FIT_SCALE_EMPTY },
    )
    // Never fit against a hidden, zero-sized or not-yet-laid-out container.
    if (!view) return false
    userAdjustedRef.current = false
    fittedSizeRef.current = { w, h }
    setViewState(view)
    return true
  }, [getOcclusion])

  // Fit once the container has a real size, then only follow size changes while the user has not
  // taken over the view. Layout effect so the first paint already shows the fitted view.
  useLayoutEffect(() => {
    const area = areaRef.current
    if (!area) return
    let raf = 0
    const sync = () => {
      const w = area.clientWidth
      const h = area.clientHeight
      if (!isUsableSize(w, h)) return // hidden (display:none) or not laid out yet: wait for a real size
      if (!initialFitDoneRef.current) {
        if (handleFitView()) initialFitDoneRef.current = true
        return
      }
      if (userAdjustedRef.current) return // preserve the user's manual pan / zoom
      const last = fittedSizeRef.current
      if (!last || Math.abs(last.w - w) > 1 || Math.abs(last.h - h) > 1) handleFitView()
    }
    sync()
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(sync)
    })
    ro.observe(area)
    return () => {
      ro.disconnect()
      cancelAnimationFrame(raf)
    }
  }, [handleFitView])

  const [isFullscreen, setIsFullscreen] = useState(false)

  const toggleFullscreen = useCallback(async () => {
    try {
      if (!document.fullscreenElement) {
        if (root.current?.requestFullscreen) {
          await root.current.requestFullscreen()
        } else {
          setIsFullscreen(true)
        }
      } else {
        if (document.exitFullscreen) {
          await document.exitFullscreen()
        }
        setIsFullscreen(false)
      }
    } catch {
      setIsFullscreen((prev) => !prev)
    }
  }, [])

  // Entering / leaving fullscreen resizes the container; the observer above re-fits only if the
  // user has not taken over the view, so fullscreen no longer throws away a chosen pan / zoom.
  useEffect(() => {
    const handleFullscreenChange = () => setIsFullscreen(!!document.fullscreenElement)
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && isFullscreen) {
        if (document.fullscreenElement && document.exitFullscreen) {
          document.exitFullscreen().catch(() => {})
        }
        setIsFullscreen(false)
      }
    }
    document.addEventListener("fullscreenchange", handleFullscreenChange)
    window.addEventListener("keydown", handleKeyDown)
    return () => {
      document.removeEventListener("fullscreenchange", handleFullscreenChange)
      window.removeEventListener("keydown", handleKeyDown)
    }
  }, [isFullscreen])

  useImperativeHandle(
    ref,
    () => ({
      flush,
      selectedId: () => sel.current,
      applyServer: (raw) => {
        const next = fromServer(raw)
        const before = new Set(latest.current.elements.map((e) => e.id))
        const added = next.elements.filter((e) => e.author === "coach" && !before.has(e.id)).map((e) => e.id)
        if (timer.current) {
          clearTimeout(timer.current)
          timer.current = null
        }
        dirty.current = false
        latest.current = next
        setHist((h) => commit(h, next))
        setFresh(new Map(added.map((id, i) => [id, i])))
        setStatus("Saved")
        return added.length
      },
    }),
    [flush]
  )

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current)
    if (dirty.current && !readOnly) void saveWhiteboard(assignmentId, toWire(latest.current)).catch(() => undefined)
  }, [assignmentId, readOnly])

  const handleReveal = useCallback(() => {
    const area = areaRef.current
    if (!area) return
    const targets = latest.current.elements.filter((e) => revealIds.includes(e.id))
    const view = computeRevealView(
      { width: area.clientWidth, height: area.clientHeight },
      targets.map((e) => getElementBoundingBox(e)),
      getOcclusion(),
      viewState,
    )
    if (view) setViewByUser(view)
    setRevealIds([])
  }, [revealIds, getOcclusion, setViewByUser, viewState])

  // Drop the button once everything it points at is visible (or was deleted).
  useEffect(() => {
    if (revealIds.length === 0) return
    const area = areaRef.current
    const targets = board.elements.filter((e) => revealIds.includes(e.id))
    if (targets.length === 0) { setRevealIds([]); return }
    if (!area) return
    const dims = getContainerDims()
    const occ = getOcclusion()
    if (targets.every((e) => isPlacementVisible(getElementBoundingBox(e), viewState, dims, occ))) setRevealIds([])
  }, [viewState, board.elements, revealIds, getContainerDims, getOcclusion])

  // Keyboard shortcuts
  useEffect(() => {
    if (readOnly) return
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return
      if (!root.current || root.current.closest(".hidden")) return
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault()
        if (e.shiftKey) doRedo()
        else doUndo()
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") {
        // Ctrl+Y is the conventional redo on Windows; it previously swallowed the key and did nothing.
        e.preventDefault()
        doRedo()
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "d" && !busy) {
        if (selIds.current.length > 0 || sel.current) {
          e.preventDefault()
          handleDuplicate()
        }
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "c" && !busy) {
        if (selIds.current.length > 0 || sel.current) {
          e.preventDefault()
          handleCopy()
        }
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "v" && !busy) {
        if (clipboardRef.current.length > 0) {
          e.preventDefault()
          handlePaste()
        }
      } else if ((e.key === "Delete" || e.key === "Backspace") && !busy) {
        if (selIds.current.length > 0) {
          e.preventDefault()
          change(removeElements(latest.current, selIds.current))
          select(null)
        } else if (sel.current) {
          e.preventDefault()
          change(removeElement(latest.current, sel.current))
          select(null)
        }
      } else if (!e.ctrlKey && !e.metaKey && !e.altKey) {
        // Single-letter tool shortcuts, exactly as advertised in the toolbar tooltips. Modified keys
        // (Ctrl+P print, Ctrl+T new tab, Ctrl+E ...) must not switch tools.
        const toolForKey: Record<string, Tool> = {
          v: "select", h: "pan", p: "pen", t: "text", e: "eraser",
          r: "rect", o: "ellipse", l: "line", a: "arrow",
        }
        const next = toolForKey[e.key.toLowerCase()]
        if (next) setTool(next)
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [readOnly, busy, change, doUndo, doRedo, select, handleDuplicate, handleCopy, handlePaste])

  // Image Upload handler
  const handleImageUploadClick = () => fileInputRef.current?.click()
  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      const b64 = reader.result as string
      const img = new Image()
      img.onload = () => {
        // Compress and resize image to fit comfortably within DB 400KB limit
        const canvas = document.createElement("canvas")
        const maxDim = 600
        const scale = Math.min(1, maxDim / Math.max(img.width, img.height))
        canvas.width = Math.round(img.width * scale)
        canvas.height = Math.round(img.height * scale)
        const ctx = canvas.getContext("2d")
        if (ctx) {
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
        }
        const compressedB64 = canvas.toDataURL("image/jpeg", 0.75)

        const maxWidth = 450
        const ratio = img.width / img.height
        const w = Math.min(img.width, maxWidth)
        const h = w / ratio
        const containerDims = smartBoardRef.current?.getContainerDimensions?.() || {
          width: typeof window !== "undefined" ? window.innerWidth : 1000,
          height: typeof window !== "undefined" ? window.innerHeight : 700,
        }
        const pos = getSmartPlacement(latest.current, viewState, w, h, sel.current, containerDims.width, containerDims.height, getOcclusion())
        const newEl: BoardElement = {
          id: "u_img_" + Date.now().toString(36),
          kind: "image",
          author: "student",
          seq: 0,
          x: pos.x,
          y: pos.y,
          w,
          h,
          src: compressedB64,
          color: "#000000",
          rotation: 0,
        }
        change({ ...latest.current, elements: [...latest.current.elements, newEl] })
      }
      img.src = b64
    }
    reader.readAsDataURL(file)
    if (fileInputRef.current) fileInputRef.current.value = ""
  }

  // Whiteboard Function-calling tools execution (for Gemini Live and Chat)
  /**
   * A generation request (image / simulation / diagram) failed or returned nothing. Remove the grey
   * loading placeholder that would otherwise stay on the board forever and tell the user in the chat.
   * Only a placeholder that is still loading is removed, so finished or student content is never touched.
   */
  const reportGenerationFailure = (placeholderId: string | null, what: string) => {
    if (placeholderId) {
      const removeIfStillLoading = () => {
        const cur = latest.current
        if (!cur.elements.some((e) => e.id === placeholderId)) return false
        if (cur.elements.some((e) => e.id === placeholderId && e.isLoading)) {
          change({ ...cur, elements: cur.elements.filter((e) => e.id !== placeholderId) })
        }
        return true
      }
      // The failure can arrive before the placeholder batch is committed; retry once.
      if (!removeIfStillLoading()) setTimeout(removeIfStillLoading, 150)
    }
    setChatMessages((prev) => [
      ...prev,
      { id: `${Date.now()}-gen-err`, role: "model", text: `⚠️ Couldn't generate the ${what}. Please try again.` },
    ])
  }

  const executeTools = async (functionCalls: any[]) => {
    const responses = []
    let addedElements: BoardElement[] = []
    let shouldClear = false
    let toDeleteIds: Set<string> = new Set()
    let toMove: Array<{ id: string; x: number; y: number }> = []

    const containerDims: ContainerDimensions = getContainerDims()
    const uiOcclusion: UiOcclusion = getOcclusion()
    const vpAnalysis = computeUnobstructedVisibleViewport(viewState, containerDims, uiOcclusion)

    const normalizeCoords = (x?: number, y?: number, w = 300, h = 100, currentBoard?: Board) => {
      // Elements already queued in this tool call are not on the board yet; count them as occupied.
      const boardToUse = currentBoard || (addedElements.length > 0
        ? { ...latest.current, elements: [...latest.current.elements, ...addedElements] }
        : latest.current)
      if (x === undefined || y === undefined || !Number.isFinite(x) || !Number.isFinite(y) || (x === 0 && y === 0)) {
        const preferredPos = sel.current
          ? (() => {
              const s = boardToUse.elements.find((e) => e.id === sel.current)
              return s ? { x: s.x + s.w + 24, y: s.y } : undefined
            })()
          : undefined
        return findCollisionFreePosition(boardToUse, w, h, preferredPos, [], viewState, 20, containerDims, uiOcclusion)
      }
      const clampedX = Math.round(Math.max(20, Math.min(BOARD_W - w - 20, x)))
      const clampedY = Math.round(Math.max(20, Math.min(BOARD_H - h - 20, y)))
      // Step 5: Validate collision against student work and all existing elements
      return findCollisionFreePosition(boardToUse, w, h, { x: clampedX, y: clampedY }, [], viewState, 20, containerDims, uiOcclusion)
    }

    // Pre-plan multi-element batches through coordinated batch layout
    const layoutToolNames = new Set([
      "write_text", "add_text", "add_equation", "draw_rectangle", "draw_circle",
      "draw_triangle", "draw_line", "add_line", "draw_arrow", "add_arrow", "draw_path"
    ])
    const batchCandidates = functionCalls.filter((fc) => {
      const n = fc.name || fc.function_name || ""
      return layoutToolNames.has(n)
    })
    // Plan any batch of 2+ drawing calls, and ANY batch that contains a line/arrow/path (their geometry
    // must be validated and moved rigidly, never patched point by point).
    const geometryToolNames = new Set(["draw_line", "add_line", "draw_arrow", "add_arrow", "draw_path"])
    const needsBatchPlan =
      batchCandidates.length >= 2 ||
      batchCandidates.some((fc) => geometryToolNames.has(fc.name || fc.function_name || ""))
    let batchPlannedMap: Map<any, LayoutItem> | null = null
    const batchRejected = new Map<any, string>()
    if (needsBatchPlan) {
      try {
        const batchPlan = planBatchLayout(batchCandidates, latest.current, viewState, sel.current, containerDims, uiOcclusion)
        batchPlannedMap = new Map()
        // Pair by sourceIndex: the plan lists content, then paths, then connectors, NOT call order.
        for (const item of batchPlan.items) batchPlannedMap.set(batchCandidates[item.sourceIndex], item)
        for (const r of batchPlan.rejected) {
          if (r.sourceIndex !== undefined) batchRejected.set(batchCandidates[r.sourceIndex], r.reason)
        }
      } catch (err) {
        console.warn("planBatchLayout fallback to sequential placement:", err)
        batchPlannedMap = null
      }
    }

    for (const fc of functionCalls) {
      const planned = batchPlannedMap ? batchPlannedMap.get(fc) : null
      const rawName = fc.name || fc.function_name || ""
      const name = rawName === "add_text" ? "write_text"
        : rawName === "add_line" ? "draw_line"
        : rawName === "add_arrow" ? "draw_arrow"
        : rawName === "move" ? "move_element_at"
        : rawName === "delete" ? "delete_element_at"
        : rawName
      const args = fc.args || fc.parameters || {}
      let result: Record<string, any> = { result: "ok" }
      const explicitId: string | undefined = fc.element_id || fc.functionCall?.element_id
      const id = explicitId || planned?.id || ("st_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6))
      const idTaken = !!explicitId && (latest.current.elements.some((e) => e.id === id) || addedElements.some((e) => e.id === id))

      try {
        if (batchRejected.has(fc)) {
          result = { error: batchRejected.get(fc) }
        } else if (idTaken && name !== "pan_view" && name !== "move_element_at" && name !== "delete_element_at") {
          // A repeated call must never create a second copy (or re-place the first one).
          result = { result: "Element already exists; not duplicated." }
        } else if (name === "pan_view") {
          setViewByUser((v) => {
            const a = areaRef.current
            const cw = a?.clientWidth || 0
            const ch = a?.clientHeight || 0
            // Centre the requested board point in the container at the current zoom.
            return isUsableSize(cw, ch)
              ? { ...v, x: (args.x || 0) - cw / (2 * v.scale), y: (args.y || 0) - ch / (2 * v.scale) }
              : { ...v, x: (args.x || 0) - 500, y: (args.y || 0) - 300 }
          })
          result = { result: "View moved." }
        } else if (name === "delete_element_at") {
          const target = latest.current.elements.find((el) => Math.hypot(el.x + el.w / 2 - args.x, el.y + el.h / 2 - args.y) < 120)
          if (target) {
            if (target.author === "student") {
              result = { error: "Cannot delete student-authored work; student work is protected." }
            } else {
              toDeleteIds.add(target.id)
              result = { result: "Element deleted." }
            }
          }
        } else if (name === "move_element_at") {
          const target = latest.current.elements.find((el) => Math.hypot(el.x + el.w / 2 - args.x, el.y + el.h / 2 - args.y) < 120)
          if (target) {
            if (target.author === "student") {
              result = { error: "Cannot move student-authored work; student work is protected." }
            } else {
              toMove.push({ id: target.id, x: args.new_x, y: args.new_y })
              result = { result: "Element moved." }
            }
          }
        } else if (name === "draw_rectangle") {
          const w = planned ? planned.box.w : (args.width || 120)
          const h = planned ? planned.box.h : (args.height || 80)
          const coords = planned ? { x: planned.box.x, y: planned.box.y } : normalizeCoords(args.x, args.y, w, h)
          addedElements.push({
            id,
            kind: "shape",
            shape: "rect",
            author: "coach",
            seq: 0,
            x: coords.x,
            y: coords.y,
            w,
            h,
            color: args.color || "#3b82f6",
            filled: args.filled,
          })
        } else if (name === "draw_circle") {
          const r = args.radius || 40
          const size = planned ? planned.box.w : r * 2
          const coords = planned ? { x: planned.box.x, y: planned.box.y } : normalizeCoords(args.x !== undefined ? args.x - r : undefined, args.y !== undefined ? args.y - r : undefined, size, size)
          addedElements.push({
            id,
            kind: "circle",
            shape: "circle",
            author: "coach",
            seq: 0,
            x: coords.x,
            y: coords.y,
            w: size,
            h: size,
            color: args.color || "#ef4444",
            filled: args.filled,
          })
        } else if (name === "draw_triangle") {
          const w = planned ? planned.box.w : (args.width || 100)
          const h = planned ? planned.box.h : (args.height || 100)
          const coords = planned ? { x: planned.box.x, y: planned.box.y } : normalizeCoords(args.x, args.y, w, h)
          addedElements.push({
            id,
            kind: "triangle",
            shape: "triangle",
            author: "coach",
            seq: 0,
            x: coords.x,
            y: coords.y,
            w,
            h,
            color: args.color || "#16a34a",
            filled: args.filled,
          })
        } else if (name === "draw_line") {
          // Planned geometry already preserves direction and length (a rigid translation of the AI's line).
          const seg: Segment = planned
            ? { x1: planned.args.x1, y1: planned.args.y1, x2: planned.args.x2, y2: planned.args.y2 }
            : (readSegment(args) ?? { x1: 100, y1: 100, x2: 240, y2: 100 })
          addedElements.push({
            id,
            kind: "line",
            author: "coach",
            seq: 0,
            ...lineElementGeometry(seg),
            color: args.color || "#000000",
            strokeWidth: finiteNumber(args.strokeWidth) || 3,
          })
        } else if (name === "draw_path") {
          // pathData is element-local (rendered as translate(x, y)); the planner re-bases it and returns the
          // drawn region, so moving a path only ever changes x / y.
          const intent = planned ? null : resolvePathIntent(args)
          if (!planned && !intent) {
            result = { error: "draw_path needs a non-empty pathData string." }
          } else {
            const box = planned ? planned.box : intent!.box
            addedElements.push({
              id,
              kind: "path",
              author: "coach",
              seq: 0,
              x: box.x,
              y: box.y,
              w: box.w,
              h: box.h,
              pathData: planned ? planned.args.pathData : intent!.pathData,
              color: args.color || "#000000",
              strokeWidth: finiteNumber(args.strokeWidth) || 3,
            })
          }
        } else if (name === "draw_arrow") {
          let seg: Segment = planned
            ? { x1: planned.args.x1, y1: planned.args.y1, x2: planned.args.x2, y2: planned.args.y2 }
            : (readSegment(args) ?? { x1: 100, y1: 100, x2: 240, y2: 100 })
          const fromId = args.from_element_id || args.fromId || args.from || planned?.args?.fromId
          const toId = args.to_element_id || args.toId || args.to || planned?.args?.toId
          if (!planned && fromId && toId) {
            const allEls = [...latest.current.elements, ...addedElements]
            const fromEl = allEls.find((e) => e.id === fromId)
            const toEl = allEls.find((e) => e.id === toId)
            if (fromEl && toEl) {
              const arrowPts = computeArrowEndpoints(getElementBoundingBox(fromEl), getElementBoundingBox(toEl))
              seg = { x1: arrowPts.x1, y1: arrowPts.y1, x2: arrowPts.x2, y2: arrowPts.y2 }
            }
          }
          addedElements.push({
            id,
            kind: "arrow",
            author: "coach",
            seq: 0,
            // Start at (x, y) with SIGNED w / h: that is what the renderer draws and keeps left/up arrows pointing the right way.
            ...arrowElementGeometry(seg),
            fromId,
            toId,
            color: args.color || "#2563eb",
            strokeWidth: finiteNumber(args.strokeWidth) || 4,
          })
        } else if (name === "write_text") {
          const dims = estimateContentDimensions(
            {
              kind: "text",
              text: args.text,
              fontSize: args.fontSize,
              role: args.role,
            },
            vpAnalysis.unobstructedVisibleRect
          )
          const currentBoardState: Board = {
            ...latest.current,
            elements: [...latest.current.elements, ...addedElements],
          }
          const targetPos = planned ? { x: planned.box.x, y: planned.box.y } : normalizeCoords(args.x, args.y, dims.w, dims.h, currentBoardState)
          addedElements.push({
            id,
            kind: "text",
            author: "coach",
            seq: 0,
            x: targetPos.x,
            y: targetPos.y,
            w: planned ? planned.box.w : dims.w,
            h: planned ? planned.box.h : dims.h,
            text: args.text,
            color: args.color || "#000000",
            fontSize: planned?.args?.fontSize || dims.fontSize,
          })
        } else if (name === "add_equation") {
          const dims = estimateContentDimensions(
            { kind: "equation", latex: args.latex },
            vpAnalysis.unobstructedVisibleRect
          )
          const currentBoardState: Board = {
            ...latest.current,
            elements: [...latest.current.elements, ...addedElements],
          }
          const targetPos = planned ? { x: planned.box.x, y: planned.box.y } : normalizeCoords(args.x, args.y, dims.w, dims.h, currentBoardState)
          addedElements.push({
            id,
            kind: "equation",
            author: "coach",
            seq: 0,
            x: targetPos.x,
            y: targetPos.y,
            w: planned ? planned.box.w : dims.w,
            h: planned ? planned.box.h : dims.h,
            latex: args.latex,
            color: args.color || "#000000",
          })
        } else if (name === "add_plot") {
          const dims = estimateContentDimensions(
            { kind: "plot", title: args.title, expression: args.expression },
            vpAnalysis.unobstructedVisibleRect
          )
          const w = dims.w
          const h = dims.h
          const currentBoardState: Board = {
            ...latest.current,
            elements: [...latest.current.elements, ...addedElements],
          }
          const targetPos = normalizeCoords(args.x, args.y, w, h, currentBoardState)
          const placeholder: BoardElement = {
            id,
            kind: "shape",
            shape: "rect",
            author: "coach",
            seq: 0,
            x: targetPos.x,
            y: targetPos.y,
            w,
            h,
            color: "#e2e8f0",
            filled: true,
            isLoading: true,
          }
          addedElements.push(placeholder)
          const plotPrompt = `Create an interactive function plot / graph simulation for: "${args.title || 'Function Plot'}" with math formula "${args.expression}". Include interactive axes, coordinate grid, and clear visualization.`
          generateSimulationCode(plotPrompt).then((code) => {
            if (code) {
              const current = latest.current
              const updated = current.elements.map((e) =>
                e.id === id ? { ...e, kind: "simulation" as const, code, title: args.title || "Math Plot", isLoading: false } : e
              )
              change({ ...current, elements: updated })
              setTimeout(() => {
                if (smartBoardRef.current) {
                  const renderedBounds = smartBoardRef.current.getAllRenderedBounds()
                  if (renderedBounds.size > 0) {
                    const { needsReflow, updatedElements } = verifyAndReflowLayout(latest.current, renderedBounds, 20, { onlyIds: new Set([id]) })
                    if (needsReflow) change({ ...latest.current, elements: updatedElements })
                  }
                }
              }, 80)
            }
          })
        } else if (name === "clear_board") {
          shouldClear = true
          result = { result: "Cleared coach elements; preserved student work and notes." }
        } else if (name === "generate_image") {
          const dims = estimateContentDimensions(
            { kind: "image" },
            vpAnalysis.unobstructedVisibleRect
          )
          const w = dims.w
          const h = dims.h
          const currentBoardState: Board = {
            ...latest.current,
            elements: [...latest.current.elements, ...addedElements],
          }
          const targetPos = normalizeCoords(args.x, args.y, w, h, currentBoardState)
          const placeholder: BoardElement = {
            id,
            kind: "shape",
            shape: "rect",
            author: "coach",
            seq: 0,
            x: targetPos.x,
            y: targetPos.y,
            w,
            h,
            color: "#e2e8f0",
            filled: true,
            isLoading: true,
          }
          addedElements.push(placeholder)
          generateImageContent(args.prompt, args.size || "1K").then((src) => {
            if (src) {
              const current = latest.current
              const updated = current.elements.map((e) => (e.id === id ? { ...e, kind: "image" as const, src, isLoading: false } : e))
              change({ ...current, elements: updated })
              setTimeout(() => {
                if (smartBoardRef.current) {
                  const renderedBounds = smartBoardRef.current.getAllRenderedBounds()
                  if (renderedBounds.size > 0) {
                    const { needsReflow, updatedElements } = verifyAndReflowLayout(latest.current, renderedBounds, 20, { onlyIds: new Set([id]) })
                    if (needsReflow) change({ ...latest.current, elements: updatedElements })
                  }
                }
              }, 80)
            } else {
              reportGenerationFailure(id, "image")
            }
          })
        } else if (name === "generate_simulation") {
          const dims = estimateContentDimensions(
            { kind: "simulation", title: args.title },
            vpAnalysis.unobstructedVisibleRect
          )
          const w = dims.w
          const h = dims.h
          const currentBoardState: Board = {
            ...latest.current,
            elements: [...latest.current.elements, ...addedElements],
          }
          const targetPos = normalizeCoords(args.x, args.y, w, h, currentBoardState)
          const placeholder: BoardElement = {
            id,
            kind: "shape",
            shape: "rect",
            author: "coach",
            seq: 0,
            x: targetPos.x,
            y: targetPos.y,
            w,
            h,
            color: "#e2e8f0",
            filled: true,
            isLoading: true,
          }
          addedElements.push(placeholder)
          generateSimulationCode(args.prompt).then((code) => {
            if (code) {
              const current = latest.current
              const updated = current.elements.map((e) =>
                e.id === id ? { ...e, kind: "simulation" as const, code, title: args.title, isLoading: false } : e
              )
              change({ ...current, elements: updated })
              setTimeout(() => {
                if (smartBoardRef.current) {
                  const renderedBounds = smartBoardRef.current.getAllRenderedBounds()
                  if (renderedBounds.size > 0) {
                    const { needsReflow, updatedElements } = verifyAndReflowLayout(latest.current, renderedBounds, 20, { onlyIds: new Set([id]) })
                    if (needsReflow) change({ ...latest.current, elements: updatedElements })
                  }
                }
              }, 80)
            } else {
              reportGenerationFailure(id, "simulation")
            }
          })
        } else if (name === "generate_vector_drawing") {
          setIsAIProcessing(true)
          generateVectorDrawing(args.prompt).then((shapes) => {
            setIsAIProcessing(false)
            if (shapes && Array.isArray(shapes) && shapes.length > 0) {
              // Calculate composite bounding box of vector shapes
              let minX = Infinity
              let minY = Infinity
              let maxX = -Infinity
              let maxY = -Infinity
              shapes.forEach((s: any) => {
                const sx = s.x || 0
                const sy = s.y || 0
                const sw = s.width || (s.radius ? s.radius * 2 : 80)
                const sh = s.height || (s.radius ? s.radius * 2 : 80)
                minX = Math.min(minX, sx)
                minY = Math.min(minY, sy)
                maxX = Math.max(maxX, sx + sw)
                maxY = Math.max(maxY, sy + sh)
              })
              const totalW = Math.max(100, maxX - minX)
              const totalH = Math.max(80, maxY - minY)
              const originPos = normalizeCoords(args.x, args.y, totalW, totalH)

              const baseId = fc.element_id || fc.functionCall?.element_id || id
              const newShapes: BoardElement[] = shapes.map((s: any, idx: number) => ({
                id: `${baseId}_${idx}`,
                kind: s.type === "circle" ? "circle" : s.type === "triangle" ? "triangle" : s.type === "line" ? "line" : "shape",
                shape: s.type === "circle" ? "circle" : s.type === "triangle" ? "triangle" : "rect",
                author: "coach",
                seq: 0,
                x: originPos.x + ((s.x || 0) - minX),
                y: originPos.y + ((s.y || 0) - minY),
                w: s.width || (s.radius ? s.radius * 2 : 80),
                h: s.height || (s.radius ? s.radius * 2 : 80),
                color: s.color || "#000",
                filled: !!s.filled,
              }))
              change({ ...latest.current, elements: [...latest.current.elements, ...newShapes] })
            } else {
              reportGenerationFailure(null, "diagram")
            }
          })
        } else if (name === "search_course_materials") {
          const query = args.query || ""
          try {
            const chunks = await retrieveCourseMaterials(
              query,
              assignmentId || undefined,
              courseId || undefined,
              args.top_k || 3
            )
            if (chunks && chunks.length > 0) {
              result = {
                results: chunks.map((r: any) => ({
                  title: r.document_title || r.source,
                  page: r.page_number,
                  content: (r.content || "").slice(0, 500),
                })),
              } as any
            } else {
              result = { results: [], message: "No relevant materials found in the course index for this query." } as any
            }
          } catch (err: any) {
            result = { error: "Failed to search materials", details: err?.message || String(err) } as any
          }
        } else if (name === "get_board_context") {
          const analysis = readBoardState(latest.current)
          const recentInteractions = interactionTracker.current.getRecentInteractions()
          const latestSel = interactionTracker.current.getLatestSelection()
          const summary = smartBoardRef.current?.getBoardSummary() || ""

          result = {
            elementCount: latest.current.elements.length,
            elements: latest.current.elements.map((e) => ({
              id: e.id,
              type: e.kind,
              author: e.author,
              x: Math.round(e.x),
              y: Math.round(e.y),
              w: Math.round(e.w),
              h: Math.round(e.h),
              text: (e as any).text || (e as any).title || (e as any).latex || "",
            })),
            studentElements: analysis.studentElements.map((e) => ({
              id: e.id,
              type: e.kind,
              text: e.text || e.latex || "",
            })),
            selectedId: sel.current || null,
            latestSelection: latestSel,
            recentInteractions: recentInteractions.map((i) => ({
              type: i.type,
              summary: i.summary,
              isAmbiguous: i.isAmbiguous,
              target: i.target,
            })),
            realtimeInteractionSummary: interactionTracker.current.getRealtimeSummary(),
            boardOccupancySummary: analysis.summary,
            boardSummaryText: summary,
          } as any
        } else {
          // A name that matches nothing above used to fall through with the default { result: "ok" }, i.e.
          // an unsupported operation was reported to the model as a success although nothing was drawn.
          result = { error: `Unsupported tool "${rawName}". Nothing was added to the board.` }
        }
      } catch (e) {
        console.error(e)
        result = { error: `Error executing ${rawName || "tool"}: ${(e as Error)?.message || "unknown error"}` }
      }
      responses.push({ id: fc.id, name: fc.name, response: result })
    }

    if (shouldClear || addedElements.length > 0 || toDeleteIds.size > 0 || toMove.length > 0) {
      // Protect student work: clear_board only clears coach elements, preserving student work
      let next = shouldClear
        ? latest.current.elements.filter((e) => e.author === "student")
        : [...latest.current.elements]
      if (toDeleteIds.size > 0) next = next.filter((e) => !toDeleteIds.has(e.id))
      if (toMove.length > 0) {
        next = next.map((e) => {
          const op = toMove.find((m) => m.id === e.id)
          return op ? { ...e, x: op.x, y: op.y } : e
        })
      }
      next = [...next, ...addedElements]
      change({ ...latest.current, elements: next })

      // Never leave new content silently out of sight: if some of it is not fully inside the visible
      // area, say so. The view itself is not moved, so the student's position is never hijacked.
      const offscreen = addedElements.filter(
        (e) => !e.isLoading && !isPlacementVisible(getElementBoundingBox(e), viewState, containerDims, uiOcclusion),
      )
      if (offscreen.length > 0) {
        setRevealIds(offscreen.map((e) => e.id))
        setChatMessages((prev) => [
          ...prev,
          {
            id: `${Date.now()}-offscreen`,
            role: "model",
            text: `I added ${offscreen.length === 1 ? "something" : `${offscreen.length} items`} outside the part of the board you can see right now. Use the Show new content button on the board to jump to ${offscreen.length === 1 ? "it" : "them"}.`,
          },
        ])
      }

      // Step 6: Post-render verification & reflow if DOM dimensions caused unexpected overlaps
      setTimeout(() => {
        if (smartBoardRef.current) {
          const renderedBounds = smartBoardRef.current.getAllRenderedBounds()
          if (renderedBounds.size > 0) {
            // Only what THIS batch added may be nudged: older coach content must never move because a new batch landed.
            const batchIds = new Set(addedElements.map((e) => e.id))
            const { needsReflow, updatedElements } = verifyAndReflowLayout(latest.current, renderedBounds, 20, { onlyIds: batchIds })
            if (needsReflow) {
              change({ ...latest.current, elements: updatedElements })
            }
          }
        }
      }, 60)
    }
    return responses
  }

  // Gemini Multimodal Live Connection
  const disconnectLive = useCallback(() => {
    if (liveWsRef.current) {
      const ws = liveWsRef.current
      liveWsRef.current = null
      ws.onclose = null
      ws.onerror = null
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } }))
        } catch {}
      }
      try {
        ws.close()
      } catch {}
    }
    for (const s of activeAudioSourcesRef.current) {
      try { s.stop() } catch {}
    }
    activeAudioSourcesRef.current = []
    nextStartTime.current = 0
    if (audioContextRef.current) {
      try { audioContextRef.current.close() } catch {}
      audioContextRef.current = null
    }
    if (inputContextRef.current) {
      try { inputContextRef.current.close() } catch {}
      inputContextRef.current = null
    }
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    if (captureIntervalRef.current) {
      clearInterval(captureIntervalRef.current)
      captureIntervalRef.current = undefined
    }
    setAiState({ isConnected: false, isListening: false, modelState: "idle" })
  }, [])

  const connectToLiveAPI = async () => {
    if (liveWsRef.current) return
    setAiState((s) => ({ ...s, modelState: "connecting" }))

    try {
      const wsUrl = getLiveWebSocketUrl()
      const ws = new WebSocket(wsUrl)
      liveWsRef.current = ws

      ws.onopen = async () => {
        let token: string | null = null
        try {
          if (typeof accessToken === "function") {
            token = await accessToken()
          }
        } catch {
          // Token unavailable in test environment or offline
        }
        const setup = {
          token: token || undefined,
          assignment_id: assignmentId || undefined,
          course_id: courseId || undefined,
          setup: {
            model: `models/${MODEL_NAMES.LIVE}`,
            generationConfig: {
              responseModalities: ["AUDIO"],
              speechConfig: {
                voiceConfig: {
                  prebuiltVoiceConfig: {
                    voiceName: "Puck",
                  },
                },
              },
            },
            systemInstruction: { parts: [{ text: SMARTBOARD_SYSTEM_INSTRUCTION }] },
            tools: [{ functionDeclarations: whiteboardTools }],
          },
        }
        ws.send(JSON.stringify(setup))
      }

      ws.onmessage = async (event) => {
        let rawText = event.data
        if (event.data instanceof Blob) {
          rawText = await event.data.text()
        } else if (event.data instanceof ArrayBuffer) {
          rawText = new TextDecoder().decode(event.data)
        }
        let data: any
        try {
          data = typeof rawText === "string" ? JSON.parse(rawText) : rawText
        } catch (e) {
          console.error("Live message parse error", e)
          return
        }
        if (!data) return
        if (data.setupComplete || data.setup_complete) {
          setAiState({ isConnected: true, isListening: true, modelState: "idle" })
          // Start Audio Streaming
          try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
            streamRef.current = stream
            inputContextRef.current = new AudioContext({ sampleRate: 16000 })
            const source = inputContextRef.current.createMediaStreamSource(stream)
            const processor = inputContextRef.current.createScriptProcessor(4096, 1, 1)
            source.connect(processor)
            processor.connect(inputContextRef.current.destination)

            processor.onaudioprocess = (e) => {
              const inputData = e.inputBuffer.getChannelData(0)
              // Calculate volume for audio visualizer
              let sum = 0
              for (let i = 0; i < inputData.length; i++) sum += inputData[i] * inputData[i]
              const volume = Math.sqrt(sum / inputData.length)
              window.dispatchEvent(new CustomEvent("audio-volume-update", { detail: volume }))

              const pcmData = createBlob(inputData)
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({
                  realtimeInput: {
                    audio: {
                      data: pcmData.data,
                      mimeType: pcmData.mimeType,
                    },
                  },
                }))
              }
            }

            // Video/Board canvas capture every 2 seconds matching reference
            captureIntervalRef.current = window.setInterval(async () => {
              const b64 = await smartBoardRef.current?.getScreenCapture()
              if (b64 && ws.readyState === WebSocket.OPEN) {
                const cleanB64 = b64.includes(",") ? b64.split(",")[1] : b64
                ws.send(JSON.stringify({
                  realtimeInput: {
                    video: {
                      data: cleanB64,
                      mimeType: "image/jpeg",
                    },
                  },
                }))
              }
            }, 2000)
          } catch (e) {
            console.error("Mic access error", e)
          }
        }

        // Handle tool calls at the top-level (standard Gemini Live format)
        const toolCallObj = data.toolCall || data.tool_call
        if (toolCallObj) {
          const calls = toolCallObj.functionCalls || toolCallObj.function_calls || []
          if (calls.length > 0) {
            const toolResponses = await executeTools(calls)
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({
                toolResponse: {
                  functionResponses: toolResponses.map((tr) => ({
                    id: tr.id,
                    response: tr.response,
                  })),
                },
              }))
            }
          }
        }

        if (data.serverContent || data.server_content) {
          const content = data.serverContent || data.server_content
          if (content.interrupted) {
            // Student spoke over AI - stop current playback immediately and reset schedule
            for (const s of activeAudioSourcesRef.current) {
              try { s.stop() } catch {}
            }
            activeAudioSourcesRef.current = []
            if (audioContextRef.current) nextStartTime.current = audioContextRef.current.currentTime
            setAiState((s) => ({ ...s, modelState: "listening" }))
          }

          const turn = content.modelTurn || content.model_turn
          if (turn) {
            for (const part of turn.parts) {
              if (part.inlineData || part.inline_data) {
                const inline = part.inlineData || part.inline_data
                if (!audioContextRef.current) audioContextRef.current = new AudioContext({ sampleRate: 24000 })
                playAudio(inline.data, audioContextRef.current, nextStartTime, activeAudioSourcesRef, () => {
                  setAiState((s) => ({ ...s, modelState: "idle" }))
                })
                setAiState((s) => ({ ...s, modelState: "speaking" }))
              }
              const call = part.call || part.function_call || part.functionCall
              if (call) {
                const toolResponses = await executeTools(call.functionCalls || call.function_calls || [call])
                if (ws.readyState === WebSocket.OPEN) {
                  ws.send(JSON.stringify({
                    toolResponse: {
                      functionResponses: toolResponses.map((tr) => ({
                        id: tr.id,
                        response: tr.response,
                      })),
                    },
                  }))
                }
              }
            }
          }

          if (content.turnComplete || content.turn_complete) {
            if (activeAudioSourcesRef.current.length === 0) {
              setAiState((s) => ({ ...s, modelState: "idle" }))
            }
          }
        }
      }

      ws.onclose = () => disconnectLive()
      ws.onerror = () => disconnectLive()
    } catch (e) {
      console.error("Live connection failed", e)
      disconnectLive()
    }
  }

  const toggleMic = () => {
    if (aiState.isConnected) disconnectLive()
    else void connectToLiveAPI()
  }

  // Floating SmartBoard AI Chat functions
  useEffect(() => {
    if (showChat) chatEndRef.current?.scrollIntoView({ behavior: "smooth" })
  }, [chatMessages, showChat])

  const handleStartRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const recorder = new MediaRecorder(stream)
      chatMediaRecorderRef.current = recorder
      chatAudioChunksRef.current = []
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chatAudioChunksRef.current.push(event.data)
      }
      recorder.start()
      setIsRecordingChat(true)
    } catch (e) {
      console.error("Mic access denied or unavailable", e)
      setChatMessages((prev) => [
        ...prev,
        { id: Date.now().toString(), role: "model", text: "Microphone access was denied or is unavailable. Please check your browser microphone permissions." },
      ])
      setShowChat(true)
      setIsRecordingChat(false)
    }
  }

  const handleStopRecording = async () => {
    if (!chatMediaRecorderRef.current) return
    const recorder = chatMediaRecorderRef.current
    return new Promise<void>((resolve) => {
      recorder.onstop = async () => {
        setIsRecordingChat(false)
        recorder.stream.getTracks().forEach((t) => t.stop())
        chatMediaRecorderRef.current = null

        if (chatAudioChunksRef.current.length === 0) {
          resolve()
          return
        }

        const audioBlob = new Blob(chatAudioChunksRef.current, { type: "audio/wav" })
        if (audioBlob.size === 0) {
          resolve()
          return
        }

        const reader = new FileReader()
        reader.readAsDataURL(audioBlob)
        reader.onloadend = async () => {
          const resultStr = reader.result as string
          const base64Audio = resultStr ? resultStr.split(",")[1] : ""
          if (base64Audio) {
            await sendChatMessage(undefined, base64Audio)
          }
          resolve()
        }
      }
      recorder.stop()
    })
  }

  const handleMicClick = () => {
    if (isRecordingChat) void handleStopRecording()
    else void handleStartRecording()
  }

  const sendChatMessage = async (text?: string, audioBase64?: string) => {
    if (!text && !audioBase64) return
    const displayText = text || (audioBase64 ? "🎙️ Voice Note (transcribing...)" : "")
    const newMsg = {
      id: Date.now().toString(),
      role: "user" as const,
      text: displayText,
      ...(audioBase64 ? { audio: audioBase64, mimeType: "audio/wav" } : {})
    }
    setChatMessages((prev) => [...prev, newMsg])
    setChatInputText("")
    setIsChatProcessing(true)
    setShowChat(true)

    try {
      const b64Screen = await smartBoardRef.current?.getScreenCapture()
      const payloadMessages = [...chatMessages, newMsg].map((m) => ({
        role: m.role,
        text: m.text,
        ...(m.audio ? { audio: m.audio, mime_type: m.mimeType || "audio/wav" } : {})
      }))
      let systemInstruction = SMARTBOARD_SYSTEM_INSTRUCTION
      if (sel.current) {
        const selectedEl = latest.current.elements.find((e) => e.id === sel.current)
        if (selectedEl) {
          systemInstruction += `\n\n[CURRENT USER SELECTION]: The student currently has selected element id="${selectedEl.id}", kind="${selectedEl.kind}", author="${selectedEl.author}". `
          if (selectedEl.text) systemInstruction += `Text content: "${selectedEl.text}". `
          if (selectedEl.latex) systemInstruction += `LaTeX equation: "${selectedEl.latex}". `
          systemInstruction += `Bounding box: at (${selectedEl.x}, ${selectedEl.y}), width ${selectedEl.w}, height ${selectedEl.h}. If the student asks to explain, correct, or build upon this, focus directly on this selected element and place any new explanations or steps beside or below it.`
        }
      }

      const realtimeSummary = interactionTracker.current.getRealtimeSummary()
      if (realtimeSummary && realtimeSummary !== "No recent student interactions.") {
        systemInstruction += `\n\n[RECENT STUDENT BOARD INTERACTIONS]: ${realtimeSummary}`
      }
      const latestSel = interactionTracker.current.getLatestSelection()
      if (latestSel && latestSel.mcqOption) {
        systemInstruction += `\n[STUDENT FREEHAND SELECTION]: The student circled Option ${latestSel.mcqOption}${latestSel.mcqText ? ` ("${latestSel.mcqText}")` : ""}. Address their selection directly, validate or question their reasoning Socratically, and do NOT give away the final answer immediately.`
      }

      const result = await sendChatProxy(
        payloadMessages,
        b64Screen || null,
        whiteboardTools,
        systemInstruction,
        {
          assignmentId: assignmentId || undefined,
          courseId: courseId || undefined,
          board: latest.current,
          selectedId: sel.current || undefined,
        }
      )

      if (result.error) throw new Error(result.error)

      if (result.text) {
        setChatMessages((prev) => [
          ...prev,
          {
            id: Date.now().toString(),
            role: "model",
            text: result.text,
            sources: result.sources || undefined,
          },
        ])
      }

      if (result.functionCalls && result.functionCalls.length > 0) {
        const toolResponses = await executeTools(
          result.functionCalls.map((fc: any) => ({
            ...(fc.functionCall || fc),
            element_id: fc.element_id || fc.functionCall?.element_id,
          }))
        )
        // On this path the results are not sent back to the model, so a failed drawing would otherwise be
        // completely invisible. Tell the student what did not make it onto the board.
        const reasons = [
          ...new Set(
            toolResponses
              .map((r) => (r.response && typeof (r.response as any).error === "string" ? ((r.response as any).error as string) : null))
              .filter((m): m is string => !!m),
          ),
        ]
        if (reasons.length > 0) {
          const failedCount = toolResponses.filter((r) => typeof (r.response as any)?.error === "string").length
          setChatMessages((prev) => [
            ...prev,
            {
              id: `${Date.now()}-toolerr`,
              role: "model",
              text: `⚠️ ${failedCount === 1 ? "One item" : `${failedCount} items`} couldn't be added to the board: ${reasons.slice(0, 3).join(" ")}`,
            },
          ])
        }
      }
    } catch (e: any) {
      console.error("Chat Error:", e)
      const errorMsg = e?.message || "Sorry, I'm having trouble connecting right now."
      setChatMessages((prev) => [
        ...prev,
        { id: Date.now().toString(), role: "model", text: `⚠️ ${errorMsg}` },
      ])
    } finally {
      setIsChatProcessing(false)
    }
  }

  // The equation dialog opens on pointerdown; the browser's default mousedown action then moves focus
  // to <body>, defeating autoFocus. Re-focus once the pointer sequence has settled so the user (and
  // keyboard users) can type immediately.
  const eqOpen = !!eq
  const eqEditId = eq?.editId
  useEffect(() => {
    if (!eqOpen) return
    const t = window.setTimeout(() => document.getElementById("eq-input")?.focus(), 40)
    return () => window.clearTimeout(t)
  }, [eqOpen, eqEditId])

  function commitEquation() {
    if (!eq) return
    const latex = eq.value.trim()
    if (!latex || latex.length > LIMITS.latexChars || !eqOk) return
    if (eq.editId) change(updateElement(board, eq.editId, { latex }))
    else {
      const containerDims = smartBoardRef.current?.getContainerDimensions?.() || {
        width: typeof window !== "undefined" ? window.innerWidth : 1000,
        height: typeof window !== "undefined" ? window.innerHeight : 700,
      }
      const dims = estimateContentDimensions({ kind: "equation", latex })
      const pos = (eq.x !== undefined && eq.y !== undefined && (eq.x !== 0 || eq.y !== 0))
        ? { x: Math.min(eq.x, 1100), y: Math.min(eq.y, 1000) }
        : getSmartPlacement(latest.current, viewState, dims.w, dims.h, sel.current, containerDims.width, containerDims.height, getOcclusion())
      const r = addElement(board, { kind: "equation", x: pos.x, y: pos.y, w: dims.w, h: dims.h, latex })
      change(r.board)
      if (r.id) select(r.id)
    }
    setEq(null)
    handleToolChange("select")
  }

  const locked = busy || readOnly
  const selectedExists = !!selectedId && board.elements.some((e) => e.id === selectedId)

  return (
    <div
      ref={root}
      className={cn(
        "relative flex h-full min-h-0 flex-col overflow-hidden bg-[var(--color-surface-muted)]",
        isFullscreen && "fixed inset-0 z-50 w-screen h-screen h-[100dvh] min-h-[100dvh]"
      )}
    >
      {/* Top action header for SocratiQ Socratic coach interaction */}
      <div className="flex items-center justify-between border-b border-[var(--color-border)] bg-white px-2.5 sm:px-3 py-1 sm:py-1.5 z-20 shrink-0">
        <div className="flex items-center gap-1.5 sm:gap-2 min-w-0">
          <span className="text-xs font-semibold uppercase tracking-wider text-[var(--color-teal-dark)] shrink-0">SmartBoard</span>
          <span role="status" aria-live="polite" className="text-xs text-[var(--color-ink-muted)] truncate max-w-[130px] sm:max-w-none">
            {busy ? "SocratiQ is writing on the board…" : status}
          </span>
        </div>

        <div className="relative shrink-0">
          <Button
            type="button"
            size="sm"
            disabled={locked}
            aria-haspopup="menu"
            aria-expanded={askOpen}
            onClick={(e) => {
              e.stopPropagation()
              setAskOpen((v) => !v)
            }}
            className="gap-1 sm:gap-1.5 px-2.5 py-1 text-xs sm:text-sm h-8"
          >
            <Sparkles className="h-3.5 w-3.5 sm:h-4 sm:w-4" aria-hidden="true" />
            <span>Ask SocratiQ</span>
            <ChevronDown className="h-3 w-3 sm:h-3.5 sm:w-3.5" aria-hidden="true" />
          </Button>
          {askOpen && (
            <div
              role="menu"
              className="absolute right-0 z-30 mt-1 w-56 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-white p-1 shadow-lg"
              onPointerDown={(e) => e.stopPropagation()}
            >
              {ASK_ACTIONS.map((a) => (
                <button
                  key={a.intent}
                  role="menuitem"
                  type="button"
                  className="block w-full rounded-[var(--radius-sm)] px-3 py-2 text-left text-sm text-[var(--color-ink)] hover:bg-[var(--color-surface-muted)]"
                  onClick={() => {
                    setAskOpen(false)
                    onAsk(a.intent, a.message(selectedExists))
                  }}
                >
                  {a.label}
                </button>
              ))}
              <p className="px-3 pb-1.5 pt-1 text-xs text-[var(--color-ink-muted)]">
                {selectedExists ? "Acts on the selected item." : "Acts on the whole board."}
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Main Board Canvas Container with Toolbars */}
      <div ref={areaRef} className="relative flex-1 min-h-0 w-full overflow-hidden">
        {revealIds.length > 0 && (
          <div className="pointer-events-none absolute inset-x-0 top-[4.5rem] z-30 flex justify-center">
            <button
              type="button"
              onClick={handleReveal}
              aria-label="Show new content that was added outside the visible area"
              className="pointer-events-auto rounded-full border border-[var(--color-border)] bg-white px-4 py-2 text-sm font-medium shadow-lg focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
            >
              Show new content
            </button>
          </div>
        )}
        {!readOnly && (
          <SmartBoardToolbar
            currentTool={tool}
            setTool={handleToolChange}
            currentColor={currentColor}
            setColor={handleColorChange}
            strokeWidth={strokeWidth}
            setStrokeWidth={handleStrokeWidthChange}
            filled={filled}
            setFilled={setFilled}
            fontSize={fontSize}
            setFontSize={setFontSize}
            theme={theme}
            setTheme={setTheme}
            aiState={aiState}
            isAIProcessing={isAIProcessing}
            onToggleMic={toggleMic}
            onUndo={doUndo}
            onRedo={doRedo}
            confirmClear={confirmClear}
            onClearClick={() => setConfirmClear(true)}
            onClearConfirm={() => {
              change({ ...board, strokes: [], elements: [], steps: [] })
              select(null)
              setConfirmClear(false)
            }}
            onClearCancel={() => setConfirmClear(false)}
            canClear={board.elements.length > 0 || board.strokes.length > 0}
            locked={locked}
            onZoomIn={() => zoomAroundCentre(1.2)}
            onZoomOut={() => zoomAroundCentre(1 / 1.2)}
            onFitView={() => { handleFitView() }}
            zoomScale={viewState.scale}
            onScaleSelected={handleScaleSelected}
            onSetSizePreset={handleSetSizePreset}
            onImageUpload={handleImageUploadClick}
            onEquationClick={() => handleToolChange("equation")}
            onDelete={() => {
              if (selectedIds.length > 0) {
                change(removeElements(board, selectedIds))
                select(null)
              } else if (selectedId) {
                change(removeElement(board, selectedId))
                select(null)
              }
            }}
            onDuplicate={handleDuplicate}
            onReorder={handleReorder}
            hasSelection={selectedIds.length > 0 || !!selectedId}
            canUndo={hist.past.length > 0}
            canRedo={hist.future.length > 0}
            isFullscreen={isFullscreen}
            onToggleFullscreen={toggleFullscreen}
          />
        )}

        <input type="file" ref={fileInputRef} className="hidden" accept="image/*" onChange={handleFileChange} />

        <SmartBoard
          ref={smartBoardRef}
          board={board}
          onChange={change}
          readOnly={readOnly}
          busy={busy}
          tool={tool}
          grid={grid}
          theme={theme}
          currentColor={currentColor}
          strokeWidth={strokeWidth}
          filled={filled}
          fontSize={fontSize}
          selectedId={selectedId}
          selectedIds={selectedIds}
          onSelect={select}
          onSelectionChange={selectMultiple}
          fresh={fresh}
          viewState={viewState}
          onViewChange={setViewByUser}
          onToolChange={handleToolChange}
          onStrokeCompleted={handleStrokeCompleted}
          onElementMoved={handleElementMoved}
          onEquationRequest={(at, editId) => {
            const el = editId ? board.elements.find((e) => e.id === editId) : undefined
            setEq({ ...at, editId, value: el?.latex ?? "" })
          }}
        />

        {/* Equation Editing Dialog */}
        {eq && (
          <div
            role="dialog"
            aria-label="Add an equation"
            className="absolute inset-x-2 sm:inset-x-3 top-2 sm:top-6 z-40 mx-auto max-w-[calc(100vw-1rem)] sm:max-w-lg max-h-[85dvh] overflow-y-auto rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-white p-3 sm:p-4 shadow-xl select-none"
            style={{ touchAction: "auto" }}
          >
            <label htmlFor="eq-input" className="text-sm font-semibold text-[var(--color-ink)]">
              {eq.editId ? "Edit equation" : "Add an equation"}
            </label>
            <input
              id="eq-input"
              autoFocus
              value={eq.value}
              maxLength={LIMITS.latexChars}
              placeholder="2x + 4 = 10"
              onChange={(e) => setEq({ ...eq, value: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault()
                  commitEquation()
                }
                if (e.key === "Escape") setEq(null)
              }}
              className="mt-2 h-10 w-full rounded-[var(--radius-sm)] border border-[var(--color-border-strong)] px-3 font-mono text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-teal-dark)]"
            />
            <p className="mt-1 text-xs text-[var(--color-ink-muted)]">LaTeX works: x^2, \frac{"{a}{b}"}, \sqrt{"{x}"}</p>
            <div className="mt-3 flex min-h-[64px] items-center justify-center overflow-x-auto rounded-[var(--radius-sm)] bg-[var(--color-surface-muted)] px-3 py-2" aria-label="Preview">
              {eq.value.trim() ? <MathView latex={eq.value} onStatus={setEqOk} /> : <span className="text-sm text-[var(--color-ink-muted)]">Preview</span>}
            </div>
            {eq.value.trim() && !eqOk && <p role="alert" className="mt-2 text-xs text-[var(--color-danger-ink)]">This can't be displayed as an equation yet. Check the brackets and commands.</p>}
            <div className="mt-3 flex justify-end gap-2">
              <Button type="button" size="sm" variant="secondary" onClick={() => setEq(null)}>
                Cancel
              </Button>
              <Button type="button" size="sm" disabled={!eq.value.trim() || !eqOk} onClick={commitEquation}>
                {eq.editId ? "Update" : "Add to board"}
              </Button>
            </div>
          </div>
        )}

        {/* Floating SmartBoard AI Chat Bar (Bottom Center) */}
        {!readOnly && (
          <div
            data-board-occluder="chat"
            className="absolute bottom-2 sm:bottom-4 left-1/2 -translate-x-1/2 w-full max-w-xl px-2 sm:px-4 z-40 pointer-events-none flex flex-col gap-2 pb-[env(safe-area-inset-bottom,0px)]"
            style={{ touchAction: "auto" }}
          >
            {chatMessages.length > 0 && showChat && (
              <div
                className={cn(
                  "backdrop-blur-md rounded-2xl shadow-2xl border p-3 sm:p-4 max-h-[50dvh] sm:max-h-[360px] overflow-y-auto pointer-events-auto flex flex-col gap-2.5 mb-1 transition-colors",
                  theme === "dark" ? "bg-zinc-950/90 border-zinc-800 text-white" : "bg-white/95 border-gray-200 text-gray-900"
                )}
                style={{ touchAction: "auto" }}
              >
                <div className="flex justify-between items-center border-b pb-1.5 border-[var(--color-border)]">
                  <span className="text-xs font-bold uppercase tracking-wider text-gray-400">SmartBoard AI Assistant</span>
                  <button
                    type="button"
                    onClick={() => setShowChat(false)}
                    className="text-gray-400 hover:text-gray-600 rounded p-0.5"
                    aria-label="Close Chat"
                  >
                    <X size={14} />
                  </button>
                </div>
                {chatMessages.map((msg) => (
                  <div key={msg.id} className={cn("flex flex-col", msg.role === "user" ? "items-end" : "items-start")}>
                    <div className={cn(
                      "max-w-[85%] p-2.5 rounded-2xl text-xs sm:text-sm leading-relaxed shadow-sm",
                      msg.role === "user"
                        ? "bg-blue-600 text-white rounded-tr-sm"
                        : (theme === "dark" ? "bg-zinc-800 text-zinc-100 border border-zinc-700 rounded-tl-sm" : "bg-gray-100 text-gray-800 border border-gray-200 rounded-tl-sm")
                    )}>
                      {msg.role === "model" ? <ReactMarkdown>{msg.text}</ReactMarkdown> : msg.text}
                      {msg.sources && msg.sources.length > 0 && (
                        <div className="mt-2 pt-1.5 border-t border-gray-300 dark:border-zinc-700 flex flex-wrap gap-1 text-[10px]">
                          <span className="font-semibold text-gray-500 dark:text-zinc-400">Sources:</span>
                          {msg.sources.map((s, idx) => (
                            <span key={idx} className="bg-blue-50 dark:bg-zinc-700/60 text-blue-700 dark:text-blue-300 px-1.5 py-0.5 rounded border border-blue-200 dark:border-zinc-600">
                              {s.title || s.source}{s.page ? ` (p. ${s.page})` : ""}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
                <div ref={chatEndRef} />
              </div>
            )}

            <form
              onSubmit={(e) => {
                e.preventDefault()
                if (chatInputText.trim() && !isChatProcessing && !isRecordingChat) {
                  void sendChatMessage(chatInputText)
                }
              }}
              className={cn(
                "pointer-events-auto flex items-center gap-1.5 sm:gap-2 backdrop-blur-md p-1 sm:p-1.5 px-2.5 sm:px-3 rounded-full shadow-2xl border transition-all",
                theme === "dark" ? "bg-zinc-900/90 border-zinc-700 shadow-black/40" : "bg-white/95 border-gray-200 shadow-xl"
              )}
              style={{ touchAction: "auto" }}
            >
              <button
                type="button"
                onClick={() => setShowChat(!showChat)}
                className="text-gray-400 hover:text-blue-500 transition-colors p-1 pointer-coarse:p-2.5"
                title="Toggle AI Chat History"
                aria-label="Toggle AI Chat History"
              >
                <MessageSquare size={18} />
              </button>

              <input
                type="text"
                aria-label="Ask SocratiQ on the board"
                value={chatInputText}
                onChange={(e) => setChatInputText(e.target.value)}
                placeholder={isRecordingChat ? "Recording voice note..." : "Ask Gemini to draw, simulate, or explain…"}
                disabled={isChatProcessing || isRecordingChat}
                className={cn(
                  "flex-1 bg-transparent border-none outline-none text-xs sm:text-sm py-1.5 px-1 placeholder-gray-500",
                  theme === "dark" ? "text-white" : "text-gray-900"
                )}
              />

              <button
                type="button"
                onClick={handleMicClick}
                disabled={isChatProcessing}
                className={cn(
                  "p-1.5 pointer-coarse:p-2.5 rounded-full transition-all",
                  isRecordingChat ? "bg-red-500 text-white animate-pulse" : "text-gray-400 hover:bg-gray-100 dark:hover:bg-zinc-800"
                )}
                title={isRecordingChat ? "Stop Recording" : "Voice Message"}
                aria-label={isRecordingChat ? "Stop Recording" : "Voice Message"}
              >
                {isRecordingChat ? <Square size={16} fill="currentColor" /> : <Mic size={16} />}
              </button>

              <button
                type="submit"
                disabled={!chatInputText.trim() || isChatProcessing || isRecordingChat}
                className={cn(
                  "p-1.5 pointer-coarse:p-2.5 rounded-full transition-all flex items-center justify-center",
                  !chatInputText.trim() || isChatProcessing
                    ? "bg-gray-200 dark:bg-zinc-800 text-gray-400 cursor-not-allowed"
                    : "bg-blue-600 text-white hover:bg-blue-700 shadow-sm"
                )}
                title="Send to SmartBoard"
                aria-label="Send to SmartBoard"
              >
                {isChatProcessing ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
              </button>
            </form>
          </div>
        )}
      </div>
    </div>
  )
})
