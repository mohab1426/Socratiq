# SocratiQ x SmartBoard: board-aware tutor audit, plan and first increment

SocratiQ is the product. SmartBoard (github.com/mohamed-717-os/smart-board) is a technical reference only. No avatar. No schema change. No data touched.

## 1. Key finding: SocratiQ was further along than the brief assumed

The audit found a working board-AI stack already in SocratiQ: `ai/whiteboard/` (pydantic-validated `BoardAction`s, a layout engine that places by meaning so the
model never emits coordinates, authorship `student|coach`, destructive actions only on explicit student intent, `render_board_for_llm`), the Coach graph reading the
board, `PUT/GET` board persistence with revisions, a structured frontend model (`lib/whiteboard.ts`: ids, kinds, author, seq, undo/redo, one AI turn = one undo
step), board-button intents, and a Web Speech voice hook. The Coach only ever acts on a student turn, so the AI -> board -> AI loop cannot form structurally.

## 2. SmartBoard vs SocratiQ (REUSE / ADAPT / KEEP SOCRATIQ / REJECT)

| Mechanism | SmartBoard | Decision |
|---|---|---|
| Board model | free canvas nodes, no semantics | KEEP SOCRATIQ (ids, kinds, author, seq, equations) |
| AI sees the board | screenshot of the canvas | KEEP SOCRATIQ (structured listing is cheaper, exact and verifiable); screenshots stay a later option |
| Tool surface | 13 tools: draw_line/circle/rectangle/triangle/path, write_text, move/delete *by coordinates*, clear_board, vector drawing, images | ADAPT: the shape tools (line, arrow, shapes, freehand) are the gap. Address by element **id**, not coordinates |
| Tool calling | Gemini function calling, executed in the browser | KEEP SOCRATIQ (provider-independent structured output, server validation, then client applies). Gemini stays optional |
| Live voice | Gemini Live API over an Express + WebSocket proxy | ADAPT later, as an optional provider behind an abstraction. Not default: ties voice to one vendor and key |
| `generate_simulation` | AI-written HTML in an iframe (`allow-scripts` + `allow-same-origin`) | **REJECT**: arbitrary code execution; the brief forbids it |
| `generate_image` | static images | REJECT: the brief prefers editable objects |
| Undo/redo | present in the client | KEEP SOCRATIQ (already AI-turn-granular) |

## 3. Gaps found (current limitation -> status)

1. Student edits reached the Coach only as a full board re-read; no "X changed from A to B". **FIXED in this increment** (section 4).
2. Voice transcripts were plain messages; "explain this" did not behave like the Explain board button. **FIXED**.
3. Voice "needs an internet connection" error was a guess, not a diagnosis. **FIXED (diagnosis); fallback STT NOT built** (section 4).
4. Missing AI tools: `draw_line/arrow/shape/freehand`, `move/resize/group`, `compare_board_states`, `undo_ai_action`, graphs/axes/vectors/diagrams. **NOT DONE.**
5. Undo history is client-session only. A reload loses it, and an explicit-intent erase is recoverable only in-session. **NOT DONE** (needs a server-side revision restore).
6. Evidence: per-turn counts only; no per-event board evidence rows. Partly improved (section 4).

## 4. What changed in this increment

**Voice root cause.** The Web Speech API does not recognise speech on the device. Chrome and Edge stream audio to their vendor's cloud service, so `network` means
that service was unreachable (offline, VPN/firewall, blocked). Brave ships the API without a speech service, so it always ends in `network`. The error is no longer
generic: `describeVoiceError` names Brave, offline, insecure (non-https) page or blocked microphone, and keeps the raw code visible.
No server-side STT fallback was built: it needs a provider decision, a key and an upload endpoint, none of which I can verify here. Typing remains the fallback.

**Voice -> board-aware Coach.** `lib/voiceCommands.ts` maps short spoken commands (English, Arabic/Egyptian) to the board intents. It applies only in Whiteboard mode.
Clear/erase/organize are deliberately never shortcut by voice.

**Whiteboard -> AI deltas.** `ai/whiteboard/delta.py`: a compact snapshot is stored in the existing `AI_INTERACTION` event payload (jsonb) *after* the Coach's own
actions. Next turn the diff against the live board (added, removed, edited from A to B, highlighted, moved, strokes) is put at the top of the board listing as DATA.
The snapshot excludes the Coach's own writing, so it is never reported back as a student change. Counts go into the payload as `board_student_changes`.

Files changed: `ai/whiteboard/delta.py` (new), `ai/whiteboard/digest.py`, `ai/whiteboard/__init__.py`, `ai/prompts/coach/response_prompt.py`,
`backend/app/routers/ai.py`, `frontend/src/lib/voice.ts`, `frontend/src/lib/voiceCommands.ts` (new), `frontend/src/pages/student/AiCoach.tsx`.
Tests added: `ai/tests/test_whiteboard_delta.py`, `frontend/src/lib/voiceCommands.test.ts`, one end-to-end case in `backend/tests/test_smart_board.py`.
Database: no change. Older events without a snapshot simply produce no delta.

## 5. Verification status

| Item | Status |
|---|---|
| Delta logic (11 tests, real module, real test file) | AUTOMATED TESTED, passing |
| Voice command matcher + error diagnosis (42 cases, Node 22 type stripping + a minimal vitest shim; negative control confirmed the harness can fail) | AUTOMATED TESTED, passing |
| All edited Python files | `py_compile` passes |
| Backend end-to-end test (delta through the real Coach graph and Postgres) | WRITTEN, **NOT RUN**: needs Postgres + dependencies |
| Existing pytest / vitest suites, `tsc`, `npm run build` | **NOT RUN**: sandbox has no dependencies and no network |
| `digest.py` change and the `AiCoach.tsx` wiring | NOT TESTED (reviewed against types and signatures only) |
| Real browser, microphone, Arabic/English recognition, Brave/Chrome behaviour | **NOT TESTED** |
| External model calls | NOT TESTED |

Run before merging: `pytest`, `cd frontend && npm run build && npx vitest run`, then a real Chrome session (voice in both languages) and a Brave session (confirm the Brave message).

## 6. Known limitations

- Voice recognition still depends on the browser's cloud service; Brave cannot use it at all.
- The delta baseline is per Coach turn. Edits made while a turn is in flight are not reported (the UI locks the board while the Coach is thinking, which makes this rare).
- Snapshot payload is bounded by content clipping (80 chars/element) but grows with board size.
- `moved` is reported for text and equations only; arrows and shapes are not diffed.

## 7. Recommended next steps (in value order)

1. Add shape tools (`draw_arrow`, `draw_line`, `draw_shape`) by element id, and `move/resize`, with the existing schema validation. Then force-diagram and flowchart presets built from editable elements.
2. Server-side restore: keep the pre-turn board as a revision per AI turn and expose `undo_ai_action`, so an erase is recoverable after reload.
3. Per-event board evidence (first attempt, error corrected, hint requested) mapped onto the existing evidence types.
4. Optional STT provider behind an interface (MediaRecorder -> backend), for Brave and offline-restricted networks.
5. Optional screenshot perception for freehand drawings only, when the delta says strokes changed.
