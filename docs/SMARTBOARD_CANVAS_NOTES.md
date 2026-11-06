# SmartBoard canvas, tools and placement: audit notes

## v5 (drawing-pipeline audit) - newest

Checks run with the real toolchain: vitest 463/463, `tsc -b`, oxlint (0 errors, 44 warnings = baseline), `npm run build`.
**Not run:** the Playwright browser harness and any real-browser test (no Chromium; download blocked), Live Voice smoke test
(needs microphone/websocket/API key). The new tests are jsdom component tests with stubbed layout, not end-to-end tests.

**Correction to v4:** v4 documented that post-batch reflow only touches the batch's elements, but it patched only the first of
four `verifyAndReflowLayout` call sites; the main post-batch path still reflowed the whole board. v5 scopes all four.

| Defect (verified; new tests fail on v4 unless noted) | Fix |
|---|---|
| Pinch zoom re-read the live stage rect every move but divided by the START scale, so the anchor drifted (`handleTouchGestureMove`). | Anchor derived from a snapshot taken at pinch start via `zoomAtPoint`. |
| History: one resize/rotate gesture pushed one entry per pointer-move (cap 60), so undo moved 1px and long drags evicted history. | `commit(h, b, coalesceKey)`; `onChange(b, {coalesce})`; one key per gesture. |
| Resize/rotate built every step on the board captured at pointer-down (lost concurrent changes, e.g. an AI batch); rotated elements resized along screen axes and moved their anchor corner. | Gestures use the latest board (`emit`/`boardRef`), project the delta onto the element's axes and keep the top-left corner fixed; `pointercancel` removes listeners. |
| Eraser used `hitElement` (text/equation only): shapes, lines, arrows, paths, images could not be erased. | `hitAnyElement` (segment distance for connectors, rotation-aware boxes); drag from an element sweeps as one undo step; drag from empty space still erases ink. |
| Circle preview (ellipse in drag box) != committed circle (diagonal diameter); ellipse tool previewed a rectangle; shapes needed w>30 AND h>30 so thin bars vanished silently. | `lib/shapeDrag.ts` shared by preview and commit (circle inscribed in the drag box); thin bars allowed. |
| Multi-drag clamped each element separately (group squashed at edges); lines/arrows pointing left/up were clamped as if they extended right/down. | `clampGroupDelta`, `moveElements`, bbox-aware `clampElementPosition`. |
| Shift-click / marquee multi-select cleared itself in the workspace: `setSelection` called `onSelect(null)` after `onSelectionChange`, and `select(null)` resets the selection. | `onSelect` only for 0/1 selected. |
| Multi-delete (Delete key, toolbar) left arrows attached to deleted elements as invisible orphans. | `removeElements` cascades like `removeElement`. |
| Zoom In/Out buttons changed only the scale (zoom about board top-left). | `zoomAroundCentre`: pivot at the centre of the unobstructed workspace. |
| Fast pen strokes lost intermediate samples. | Coalesced pointer events are consumed (points stay integers: backend schema is `tuple[int,int]`). |
| AI: an unknown tool name returned `{result:"ok"}`; thrown errors were reported as non-errors; on the chat-proxy path tool results were discarded, so failures were invisible. | Errors reported as errors; failures are shown to the student in the chat. |
| Shortcuts fired while a `<select>` had focus. | `SELECT` guarded. |

Verified OK without change: keyboard shortcuts are already ignored in `INPUT`/`TEXTAREA`/contenteditable (test added);
Space-drag and middle-mouse pan, Ctrl+wheel zoom-to-pointer and scale limits; text create/edit/commit (zoom/pan, multiline);
save -> reload round trip of every element kind and strokes through the real `camelize`/`fromServer`.

**v5 limitations:** stroke points are integer board units (API contract), so very high zoom shows polygonal strokes; the
eraser is whole-element (no partial erasing); sweep-erase from an element is a deliberate design choice (documented above);
no real-browser verification of touch/pen hardware; rotated multi-element groups are clamped by unrotated extents.

---

## v4 (code audit, critical bug fixes) - read this first

Unlike v3, v4 was built with the project's **real toolchain**: `npm ci` (lockfile, 305 packages), vitest 5, `tsc -b`,
oxlint and `vite build` all ran. Exact commands/results are in the delivery report. Browser checks could **not** run
(no Chromium; the download is blocked), so everything below marked "browser" is unverified.

