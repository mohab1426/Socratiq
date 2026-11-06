# SmartBoard: native (Excalidraw) board, AI drawing pipeline, intelligent placement

Scope: Feature 01 only (student SmartBoard UX, drawing engine, AI drawing quality, AI placement, persistence, tests). Nothing was committed or pushed.

## 1. Audit findings (before this change)

| Area | Finding |
|---|---|
| Engine | Hand-built hybrid canvas + SVG + DOM board (`BoardWorkspace.tsx`, 2.2k lines; `SmartBoard.tsx`). Fixed 2000×1200 stage, not an infinite canvas. |
| Schema | `attempts.whiteboard` JSONB: `steps`, `strokes`, `elements` (kinds text/equation/shape/arrow/line/path/image/simulation), `next_seq`. Strict server model, 200 elements, 400 KB DB `CHECK`. |
| Persistence | Debounced PUT of the **whole** board; the server replaced it from the request body. |
| AI → board (Coach) | Server-side engine writes legacy elements; server placement worked on the 2000×1200 stage only. |
| AI → board (drawing) | `/smartboard/generate-vector` asked Gemini for **raw relative coordinates** of rect/circle/triangle/line/path, un-validated; the client scaled them into a box near the viewport. No semantics, no schema, no collision logic. **This is why drawings looked random.** |
| Placement | `smartPlacement.ts`: nearest free cell by element rectangles; no text metrics, no stroke geometry, no semantic anchor. |
| Compatibility | `@excalidraw/excalidraw@0.18.1` declares React 19 peers and, in a spike, type-checked, bundled under Vite 8 / TS 6 and ran its element factories under vitest. **No technical blocker.** |
| Hidden dependency | Excalidraw loads fonts from `https://esm.sh` unless `EXCALIDRAW_ASSET_PATH` is set. Fixed by self-hosting (below). |

## 2. Decision: official Excalidraw, strangler-style

* The drawing foundation is the **official** `@excalidraw/excalidraw` (all tools, properties panel, infinite canvas, zoom/pan, undo/redo, groups, images, shortcuts come from the engine).
* SocratiQ adds: save status, fit/reset view, AI draw bar, Coach intents, authorship, placement, persistence, migration.
* The legacy board is **kept** (not deleted): it remains the fallback (`VITE_SMARTBOARD_ENGINE=legacy`), and its data stays on the server untouched.
* The engine is **lazy-loaded** (~1.1 MB gzip in separate chunks; the 283 KB-gzip entry bundle contains none of it).

## 3. Architecture

```
student request ─▶ POST /smartboard/generate-diagram          (server: Gemini JSON mode)
                    ├─ pydantic DiagramSpec (strict, no coordinates)
                    ├─ semantic rules per diagram type
                    └─ 1 repair round with the rejection reasons, then 422
                ─▶ client parseDiagramSpec + checkSemantics     (same contract, defence in depth)
                ─▶ layoutDiagram        deterministic layout     diagramLayout.ts
                ─▶ resolveAnchor + ObstacleIndex + findPlacement placement.ts / anchor.ts / obstacles.ts
                ─▶ layoutToNative       native Excalidraw elements toNative.ts
                ─▶ validateInsertion    on the REAL elements      insertAi.ts
                ─▶ updateScene(CaptureUpdateAction.IMMEDIATELY)   one atomic, one-undo insertion
```

Files (`frontend/src/lib/smartboard/`): `types`, `meta`, `geometry`, `obstacles`, `diagramSpec`, `diagramLayout`, `style`, `placement`, `anchor`, `toNative`, `insertAi`, `scene`, `legacy`, `coachInsert`, `autosave`, `glue`. UI: `components/smartboard/` (`SmartBoardWorkspace`, `BoardSurface`, `SceneViewer`, `assetPath`).
Backend: `ai/whiteboard/diagram.py`, `ai/whiteboard/scene.py`, `database/migrations/016_whiteboard_scene.sql`, route/schema/view/digest changes.

### Diagram types (7)
flowchart (layered/Sugiyama-style with virtual nodes for long edges and feedback edges), cycle (ring), hierarchy (tidy tree), concept map (radial), steps/equations, comparison (columns), labelled illustration (figure drawn in a private 0..100 frame from ellipse/rectangle/diamond/polygon/line/**freehand**/arrow parts, with non-crossing leader callouts). Freehand parts are Catmull-Rom smoothed into real `freedraw` elements.

