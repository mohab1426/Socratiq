# CHANGELOG — SmartBoard viewport fit and tool fixes

## v5 - drawing pipeline audit
- Pinch drift, history coalescing, latest-board + rotation-aware resize/rotate, eraser for every element kind, preview==commit shapes, rigid group/connector clamping, multi-select/multi-delete fixes, centre-anchored zoom buttons, coalesced pen samples, honest AI error reporting, all reflow sites scoped (completes v4).
- 102 new vitest tests (463 total). Browser harness and Live Voice smoke test not run. See `docs/SMARTBOARD_CANVAS_NOTES.md`.


## v4 - audit and critical fixes
- AI `draw_line` / `draw_path` / `draw_arrow` now follow the planned layout; plan items are paired by `sourceIndex`; diagrams move rigidly; arrows keep direction (signed w/h); duplicate `element_id` calls are ignored; invalid coordinates are handled.
- `computeUnobstructedVisibleViewport` rewritten (screen -> board before clipping; occlusion in screen space; empty rects allowed).
- Rendered-bounds helpers use the controlled view's scale; post-batch reflow only touches that batch's elements.
- Fixed `tsc -b` failure (null occlusion) so `npm run build` succeeds again.
- 73 new vitest tests (361 total). Browser harness not run in v4. Details: `docs/SMARTBOARD_CANVAS_NOTES.md`.


Base: git `40a9a28` ("implement intelligent adaptive layout engine…"). All changes are confined to
`frontend/src/components/socratiq/` and `frontend/src/lib/`. No backend, database, migration,
auth, Supabase, API-client, env-var or deployment file was touched.

> **Status: applied, but NOT executed.** The frontend test suite, project type-check and production
> build could not be run in the delivery environment (no npm registry access). See
> `VERIFICATION-REPORT.md` before relying on this change.

## Files

| File | Change |
|---|---|
| `frontend/src/lib/boardViewport.ts` | **New.** Pure viewport helpers (see "How fitting works"). |
| `frontend/src/lib/boardViewport.test.ts` | **New.** Unit tests for the helpers. |
| `frontend/src/components/socratiq/BoardViewportFit.test.tsx` | **New.** Component tests: fit on open, resize, manual-view preservation, fullscreen, regressions. |
| `frontend/src/components/socratiq/BoardToolFixes.test.tsx` | **New.** Tests for keyboard shortcuts and AI-failure reporting. |
| `frontend/src/components/socratiq/BoardWorkspace.tsx` | Modified (+153 / −97 vs. base). Fit/resize logic, shortcuts, AI failure reporting, equation-dialog focus. |
| `frontend/src/components/socratiq/SmartBoard.tsx` | Modified (+90 / −14). Full-bleed "workspace" surface, native wheel handling, off-board pan. |
| `frontend/src/components/socratiq/SmartBoardToolbar.tsx` | Modified (+19 / −9). Occluder markers, touch-sized controls, aria-labels. |

## How viewport fitting works

- The logical board stays **2000 × 1200** (`BOARD_W` / `BOARD_H` in `lib/whiteboard.ts`, unchanged).
- `view = { x, y, scale }`: `view.x/y` is the board coordinate at the drawing surface's top-left;
  `scale` is screen px per board unit.
- `computeFitView(container, box, occlusion)` picks the largest scale (capped at 1.0 for an empty
  board, 1.2 for content, floored at 0.1) that fits `box` inside the container minus a 12 px margin
  and minus floating UI, then centres the box in the *unobstructed* region. It returns `null` for a
  zero/tiny container, so nothing is ever fitted against a hidden or not-yet-laid-out element.
- `measureOcclusion` reads real `getBoundingClientRect()` values of elements marked
  `data-board-occluder` (toolbar, contextual bar, zoom control, utility dock) instead of guessed
  constants. Occlusion is clamped (≤40 % vertically, ≤30 % horizontally) so overlays cannot eat the
  whole container. If nothing is measurable it falls back to conservative defaults.
- Auto-fit runs in a layout effect (first paint is already fitted), re-fits on container resize
  **only while the user has not panned/zoomed**, and a manual view survives later resizes and
  fullscreen toggles. "Fit to View" resets the manual view and re-arms auto-fit. When content exists,
  the fit frames its padded bounding box rather than the empty board.
- In "workspace" mode (parent-controlled view) the drawing surface fills the parent container and the
  board is a movable page inside it; the empty area around the board still accepts pan/pinch/deselect.
  The uncontrolled modes (e.g. read-only teacher review) keep their original contained layout.

## What was fixed

- **Viewport:** replaced the one-time initial fit with the continuous, occlusion-aware fit above;
  fullscreen no longer discards a chosen pan/zoom; the `ResizeObserver` is cleaned up.
- **Zoom/pan input:** wheel is handled by a native non-passive listener so trackpad pinch
  (Ctrl+wheel) zooms the board instead of the page, and zoom keeps the point under the cursor fixed.
- **Keyboard shortcuts:** single-letter tool keys now match the toolbar tooltips
  (V select, H pan, P pen, T text, E eraser, **R rect, O ellipse, L line, A arrow**). Keys with
  Ctrl/Cmd/Alt no longer switch tools (Ctrl+P / Ctrl+T / Ctrl+E etc.). Ctrl+Y now performs redo.
- **Text/equation tool:** the equation dialog's input is re-focused after the pointer sequence
  settles, so the user can type immediately.
- **AI generation failures:** a failed chat/image generation is reported in the chat instead of being
  swallowed; the placeholder batch removal retries once if the failure arrives before the batch is
  committed.
- **Responsive/touch UI:** coarse-pointer devices get larger colour/size/scale buttons
  (`pointer-coarse:` classes), aria-labels on size and scale buttons and the zoom control, and the
  toolbar no longer animates every property (`transition-all` → `transition-colors`).

## Intentionally NOT changed

- **Live Voice.** The original patch also changed `ws.onerror` in the Live Voice handler to show a
  "Live Voice couldn't connect" message. Because the requirement was not to modify Live Voice, that
  one hunk was **reverted**; `ws.onerror = () => disconnectLive()` is identical to the base commit.
  No other changed line touches the Live Voice path.
- Layout engine / placement (`boardLayoutEngine.ts`, `smartPlacement.ts`), AI Coach, authorship
  protection, auth, Supabase, backend — not modified.
- **Highlighter colour:** the patch contains **no** change to highlighter colour logic (the existing
  default `#facc15` / current-colour behaviour in `SmartBoard.tsx` is untouched). No highlighter fix
  is claimed here.

## Known limitations / unverified

- Nothing in this change was executed under the project's own test runner, type-checker, bundler or a
  browser — see `VERIFICATION-REPORT.md`.
- On a very short landscape phone (≈700×320) with the toolbar and chat open, the fit hits the 0.1
  minimum scale and the board becomes very small (~200×120 px). Occlusion clamping prevents an
  invalid view, but the result is hard to use; consider hiding the chat dock in that case.
- AI-generated element placement and the Text Tool's placement behaviour were not changed by this
  patch and were not re-verified.
- Revised patch for review: `smartboard-fit-and-tools.revised.patch` (original patch minus the Live
  Voice hunk).