### Baseline found in v4 (before any edit)
- vitest: 21 files / 288 tests passed. They did **not** catch either critical bug.
- `tsc -b` **failed** (`BoardWorkspace.tsx(717,102)`: `Occlusion | null` passed as `UiOcclusion | undefined`), so
  `npm run build` failed. The v3 `SMARTBOARD_TEST_REPORT.md` statement "Zero TypeScript errors / build success" was
  not true for that tree. (v3 `CHANGELOG-SmartBoard.md` itself says the build could not be run.)

### Verified defects and fixes
| # | Defect (reproduced in code and by a failing test on the original) | Fix |
|---|---|---|
| 1a | `draw_line` / `draw_path` in `executeTools` never read the planned layout: raw `args` (with `?? 100` / `|| 0` fallbacks, NaN passed through) were used. | Lines/paths take planned geometry. Invalid input gets a safe default or an error result. |
| 1b | Plan items were paired with calls **by array index**, but `planBatchLayout` returns content, then connectors. An arrow listed first received a text item's geometry (NaN endpoints). | Items carry `sourceIndex`; the caller pairs by it. The planner's element id is now the id the executor uses. |
| 1c | Multi-element batches with explicit coordinates were relocated one element at a time, breaking relationships; free lines/arrows/paths never moved with their group. | Content + anchored lines/arrows/paths form one **rigid body**, translated by a single (dx, dy). See policy below. |
| 1d | `draw_arrow` stored `x=min, w=abs`; the renderer draws `(x,y)->(x+w,y+h)`, so every arrow pointing left/up was drawn reversed or flipped. `verifyAndReflowLayout` did the same on reconnect. | Arrows store start + **signed** w/h (what student-drawn arrows already did, and `toWire` already allows). `getElementBoundingBox` reads arrows the way they are drawn. |
| 1e | Repeated calls with the same `element_id` created duplicates. | Skipped with "already exists". |
| 1f | `verifyAndReflowLayout` ran over the whole board after each batch (could shift/resize older coach content) and rewrote unrelated connectors once anything moved. | `onlyIds` option; `BoardWorkspace` passes the ids of that batch. Only touched connectors are rewritten. |
| 2 | `computeUnobstructedVisibleViewport` clamped the pan to the board **before** adding the window extent, then applied occlusion to the clamped rect and inflated results to 100/60 minimums. `view.x=-100, zoom 1, 500px` returned 0..500 (true: 0..400). | Screen intervals are converted to board units first and clipped after; occlusion is applied in screen space (capped like `computeFitView`, shared `capOcclusion`); rects may be empty; the unobstructed rect rounds inward. |
| 2b | The reveal-cleanup effect passed a possibly-`null` occlusion and used different container/occlusion sources than placement. | One `getOcclusion()` / `getContainerDims()` used by placement, reveal and cleanup. Visibility tests use `getElementBoundingBox` (arrows/lines/rotation). |
| 3 | `SmartBoard.getAllRenderedBounds` / `getElementRenderedBounds` divided DOM pixels by `internalScale`, which is never updated in controlled mode (always 0.4 in `BoardWorkspace`). Reflow then wrote wrong w/h. | They use the effective (controlled) scale. |

One existing test was changed: `computeUnobstructedVisibleViewport ... mobile (375x667)` expected `h = 880`, which
subtracted the bottom dock from a height already clipped at the board edge (the dock is over empty space below the
board, so the correct value is 1000). The comment in the test explains this.

### Placement policy for AI geometry (deterministic)
- *Anchored*: content with explicit x/y; a line/arrow with four finite endpoints whose box is inside the board and not
  parked near the origin; a path whose drawn region (local bounds + x/y) is inside the board and not at the origin.
- If all content is anchored, content + anchored geometry move as one body. It stays put when that spot is free and
  visible, otherwise the whole body shifts by one delta, so relative positions, line direction/length and path shape
  are preserved. A body of only lines/arrows (annotations) is never relocated to avoid existing content.
- Unanchored content is stacked in reading order; unanchored paths/lines are placed in free space keeping their own
  vector/shape; a line with unusable coordinates becomes a 140-unit horizontal segment; coordinate-less connectors join
  the last two content items; connectors with from/to ids attach to the final boxes.
- `pathData` is element-local (rendered as `translate(x, y)`); the planner re-bases it to start at (0,0) and uses the
  real drawn extents as w/h. Moving a path changes x/y only.

### Verified by genuine vitest (jsdom, mocked network, stubbed layout)
Full suite: 23 files / 361 tests pass (73 new). 35 of the new tests fail on the original source (checked by running them
against a pristine extraction). New files: `lib/aiGeometry.ts` (+ test), `components/socratiq/SmartBoardAiPipeline.test.tsx`,
and new blocks in `lib/boardLayoutEngine.test.ts`. The workspace tests mount the real `BoardWorkspace`, feed AI function
calls through the mocked chat proxy and read the board as persisted. They are component tests, **not** end-to-end browser tests.