### The LLM never places anything
The spec has no canvas coordinates for nodes (rejected as unknown fields). The only numbers are inside illustration parts, in a private 0..100 sheet.

## 4. Intelligent placement (deterministic)

* **Board analysis:** `ObstacleIndex` (uniform grid) over **all** live elements, not just the viewport. Open lines/arrows/strokes use segment-accurate collision (a long diagonal arrow does not wall off the canvas); closed loops, polygons, filled shapes, images, text and boxes use conservative bounding boxes; rotation is honoured; labels bound to boxes are covered by the box, labels bound to arrows are kept.
* **Semantic anchor:** selection (confidence 1) > element named by the model (validated against the real board) > lexical relevance of the request vs clustered board text (Unicode/Arabic-normalised) > deictic "this/هذا" → most recently edited student content > none (independent diagram).
* **Candidates:** around the anchor (4 sides × 3 gaps × alignments), a grid over the visible viewport, expanding rings around the anchor/viewport/content, and "extend the workspace" positions beyond all content (collision-free by construction).
* **Hard rejection:** any candidate colliding with protected content at the required clearance is **rejected, never penalised**.
* **Scoring (survivors only):** distance to anchor (weighted by confidence), reading direction (below, then LTR-right / RTL-left), alignment, viewport visibility, breathing-room tiers, soft penalty for sitting inside someone's group box, content-centroid pull.
* **Post-generation validation on the real elements:** no covering of text/shapes/images, no arrow crossing existing content, arrows may bind only to new elements (binding to an existing element would modify it), readable font ≥ 14, labels fit their shapes, no overlaps inside the group, coordinates bounded. On failure: next candidate (bounded), then re-plan with the real extent (≤ 3 passes), then **reject with diagnostics**. Nothing is ever forced in.
* **Additive only:** the result array contains every pre-existing element as the *same object reference*; tests assert identity and byte-equality.
* **No space / crowded:** nearby whitespace → viewport → extend beyond content → the student is scrolled to the new group (`scrollToContent`) when it is outside the view.
* **Idempotent:** one `opId` per request; a retry that reuses it inserts nothing. Group id `ai-group-<opId>`.

## 5. Authorship and groups