### v4 limitations / not verified
- Browser harness (52 checks) and any real-browser run: **not executed in v4**. The v3 results below are carried forward unverified.
- Path bounds use endpoints and control points (conservative); arcs use endpoints only. Compact arc-flag syntax
  (`a1 1 0 01.5.5`) is treated as unparseable: such a path is kept verbatim and sized from `width`/`height`.
- "Meaningful geometry" treats a box with x<32 and y<32 as the model's "unknown" origin; a deliberate drawing there is relocated.
- A line longer than the board is not scaled; an out-of-board anchored line/arrow is not clamped by the planner
  (serialization still clamps x/y to the board).
- When the whole board is full, content is still placed overlapping at the fallback position (unchanged).
- The "Show new content" lifecycle is tested with a zoomed, panned jsdom workspace and an independently computed visible
  region; real pixel layout of the button/toolbars is not verified.
- Navigation/drawing items (pen, highlighter, per-tool settings, wheel/pinch, Space/middle pan, fit, text, shapes,
  eraser, undo/redo, save/load) were covered only by the **existing** passing vitest tests; they were not re-audited
  line by line in v4 and no defect was confirmed, so none was changed. Live Voice was not touched.

---

## What changed (and why)

| Area | Files | Change |
|---|---|---|
| Tool settings | `lib/toolSettings.ts`, `BoardWorkspace.tsx` | Pen, highlighter and eraser keep independent colour/width; line/arrow/shapes/text share one set. An explicit colour pick in select/pan mode still sets the default pen colour (existing behaviour, pinned by `BoardWorkspace.test.tsx`); selecting an element only changes what the toolbar shows. Highlighter now defaults to yellow instead of inheriting the pen's black. |
| Highlighter | `SmartBoard.tsx` | Live preview paints the whole stroke as one path over a snapshot of the committed ink taken at pointer-down. The snapshot is rebuilt if the board changes mid-stroke and released on pointer-up / cancel. Before: per-segment alpha stacked round caps (preview alpha 209 vs 89 saved) and the preview didn't match the saved stroke. |
| Pan | `SmartBoard.tsx` | Space+drag and middle-mouse drag pan with any tool, in the capture phase (no tool/element handler starts). Space is ignored while typing and when a toolbar button/link has focus. |
| Zoom | `lib/boardViewport.ts`, `SmartBoard.tsx` | Wheel/pinch zoom is proportional to delta (was a fixed 5% per event: 20 tiny events = x2.65), about the pointer, clamped 0.1x-5x. |
| Pan limits | `lib/boardViewport.ts`, `SmartBoard.tsx` | `clampViewToBoard` keeps >=120 px of the board on screen in workspace mode (before: wheel-pan reached x=100000). |
| Fit | `BoardWorkspace.tsx` | Fit-to-content frames elements (rotation/line aware) **and** freehand ink. |
| Occupancy | `lib/boardLayoutEngine.ts`, `lib/smartPlacement.ts` | Ink counts as occupied space via small, gap-free boxes (<=80 px, walked along the path). A 3-point 900 px swipe reserved ~636,000 px2 before the fix, ~32,000-49,000 now. |
| Placement | `lib/smartPlacement.ts`, `BoardWorkspace.tsx` | `getSmartPlacement` uses the engine's real bounds, measured UI occlusion and ink; the "next to selection" spot is used only if free **and** visible. Elements queued earlier in the same AI tool call count as occupied. |
| Off-screen content | `lib/boardViewport.ts` (`computeRevealView`), `BoardWorkspace.tsx` | If new content can't be placed fully in view, a **Show new content** button appears on the board (and a chat note). It pans to the content, never zooms in past the current scale, zooms out only if needed, and disappears when the content is visible or deleted. The view is never moved automatically. |
| Reflow | `lib/boardLayoutEngine.ts` | `verifyAndReflowLayout` no longer copies a rotated element's axis-aligned DOM box into w/h (it grew each reflow) and never pushes content past the board bottom. Student elements are still never moved; their rendered size is still used to keep clear of them. |
| Dev tool | `tools/smartboard-browser-harness/` | Optional esbuild + Playwright harness (see its README). Not part of the app build, lint or tests. |

## v3 verification claims (carried forward; NOT re-run in v4)