`customData.socratiq = { v, author: student|ai|coach, opId?, role?, legacyId?, originalAuthor? }` (Excalidraw's own `customData` extension point; no invented properties). Every element of one AI operation, including bound labels (the converter does not copy these, so it is done explicitly), carries `groupIds: [ai-group-<opId>]`. Student groups are never touched or joined. Editing Coach text turns it into student content with provenance (mirrors the legacy rule).

Server trust: `author:"coach"` in a scene is honoured only if its `legacyId` is a coach element the **server** wrote; otherwise it is stored as `student`. `author:"ai"` is advisory display metadata and is never used as evidence about the student's work: the Coach's digest excludes AI and Coach text.

## 6. Persistence and migration

* Stored under `whiteboard.scene` using Excalidraw's own `serializeAsJSON` (+ viewport). Not a screenshot.
* **A scene save changes only `scene`.** Legacy `steps/strokes/elements` stay exactly as stored. A legacy client's save preserves an existing scene. Once a scene exists it is the source of truth for the student's work (the Coach digest stops reading the stale legacy copy).
* **Legacy → native** (`legacy.ts`): deterministic, non-destructive, stable ids `legacy-<id>`, 1:1 coordinates, arrows re-bound, strokes → `freedraw`, highlighter translucent, eraser strokes applied geometrically (strokes are split, segment-aware), typed steps → text, images → image elements + files, coach authorship kept. Interactive simulations become placeholders (reported to the student). The scene is only written on the first save after the upgrade; until then the server still holds the original board.
* Coach writes server-side in the legacy format; those elements are converted and **relocated as one group through the same placement engine** so they cannot land on the student's newer work.
* **Server hardening** (`scene.py`): known element types only (embeddable/iframe dropped), bounded numbers/points/elements/text, `javascript:`/`data:` links neutralised, only png/jpeg/gif/webp data URLs, orphaned images dropped, `appState` whitelist, 2.5 MB cap.
* **Migration 016:** raises the DB `CHECK` from 400 000 to 3 500 000 bytes (idempotent, no data change). The API enforces the smaller limits.
* **Autosave** (`autosave.ts`): debounce 1.5 s with a 10 s max wait, one save in flight, an edit during a save causes exactly one follow-up save, transient failures retry with backoff, permanent failures (413/422/403/404/409) stop and explain, "Retry now", `beforeunload` guard, flush on tab hide, large images re-encoded **for storage only**.

## 7. Tests (what was actually executed)

| Suite | Result |
|---|---|
| `tsc -b` | clean |
| `oxlint` | 0 errors, 45 warnings (baseline 44; +1 is a React-Compiler false positive on a ref read inside an async callback) |
| Full frontend vitest | **35 files, 632 tests, all pass** (463 pre-existing + 169 new) |
| ↳ `SmartBoardWorkspace.test.tsx` | 14/14: **real Excalidraw in jsdom**: AI drawing end-to-end → autosaved scene, legacy upgrade then AI insertion with student content byte-identical, Coach placement, reopen/restore, remove-group, failed-save + retry, lock while Coach writes, read-only, intent menu |
| ↳ `aiPlacement.test.ts` | 25/25: the 12 required scenarios (empty board, paragraph, shapes, freehand, several AI groups, images, crowded viewport, boxed-in anchor, long text, large diagram, 5 zoom levels, off-viewport) + selection/RTL/determinism/deleted/no-viewport + performance |
| ↳ `insertAi` 33, `scene` 21, `diagramLayout` 24, `diagramSpec` 17, `geometry` 14, `autosave` 12, `glue` 5, `coachInsert` 4 | all pass |
| Backend full (`backend/ database/ ai/`) | **490 passed, 271 skipped** (skips = tests needing PostgreSQL) |
| ↳ `test_smartboard_scene.py` | 27 tests (42 cases), DB-free: sanitiser, forged-coach, digest, diagram contract, endpoint with mocked model (repair loop, hallucinated target stripped) |

Performance (measured): index of 5 000 elements 26 ms (2 000 queries 38 ms); full AI pipeline on boards of 50 / 500 / 3 000 elements: 6 / 66 / 159 ms.

Mutation checks (tests have teeth): disabling collision rejection fails 15 tests; disabling embed filtering and the coach-forgery rule fails 3 tests; both restored.

## 8. Known limitations / things NOT verified

1. **No real browser was available** (Playwright's CDN is blocked here). Not exercised: real pointer/touch drawing, Excalidraw's own rendering, the **Ctrl+Z one-step undo** (insertion is built as a single `CaptureUpdateAction.IMMEDIATELY` update, which is the engine's mechanism, but it was not run in a browser), real font metrics (tests use a fixed 0.6 em canvas stub; layout uses a conservative 0.62 em estimate plus a real-geometry re-plan, which is untested with real Excalifont/Arabic fonts). **No before/after screenshots exist.**
2. **PostgreSQL was not available.** Migration 016 is covered by a static test only; the 13 DB-backed integration tests in `test_whiteboard_scene_db.py` and the 271 pre-existing DB tests were **not executed**.
3. `AiCoach.test.tsx` (11 tests) drives the legacy board's DOM, so it is **pinned to the legacy engine** via the fallback flag. It still verifies engine-independent page logic; the equivalent native behaviour is covered by `SmartBoardWorkspace.test.tsx`, not by those tests.
4. Not ported from the legacy workspace: its own Gemini chat dock with RAG sources and Live voice (the Coach chat on the AiCoach page is unchanged), interactive simulations (placeholders), KaTeX rendering (equations are plain Unicode text), `/generate-vector`.
5. AI drawing: 7 diagram types (no timeline); the AI cannot connect arrows to existing student shapes (that would modify them); no "tether" arrow from the new group to its anchor.
6. `/smartboard/generate-diagram` is unauthenticated like the existing SmartBoard endpoints (cost-abuse risk, pre-existing pattern); no rate limit was added.
7. Eraser migration is geometric and approximate; closed strokes are treated conservatively as filled (placement never goes inside a student's loop).
8. `npm install` now copies ~14 MB of Excalidraw fonts into `public/excalidraw-assets/` (gitignored; `postinstall`/`predev`/`prebuild`). CI must run `npm install`/`npm ci` or the build script.
9. AI authorship is client-claimed metadata (advisory); only Coach authorship is server-verified.

## 9. Remaining risks

* Excalidraw major upgrades may change `customData`/index/binding semantics: pinned to `^0.18.1`; the real-engine tests are the early-warning system.
* Boards with many large images approach the 2.5 MB scene cap; the UI reports it and stops retrying.
* Bundle: +~1.1 MB gzip on first board open (lazy).