### Executed, in a real browser (Chromium via Playwright): 52 checks, 52 passed
Run against the **unmodified `SmartBoard.tsx` and `src/lib`**, with only `MathView`, `TextNode`, `SimulationNode`,
`lucide-react` and `cn` stubbed, and hand-written layout CSS for the Tailwind positioning utilities (so geometry/behaviour is
verified, not pixel-accurate styling). Desktop 1280x800, 390x844 and DPR 2.
- Canvas buffer is 2000x1200 (also at DPR 2).
- Pen endpoints match pointer at four zoom/pan combinations and at 390 px width.
- Highlighter: translucent (alpha 89 = 35%), chosen colour saved, self-overlap doesn't darken, committed ink untouched, preview pixels == saved pixels (also at DPR 2), board change mid-stroke keeps both old and new ink, eraser removes highlighter ink, pointer-cancel removes preview and commits nothing, next stroke works.
- Zoom-to-pointer keeps the board point fixed; proportional wheel zoom; limits 0.1x/5x.
- Middle-mouse and Space+drag pan (Space+drag draws nothing; pen works after release); wheel-pan clamping in all four directions.
- Zoom, pan and viewport resize do not change stored element/stroke coordinates.
- Select+drag moves an element by delta/scale at 0.5x, 1x and 2x.
- Text tool: click opens a focused textarea at the click position (zoom 1.5, panned), Enter commits one element at the right board coordinates, and a space can be typed.
- Cost: the real handler's per-move time does not grow with board size (0.1 vs 0.04 ms on empty vs 600-stroke boards; excludes deferred raster). Microbenchmark in this headless Chromium: replaying 600 strokes 7.2 ms vs snapshot blit 1.3 ms per move.
- The same suite against your **original** code: 12 of the then-43 checks failed (highlighter preview alpha, wheel zoom x2.65, no middle/Space pan, Space+drag drawing, unbounded pan), so the checks detect the old defects.

### Executed, library code (`tsx`, not vitest)
- `tsc --strict` on `boardViewport`, `boardLayoutEngine`, `smartPlacement`, `toolSettings`, `whiteboard` (temporary tsconfig): clean.
- New test files run through a small matcher stand-in (NOT vitest): `toolSettings` 9, `boardNavigation` 15, `boardPlacementStrokes` 17, all passing. This shows the logic is right; it is not the vitest suite passing.
- Existing `boardLayoutEngine.test.ts` (19), `smartPlacement.test.ts` (5), `boardViewport.test.ts` (10 of 13) and `whiteboard.test.ts` (20 of 21) give **identical results on the original and the changed libs**. The failures are 3 `measureOcclusion` tests needing jsdom's `document`, and 1 test needing a `toHaveProperty` matcher the stand-in lacks.
- Mutation checks: the ink-avoidance, batch-placement and reflow tests fail against the old behaviour.

### Static only (not executed)
- `SmartBoard.tsx`, `BoardWorkspace.tsx`: TypeScript syntax parse (0 diagnostics) and an undefined-name check with external modules stubbed as `any` (0 findings; a planted error was detected). **No real type-check.**
- `BoardWorkspace.tsx` changes (per-tool settings wiring, `normalizeCoords` batch occupancy, off-screen notice, **Show new content** button, Fit with ink): reviewed, never run. The existing `BoardWorkspace.test.tsx` colour tests were checked by reading, not executed.

## v3 "Not verified" list (see the v4 section for what changed)
- vitest suite (any file), `tsc -b`, oxlint, `vite build`.
- `BoardWorkspace` in a browser, the Show new content button, the AI tool-call flow, Live Voice (untouched).
- Touch, stylus and pinch input; real mobile devices; Safari/Firefox (only Chromium used).
- Existing-element text editing, shape resize/rotate handles, multi-select, undo/redo, save/load round-trip, image/equation insertion: reviewed, not changed, not exercised.
- Toolbar-click leakage onto the canvas (toolbar isn't in the harness).

## Known limitations
- If the viewport and the board are genuinely full, content is placed nearby (possibly off-screen, with the button) or, on a board that is solid ink, at the top-left, overlapping. Stroke occupancy is an approximation (boxes <=80 px, so an 80 px diagonal reserves its bounding square).
- The Show new content button sits at a fixed offset below the toolbar (`top-[4.5rem]`); it was not checked against every toolbar height.
- `planBatchLayout`'s `viewTarget` is still unused. `executeTools` closes over `viewState` and could see a stale view if called from a long-lived Live callback (pre-existing).
- The canvas is a fixed 2000x1200 bitmap, CSS-scaled; at high zoom ink is upscaled (pre-existing).
